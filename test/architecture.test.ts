import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildArchitecture,
  classifyOccurrence,
  componentIdFor,
  countCodeLines,
  isDefinitionLine,
  isModuleWiring,
  isUseLine,
  useLineSet
} from '../src/architecture';

test('component is the top-level module under src/', () => {
  assert.equal(componentIdFor('src/main.rs'), 'main');
  assert.equal(componentIdFor('src/agent.rs'), 'agent');
  assert.equal(componentIdFor('src/tools/bash.rs'), 'tools');
  assert.equal(componentIdFor('tests/agent.rs'), undefined);
  assert.equal(componentIdFor('build.rs'), undefined);
});

test('use lines are excluded before occurrences are built', () => {
  assert.equal(isUseLine('use crate::log::Log;'), true);
  assert.equal(isUseLine('    pub use crate::tool::Tool;'), true);
  assert.equal(isUseLine('    let log = Log::create(&dir)?;'), false);
});

test('declaration lines are not usages', () => {
  assert.equal(isDefinitionLine('fn', '    pub async fn run(client: &Client) {', 'run'), true);
  assert.equal(isDefinitionLine('struct', 'pub struct Limits {', 'Limits'), true);
  assert.equal(isDefinitionLine('fn', '    let ending = agent::run(&client)?;', 'run'), false);
  assert.equal(isDefinitionLine('struct', '    let limits = Limits::default();', 'Limits'), false);
});

test('occurrence kind follows the line, not the declaration', () => {
  assert.equal(classifyOccurrence('fn', '    recorder.record(event);', 'record'), 'call');
  assert.equal(classifyOccurrence('fn', '    let sink = record;', 'record'), 'reference');
  assert.equal(classifyOccurrence('struct', '    let error: LogError = err;', 'LogError'), 'type use');
  assert.equal(classifyOccurrence('trait', 'impl Tool for ReadFile {', 'Tool'), 'impl');
});

test('architecture groups modules into components and edges from usages', () => {
  const sources: Record<string, string[]> = {
    'src/main.rs': ['fn main() {', '    let log = Log::create();', '}'],
    'src/log.rs': ['pub struct Log;', 'impl Log {', '    pub fn create() -> Self { Log }', '}']
  };
  const model = buildArchitecture({
    revision: 'r1',
    crate: 'demo',
    root: '/demo',
    sources,
    symbols: [
      {
        file: 'src/log.rs',
        name: 'Log',
        kind: 'struct',
        start: 1,
        end: 1,
        occurrences: [
          { file: 'src/log.rs', line: 3, kind: 'type use' },
          { file: 'src/main.rs', line: 2, kind: 'type use' }
        ]
      },
      {
        file: 'src/log.rs',
        name: 'Log::create',
        kind: 'fn',
        start: 3,
        end: 3,
        occurrences: [{ file: 'src/main.rs', line: 2, kind: 'call', caller: 'main' }]
      }
    ]
  });

  assert.deepEqual(
    model.nodes.map((node) => node.id).sort(),
    ['log', 'main']
  );
  const edge = model.edges.find((item) => item.source === 'main' && item.target === 'log');
  assert.ok(edge, 'main calls and uses log');
  assert.equal(edge!.kinds.calls, 1);
  assert.equal(edge!.kinds.uses, 1);
  assert.equal(edge!.occurrences[0].kind, 'call');
  assert.equal(edge!.occurrences[0].label, 'main → Log::create');
  const main = model.nodes.find((node) => node.id === 'main')!;
  assert.equal(main.dependencies, 2);
  assert.equal(main.callSites, 1);
  // Same-component usages stay on the node but never become an edge.
  assert.equal(
    model.edges.some((item) => item.source === item.target),
    false
  );
});



test('code lines exclude comments, doc comments and nested blocks', () => {
  assert.equal(
    countCodeLines([
      '// comment',
      'let a = 1; // tail',
      '',
      '/* block',
      'still block',
      '*/',
      '/* outer /* inner */ still outer */ let b = 2;',
      'fn main() {',
      '}'
    ]),
    4
  );
});

