import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildStructuralOverview,
  parseImports,
  parseMethodSymbols,
  parseModuleDoc,
  parseTopLevelSymbols
} from '../src/overview';

const SAMPLE = `//! The loop: call, act, observe.
//!
//! More detail.

use crate::client::{Client, Error as ClientError};
use crate::context::{self, ContextPolicy};
use serde::{Deserialize, Serialize};

pub struct Limits {
    pub max_turns: u32,
}

impl Default for Limits {
    fn default() -> Self { Self { max_turns: 8 } }
}

pub enum Decision {
    Act,
    Answer,
}

pub async fn run(client: &Client) -> Result<(), Error> {
    let _ = client;
    Ok(())
}
`;

test('builds module docs, top-level constructs and imports', () => {
  const overview = buildStructuralOverview({
    file: 'src/agent.rs',
    text: SAMPLE,
    modulePath: 'crate::agent',
    crateName: 'harness'
  });

  assert.equal(overview.modulePath, 'crate::agent');
  assert.match(overview.moduleDoc || '', /The loop: call, act, observe/);
  assert.equal(overview.summary, 'The loop: call, act, observe.');
  assert.deepEqual(
    overview.keyConstructs.map((symbol) => symbol.name),
    ['Limits', 'Decision', 'run']
  );

  const limits = overview.keyConstructs[0];
  assert.equal(limits.start, 9);
  assert.equal(limits.end, 11);

  const clientImport = overview.imports.find((item) => item.path === 'crate::client');
  assert.equal(clientImport?.external, false);
  assert.deepEqual(clientImport?.symbols, ['Client', 'Error as ClientError']);

  const serdeImport = overview.imports.find((item) => item.path === 'serde');
  assert.equal(serdeImport?.external, true);
  assert.deepEqual(serdeImport?.symbols, ['Deserialize', 'Serialize']);
});

test('falls back to a structural summary when there are no module docs', () => {
  const overview = buildStructuralOverview({
    file: 'src/util.rs',
    text: 'pub fn helper() {}\n'
  });

  assert.equal(overview.summary, 'util.rs: 1 function');
  assert.deepEqual(
    overview.keyConstructs.map((symbol) => symbol.name),
    ['helper']
  );
});

test('keeps top-level declarations and ignores indented impl methods', () => {
  const symbols = parseTopLevelSymbols(SAMPLE);
  assert.deepEqual(
    symbols.map((symbol) => `${symbol.kind}:${symbol.name}`),
    ['struct:Limits', 'impl:impl Default for Limits {', 'enum:Decision', 'fn:run']
  );
});

test('captures impl methods with qualified names', () => {
  const methods = parseMethodSymbols(`pub struct Limits {
    pub max: u32,
}

impl Limits {
    pub fn spent_usd(&self) -> u32 { self.max }
    pub fn plus(self, other: Self) -> Self { self }
}
`);

  assert.deepEqual(
    methods.map((method) => `${method.name}:${method.start}-${method.end}`),
    ['Limits::spent_usd:6-6', 'Limits::plus:7-7']
  );
});

test('captures a multi-line function signature up to the body', () => {
  const symbols = parseTopLevelSymbols(`pub async fn run(
    client: &Client,
) -> Result<(), Error> {
    Ok(())
}
`);

  assert.equal(symbols.length, 1);
  assert.equal(
    symbols[0].signature,
    'pub async fn run( client: &Client, ) -> Result<(), Error>'
  );
});

test('expands grouped use trees into readable paths', () => {
  const imports = parseImports(
    `use std::{fmt, io};
use crate::{agent, client};
use crate::foo::{bar, baz};
`,
    'harness'
  );

  assert.deepEqual(
    imports.map((item) => item.path),
    ['crate::agent', 'crate::client', 'crate::foo', 'std::fmt', 'std::io']
  );
  assert.equal(imports.find((item) => item.path === 'crate::foo')?.symbols?.length, 2);
});

test('splits a single imported type from its module path', () => {
  const imports = parseImports(
    `use crate::config::Prices;
use serde::Deserialize;
use std::fmt;
`,
    'harness'
  );

  assert.deepEqual(
    imports.map((item) => ({
      path: item.path,
      symbols: item.symbols,
      external: item.external
    })),
    [
      { path: 'crate::config', symbols: ['Prices'], external: false },
      { path: 'serde', symbols: ['Deserialize'], external: true },
      { path: 'std::fmt', symbols: undefined, external: true }
    ]
  );
});

test('reads only a leading module doc block', () => {
  assert.equal(parseModuleDoc('//! One.\n//! Two.\n\nuse std::fmt;\n'), 'One.\nTwo.');
  assert.equal(parseModuleDoc('// Copyright\n//! Docs.\n\nuse std::fmt;\n'), 'Docs.');
  assert.equal(parseModuleDoc('use std::fmt;\n'), undefined);
});
