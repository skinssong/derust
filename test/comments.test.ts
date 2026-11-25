import assert from 'node:assert/strict';
import test from 'node:test';
import { buildUserPrompt } from '../src/analyzer';
import { buildBriefUserPrompt } from '../src/brief';
import { blankComments } from '../src/comments';
import { StructuralOverview } from '../src/contract';

const SAMPLE = [
  '//! Module header.',
  '/// Doc line',
  'pub fn run(url: &str) -> String {',
  '    // inline comment',
  '    let a = "http://example.com"; // tail',
  '    /* block /* nested */ still block */',
  '    let raw = r#"a // b"#;',
  "    let ch = '/';",
  "    let life: &'static str = \"//\";",
  '    a.to_string()',
  '}'
].join('\n');

test('comments are blanked without moving lines or corrupting strings', () => {
  const output = blankComments(SAMPLE);
  assert.equal(output.split('\n').length, SAMPLE.split('\n').length);
  assert.equal(output.length, SAMPLE.length);
  assert.ok(!output.includes('Module header'));
  assert.ok(!output.includes('inline comment'));
  assert.ok(!output.includes('tail'));
  assert.ok(!output.includes('block'));
  assert.ok(output.includes('"http://example.com"'));
  assert.ok(output.includes('r#"a // b"#'));
  assert.ok(output.includes("let ch = '/';"));
  assert.ok(output.includes("&'static str"));
  assert.ok(output.includes('a.to_string()'));
});

test('nested block comments keep their newlines', () => {
  const input = 'let x = 1; /* one\n two */ let y = 2;';
  const output = blankComments(input);
  const inputLines = input.split('\n');
  const outputLines = output.split('\n');
  assert.equal(outputLines.length, inputLines.length);
  assert.ok(outputLines[0].startsWith('let x = 1;'));
  assert.ok(outputLines[1].endsWith('let y = 2;'));
  assert.ok(!output.includes('one'));
  assert.ok(!output.includes('two'));
});

const OVERVIEW: StructuralOverview = {
  file: 'src/a.rs',
  modulePath: 'crate::a',
  crateName: 'demo',
  lineCount: SAMPLE.split('\n').length,
  moduleDoc: 'The module header.',
  summary: '',
  symbols: [],
  keyConstructs: [],
  functions: [],
  imports: [],
  usedBy: []
};

test('analysis prompt never carries comment text and keeps line numbers', () => {
  const prompt = buildUserPrompt(SAMPLE, { file: 'src/a.rs', crateName: 'demo', model: 'm' });
  assert.ok(!prompt.includes('Module header'));
  assert.ok(!prompt.includes('inline comment'));
  assert.ok(prompt.includes('"http://example.com"'));
  assert.ok(prompt.includes(`Lines: ${SAMPLE.split('\n').length}`));
});

test('brief prompt drops module docs and blanked comments', () => {
  const prompt = buildBriefUserPrompt(SAMPLE, {
    file: 'src/a.rs',
    crateName: 'demo',
    model: 'm',
    sourceHash: 'hash',
    overview: OVERVIEW
  });
  assert.ok(!prompt.includes('MODULE DOCS'));
  assert.ok(!prompt.includes('The module header.'));
  assert.ok(!prompt.includes('Doc line'));
  assert.ok(!prompt.includes('inline comment'));
  assert.ok(prompt.includes('a.to_string()'));
});