test('module role: data, behavior or mixed from foreign type parameters', () => {
  const sources: Record<string, string[]> = {
    'src/message.rs': [
      'pub struct Message {',
      '    pub text: String,',
      '}',
      'impl Message {',
      '    pub fn new(text: String) -> Self { Self { text } }',
      '}'
    ],
    'src/agent.rs': ['pub fn run(input: Message) {', '    let _ = input;', '}'],
    'src/mixed.rs': ['pub struct State;', 'pub fn handle(state: &State, input: Message) {}']
  };
  const model = buildArchitecture({
    revision: 'r',
    crate: 'demo',
    root: '/demo',
    sources,
    symbols: [
      { file: 'src/message.rs', name: 'Message', kind: 'struct', start: 1, end: 3, occurrences: [] },
      {
        file: 'src/message.rs',
        name: 'Message::new',
        kind: 'fn',
        start: 5,
        end: 5,
        signature: 'pub fn new(text: String) -> Self',
        occurrences: []
      },
      {
        file: 'src/agent.rs',
        name: 'run',
        kind: 'fn',
        start: 1,
        end: 1,
        signature: 'pub fn run(input: Message)',
        occurrences: []
      },
      { file: 'src/mixed.rs', name: 'State', kind: 'struct', start: 1, end: 1, occurrences: [] },
      {
        file: 'src/mixed.rs',
        name: 'handle',
        kind: 'fn',
        start: 2,
        end: 2,
        signature: 'pub fn handle(state: &State, input: Message)',
        occurrences: []
      }
    ]
  });
  const roles = Object.fromEntries(model.nodes.map((node) => [node.id, node.role]));
  assert.equal(roles.message, 'data');
  assert.equal(roles.agent, 'behavior');
  assert.equal(roles.mixed, 'mixed');
  const message = model.nodes.find((node) => node.id === 'message')!;
  assert.equal(message.codeLines, 6);
});

test('implementing a foreign trait makes a type module mixed', () => {
  const sources: Record<string, string[]> = {
    'src/tool.rs': ['pub trait Tool {', '    fn name(&self) -> &str;', '}'],
    'src/tools.rs': ['pub struct Run;', 'impl Tool for Run {', '    fn name(&self) -> &str { "run" }', '}']
  };
  const model = buildArchitecture({
    revision: 'r',
    crate: 'demo',
    root: '/demo',
    sources,
    symbols: [
      { file: 'src/tool.rs', name: 'Tool', kind: 'trait', start: 1, end: 3, occurrences: [] },
      { file: 'src/tools.rs', name: 'Run', kind: 'struct', start: 1, end: 1, occurrences: [] }
    ]
  });
  const tools = model.nodes.find((node) => node.id === 'tools')!;
  assert.equal(tools.role, 'mixed');
});

test('a type module that calls into another module is mixed', () => {
  const sources: Record<string, string[]> = {
    'src/a.rs': ['pub struct A;', 'pub fn build() { B::make(); }'],
    'src/b.rs': ['pub fn make() {}']
  };
  const model = buildArchitecture({
    revision: 'r',
    crate: 'demo',
    root: '/demo',
    sources,
    symbols: [
      { file: 'src/a.rs', name: 'A', kind: 'struct', start: 1, end: 1, occurrences: [] },
      {
        file: 'src/b.rs',
        name: 'make',
        kind: 'fn',
        start: 1,
        end: 1,
        occurrences: [{ file: 'src/a.rs', line: 2, kind: 'call' }]
      }
    ]
  });
  const a = model.nodes.find((node) => node.id === 'a')!;
  assert.equal(a.role, 'mixed');
  assert.equal(a.callSites, 1);
});

test('constructors count as type uses, not calls', () => {
  const sources: Record<string, string[]> = {
    'src/tool.rs': [
      'pub struct Observation;',
      'impl Observation {',
      '    pub fn ok() -> Observation { Observation }',
      '    pub fn make() -> Result<Self, ()> { Ok(Observation) }',
      '}'
    ],
    'src/tools.rs': ['pub fn run() {', '    Observation::ok();', '    Observation::make();', '}']
  };
  const model = buildArchitecture({
    revision: 'r',
    crate: 'demo',
    root: '/demo',
    sources,
    symbols: [
      { file: 'src/tool.rs', name: 'Observation', kind: 'struct', start: 1, end: 1, occurrences: [] },
      {
        file: 'src/tool.rs',
        name: 'Observation::ok',
        kind: 'fn',
        start: 3,
        end: 3,
        signature: 'pub fn ok() -> Observation',
        occurrences: [{ file: 'src/tools.rs', line: 2, kind: 'call' }]
      },
      {
        file: 'src/tool.rs',
        name: 'Observation::make',
        kind: 'fn',
        start: 4,
        end: 4,
        signature: 'pub fn make() -> Result<Self, ()>',
        occurrences: [{ file: 'src/tools.rs', line: 3, kind: 'call' }]
      }
    ]
  });
  const edge = model.edges.find((item) => item.source === 'tools' && item.target === 'tool')!;
  assert.equal(edge.kinds.calls, undefined);
  assert.equal(edge.kinds.uses, 2);
  assert.deepEqual(
    edge.occurrences.map((item) => [item.kind, item.label]),
    [
      ['type use', 'Observation'],
      ['type use', 'Observation']
    ]
  );
});

test('functions returning a foreign type remain calls', () => {
  const sources: Record<string, string[]> = {
    'src/thing.rs': ['pub struct Thing;'],
    'src/build.rs': ['pub fn build() -> Thing { Thing }'],
    'src/use_it.rs': ['pub fn use_it() {', '    build();', '}']
  };
  const model = buildArchitecture({
    revision: 'r',
    crate: 'demo',
    root: '/demo',
    sources,
    symbols: [
      { file: 'src/thing.rs', name: 'Thing', kind: 'struct', start: 1, end: 1, occurrences: [] },
      {
        file: 'src/build.rs',
        name: 'build',
        kind: 'fn',
        start: 1,
        end: 1,
        signature: 'pub fn build() -> Thing',
        occurrences: [{ file: 'src/use_it.rs', line: 2, kind: 'call' }]
      }
    ]
  });
  const edge = model.edges.find((item) => item.source === 'use_it' && item.target === 'build')!;
  assert.equal(edge.kinds.calls, 1);
  assert.equal(edge.occurrences[0].kind, 'call');
  assert.equal(edge.occurrences[0].label, 'build');
});

test('module wiring: declarations, attributes and multi-line uses only', () => {
  assert.equal(
    isModuleWiring([
      '//! Crate root.',
      '',
      '#![allow(dead_code)]',
      '#[cfg(all(',
      '    feature = "tools"',
      '))]',
      'pub mod agent;',
      'pub(crate) mod tools;',
      'pub use crate::agent::run;',
      'use crate::client::{',
      '    Client,',
      '    Error,',
      '};'
    ]),
    true
  );
  assert.equal(isModuleWiring(['pub fn init() {}']), false);
  assert.equal(isModuleWiring(['mod inline {', '    pub fn x() {}', '}']), false);
  assert.equal(isModuleWiring(['pub struct Config;']), false);
});

test('an orphan wiring module is dropped from the diagram', () => {
  const sources: Record<string, string[]> = {
    'src/lib.rs': ['//! Wiring.', 'pub mod a;', 'pub mod b;', 'pub use crate::a::A;'],
    'src/a.rs': ['pub struct A;'],
    'src/b.rs': ['pub fn use_a(input: A) {', '    let _ = input;', '}']
  };
  const model = buildArchitecture({
    revision: 'r',
    crate: 'demo',
    root: '/demo',
    sources,
    symbols: [
      { file: 'src/a.rs', name: 'A', kind: 'struct', start: 1, end: 1, occurrences: [] },
      {
        file: 'src/b.rs',
        name: 'use_a',
        kind: 'fn',
        start: 1,
        end: 1,
        signature: 'pub fn use_a(input: A)',
        occurrences: [
          { file: 'src/b.rs', line: 1, kind: 'type use' },
          { file: 'src/a.rs', line: 1, kind: 'type use' }
        ]
      }
    ]
  });
  const ids = model.nodes.map((node) => node.id);
  assert.deepEqual(ids, ['a', 'b']);
});

test('a lib module with real code stays', () => {
  const model = buildArchitecture({
    revision: 'r',
    crate: 'demo',
    root: '/demo',
    sources: { 'src/lib.rs': ['pub fn init() {}'], 'src/a.rs': ['pub struct A;'] },
    symbols: [{ file: 'src/a.rs', name: 'A', kind: 'struct', start: 1, end: 1, occurrences: [] }]
  });
  assert.ok(model.nodes.some((node) => node.id === 'lib'));
});

test('use lines include continuation lines of a multi-line import', () => {
  const set = useLineSet([
    'use crate::agent::{',
    '    run,',
    '    Approval,',
    '};',
    'let x = Approval::default();'
  ]);
  assert.deepEqual([...set].sort((left, right) => left - right), [1, 2, 3, 4]);
});



test('project brief: purpose, reading order, docs and carriers', () => {
  const sources: Record<string, string[]> = {
    'src/lib.rs': ['//! Demo crate purpose.', '', 'pub mod a;', 'pub mod b;', 'pub mod c;', 'pub mod d;'],
    'src/main.rs': ['pub fn main() {', '    gamma();', '}'],
    'src/a.rs': ['//! The alpha module.', 'pub struct A;', 'pub struct E;'],
    'src/b.rs': ['//! Beta uses alpha.', 'pub fn beta(input: A, extra: E) {}'],
    'src/c.rs': ['//! Gamma calls beta.', 'pub fn gamma(thing: E) {', '    beta(A, E);', '}'],
    'src/d.rs': ['pub fn delta(item: E) {}']
  };
  const symbols = [
    { file: 'src/a.rs', name: 'A', kind: 'struct', start: 2, end: 2, occurrences: [
      { file: 'src/b.rs', line: 2, kind: 'type use' as const },
      { file: 'src/c.rs', line: 2, kind: 'type use' as const }
    ] },
    { file: 'src/a.rs', name: 'E', kind: 'struct', start: 3, end: 3, occurrences: [
      { file: 'src/b.rs', line: 2, kind: 'type use' as const },
      { file: 'src/c.rs', line: 2, kind: 'type use' as const },
      { file: 'src/d.rs', line: 1, kind: 'type use' as const }
    ] },
    { file: 'src/b.rs', name: 'beta', kind: 'fn', start: 2, end: 2, signature: 'pub fn beta(input: A, extra: E)', occurrences: [
      { file: 'src/c.rs', line: 3, kind: 'call' as const }
    ] },
    { file: 'src/c.rs', name: 'gamma', kind: 'fn', start: 2, end: 2, signature: 'pub fn gamma(thing: E)', occurrences: [
      { file: 'src/main.rs', line: 2, kind: 'call' as const }
    ] },
    { file: 'src/main.rs', name: 'main', kind: 'fn', start: 1, end: 1, signature: 'pub fn main()', occurrences: [] }
  ];
  const model = buildArchitecture({
    revision: 'r',
    crate: 'demo',
    root: '/demo',
    sources,
    symbols
  });
  const brief = model.brief;
  assert.ok(brief.overview.what.includes('demo'));
  assert.ok(brief.overview.what.includes('binary'));
  assert.ok(brief.overview.flow.includes('main → c'));
  assert.ok(brief.overview.flow.includes('c → b'));
  assert.ok(brief.overview.map.includes('components'));
  assert.equal(brief.startHere[0].id, 'main');
  assert.deepEqual(brief.startHere.slice(0, 3).map((item) => item.id), ['main', 'c', 'b']);
  const alpha = brief.modules.find((item) => item.id === 'a')!.description;
  assert.ok(/types .*A/.test(alpha));
  assert.ok(!alpha.includes('alpha module'), 'comments must not feed the description');
  assert.ok(brief.carriers.some((carrier) => carrier.name === 'E' && carrier.users.length === 3));
  assert.ok(brief.notes.some((note) => note.includes('carrier-only')));
  const b = model.nodes.find((node) => node.id === 'b')!;
  assert.equal(b.incomingCalls, 1);
  assert.equal(b.incomingComponents, 1);
});

test('returning an own type with foreign inputs stays a call', () => {
  const sources: Record<string, string[]> = {
    'src/request.rs': ['pub struct Request;'],
    'src/agent.rs': ['pub struct Ending;', 'pub fn run(request: Request) -> Ending { Ending }'],
    'src/main.rs': ['pub fn main() {', '    run(Request);', '}']
  };
  const model = buildArchitecture({
    revision: 'r',
    crate: 'demo',
    root: '/demo',
    sources,
    symbols: [
      { file: 'src/request.rs', name: 'Request', kind: 'struct', start: 1, end: 1, occurrences: [] },
      { file: 'src/agent.rs', name: 'Ending', kind: 'struct', start: 1, end: 1, occurrences: [] },
      {
        file: 'src/agent.rs',
        name: 'run',
        kind: 'fn',
        start: 2,
        end: 2,
        signature: 'pub fn run(request: Request) -> Ending',
        occurrences: [{ file: 'src/main.rs', line: 2, kind: 'call' }]
      }
    ]
  });
  const edge = model.edges.find((item) => item.source === 'main' && item.target === 'agent')!;
  assert.equal(edge.kinds.calls, 1);
  assert.equal(edge.occurrences[0].kind, 'call');
});

test('brief stays legible when files carry no comments', () => {
  const model = buildArchitecture({
    revision: 'r',
    crate: 'demo',
    root: '/demo',
    sources: {
      'src/main.rs': ['pub fn main() {}'],
      'src/a.rs': ['pub struct A;', 'pub fn build(input: A) -> A { input }'],
      'src/b.rs': ['pub fn use_it() { build(A); }']
    },
    symbols: [
      { file: 'src/main.rs', name: 'main', kind: 'fn', start: 1, end: 1, signature: 'pub fn main()', occurrences: [] },
      { file: 'src/a.rs', name: 'A', kind: 'struct', start: 1, end: 1, occurrences: [] },
      {
        file: 'src/a.rs',
        name: 'build',
        kind: 'fn',
        start: 2,
        end: 2,
        signature: 'pub fn build(input: A) -> A',
        occurrences: [{ file: 'src/b.rs', line: 1, kind: 'call' }]
      }
    ]
  });
  const brief = model.brief;
  assert.ok(brief.overview.what.includes('demo'));
  assert.ok(brief.overview.what.includes('binary'));
  const a = brief.modules.find((module) => module.id === 'a')!;
  assert.ok(a.description.includes('types A'));
  assert.ok(a.description.includes('lines'));
});

test('overview names the technology from Cargo dependencies', () => {
  const model = buildArchitecture({
    revision: 'r',
    crate: 'demo',
    root: '/demo',
    sources: { 'src/main.rs': ['pub fn main() {}'] },
    symbols: [
      { file: 'src/main.rs', name: 'main', kind: 'fn', start: 1, end: 1, signature: 'pub fn main()', occurrences: [] }
    ],
    dependencies: ['tokio', 'reqwest', 'serde']
  });
  const overview = model.brief.overview;
  assert.ok(overview.what.includes('async'));
  assert.ok(overview.technology.includes('tokio (async runtime)'));
  assert.ok(overview.technology.includes('reqwest (HTTP client)'));
});

test('entry point is detected from a private fn main', () => {
  const model = buildArchitecture({
    revision: 'r',
    crate: 'demo',
    root: '/demo',
    sources: {
      'src/main.rs': ['fn main() {', '    let _ = 1;', '}'],
      'src/a.rs': ['pub struct A;']
    },
    symbols: [{ file: 'src/a.rs', name: 'A', kind: 'struct', start: 1, end: 1, occurrences: [] }]
  });
  assert.ok(model.brief.overview.what.includes('binary'));
  assert.ok(model.brief.overview.what.includes('main is the entry point'));
});

test('flow reads as typed inputs and outputs', () => {
  const model = buildArchitecture({
    revision: 'r',
    crate: 'demo',
    root: '/demo',
    sources: {
      'src/request.rs': ['pub struct Request;'],
      'src/agent.rs': ['pub struct Ending;', 'pub async fn run(request: Request) -> Ending { Ending }'],
      'src/main.rs': ['fn main() {', '    run(Request);', '}']
    },
    symbols: [
      { file: 'src/request.rs', name: 'Request', kind: 'struct', start: 1, end: 1, occurrences: [] },
      { file: 'src/agent.rs', name: 'Ending', kind: 'struct', start: 1, end: 1, occurrences: [] },
      {
        file: 'src/agent.rs',
        name: 'run',
        kind: 'fn',
        start: 2,
        end: 2,
        signature: 'pub async fn run(request: Request) -> Ending',
        occurrences: [{ file: 'src/main.rs', line: 2, kind: 'call' }]
      }
    ]
  });
  const overview = model.brief.overview;
  assert.ok(overview.flow.includes('main → agent: Request → Ending'));
  assert.ok(overview.what.includes('uses async Rust'));
});

test('capabilities and carrier flow are inferred from code', () => {
  const model = buildArchitecture({
    revision: 'r',
    crate: 'demo',
    root: '/demo',
    dependencies: ['reqwest', 'serde'],
    sources: {
      'src/request.rs': ['pub struct Request;'],
      'src/client.rs': [
        'pub struct Reply;',
        'pub fn complete(request: Request) -> Reply { Reply }',
        'const URL: &str = "https://api.example/v1/chat/completions";'
      ],
      'src/agent.rs': ['pub fn decide(reply: Reply) {}']
    },
    symbols: [
      { file: 'src/request.rs', name: 'Request', kind: 'struct', start: 1, end: 1, occurrences: [] },
      { file: 'src/client.rs', name: 'Reply', kind: 'struct', start: 1, end: 1, occurrences: [] },
      {
        file: 'src/client.rs',
        name: 'complete',
        kind: 'fn',
        start: 2,
        end: 2,
        signature: 'pub fn complete(request: Request) -> Reply',
        occurrences: [{ file: 'src/agent.rs', line: 1, kind: 'call' }]
      },
      {
        file: 'src/agent.rs',
        name: 'decide',
        kind: 'fn',
        start: 1,
        end: 1,
        signature: 'pub fn decide(reply: Reply)',
        occurrences: []
      }
    ]
  });
  const overview = model.brief.overview;
  assert.ok(overview.appearsTo.includes('model API'));
  assert.ok(overview.appearsTo.includes('appears to be'));
  assert.ok(overview.dataFlow.includes('Reply: client → agent'));
});

test('comment text alone does not trigger capability guesses', () => {
  const model = buildArchitecture({
    revision: 'r',
    crate: 'demo',
    root: '/demo',
    sources: {
      'src/main.rs': [
        '// call https://api.example/v1/chat/completions with max_tokens and tool_calls',
        'fn main() {}'
      ]
    },
    symbols: []
  });
  assert.ok(!model.brief.overview.appearsTo.includes('model API'));
});

test('transformations chain inputs to outputs', () => {
  const model = buildArchitecture({
    revision: 'r',
    crate: 'demo',
    root: '/demo',
    sources: {
      'src/request.rs': ['pub struct Request;'],
      'src/client.rs': ['pub struct Reply;', 'pub fn complete(request: Request) -> Reply { Reply }'],
      'src/agent.rs': ['pub struct Decision;', 'pub fn decide(reply: Reply) -> Decision { Decision }']
    },
    symbols: [
      { file: 'src/request.rs', name: 'Request', kind: 'struct', start: 1, end: 1, occurrences: [] },
      { file: 'src/client.rs', name: 'Reply', kind: 'struct', start: 1, end: 1, occurrences: [] },
      { file: 'src/agent.rs', name: 'Decision', kind: 'struct', start: 1, end: 1, occurrences: [] },
      {
        file: 'src/client.rs',
        name: 'complete',
        kind: 'fn',
        start: 2,
        end: 2,
        signature: 'pub fn complete(request: Request) -> Reply',
        occurrences: [{ file: 'src/agent.rs', line: 2, kind: 'call' }]
      },
      {
        file: 'src/agent.rs',
        name: 'decide',
        kind: 'fn',
        start: 2,
        end: 2,
        signature: 'pub fn decide(reply: Reply) -> Decision',
        occurrences: [{ file: 'src/agent.rs', line: 3, kind: 'call' }]
      }
    ]
  });
  const text = model.brief.overview.transformations;
  assert.ok(text.includes('Request → Reply (client::complete)'));
  assert.ok(text.includes('Reply → Decision (agent::decide)'));
});

test('archetype names an LLM agent harness and start points at the entry', () => {
  const model = buildArchitecture({
    revision: 'r',
    crate: 'demo',
    root: '/demo',
    dependencies: ['reqwest'],
    sources: {
      'src/main.rs': ['fn main() {', '    run();', '}'],
      'src/agent.rs': ['pub fn run() {}'],
      'src/client.rs': ['pub struct Reply;', 'const URL: &str = "https://api.example/chat/completions";'],
      'src/tools.rs': ['pub trait Tool {', '    fn name(&self) -> &str;', '}', 'pub struct Read;', 'impl Tool for Read {', '    fn name(&self) -> &str { "read" }', '}'],
      'src/log.rs': ['pub struct Event;', 'pub fn record(event: Event) { let _ = std::fs::OpenOptions::new().append(true); let _ = serde_json::to_string(&event); }']
    },
    symbols: [
      { file: 'src/main.rs', name: 'main', kind: 'fn', start: 1, end: 1, signature: 'fn main()', occurrences: [] },
      { file: 'src/agent.rs', name: 'run', kind: 'fn', start: 1, end: 1, signature: 'pub fn run()', occurrences: [] },
      { file: 'src/client.rs', name: 'Reply', kind: 'struct', start: 1, end: 1, occurrences: [] }
    ]
  });
  assert.ok(model.brief.overview.what.startsWith('demo appears to be an LLM agent harness'));
  assert.ok(model.brief.overview.start.includes('src/main.rs'));
  assert.ok(model.brief.overview.evidence.some((item) => item.includes('Tool implementations')));
  assert.ok(model.brief.overview.evidence.some((item) => item.includes('chat-completions endpoint')));
});
