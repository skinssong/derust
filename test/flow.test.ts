import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFlowInput, linkFlowSources, parseFlow, parseFlowText } from '../src/flow';
import { buildArchitecture } from '../src/architecture';

test('flow specs are validated and normalised', () => {
  const spec = parseFlow({
    title: 'One run',
    stages: [
      { id: 'task', title: 'Task in', kind: 'input' },
      { id: 'turn', title: 'Model turn', kind: 'step' },
      { id: 'decide', title: 'Decide', kind: 'decision' },
      { id: 'answer', title: 'Answer', kind: 'output' }
    ],
    edges: [
      { from: 'task', to: 'turn' },
      { from: 'turn', to: 'decide' },
      { from: 'decide', to: 'answer', label: 'answer' },
      { from: 'decide', to: 'missing' }
    ]
  });
  assert.ok(spec);
  assert.equal(spec!.stages.length, 4);
  assert.equal(spec!.edges.length, 3);
  assert.equal(spec!.edges[2].label, 'answer');
  assert.equal(parseFlow({ title: 'x', stages: [], edges: [] }), undefined);
});

test('flow input carries facts and comment-free code', () => {
  const model = buildArchitecture({
    revision: 'r',
    crate: 'demo',
    root: '/demo',
    sources: {
      'src/main.rs': ['//! Secret doc.', 'fn main() {}'],
      'src/agent.rs': ['pub fn run() {}']
    },
    symbols: [
      { file: 'src/main.rs', name: 'main', kind: 'fn', start: 2, end: 2, signature: 'fn main()', occurrences: [] }
    ]
  });
  const input = buildFlowInput(model);
  assert.ok(input.includes('CRATE: demo'));
  assert.ok(input.includes('CODE SAMPLE'));
  assert.ok(!input.includes('Secret doc'));
});

test('flow parsing tolerates fences, aliases and title endpoints', () => {
  const text = [
    'Here is the flow:',
    '```json',
    '{"flow":{"title":"Run","nodes":[',
    '{"label":"Task in","type":"start"},',
    '{"name":"Model turn","type":"process"},',
    '{"title":"Answer","type":"end"}],',
    '"connections":[',
    '{"source":"Task in","target":"Model turn"},',
    '{"source":"Model turn","target":"Answer","condition":"answer"}]}}',
    '```'
  ].join('\n');
  const parsed = parseFlowText(text);
  assert.ok(parsed.spec);
  assert.deepEqual(
    parsed.spec!.stages.map((stage) => stage.kind),
    ['input', 'step', 'output']
  );
  assert.equal(parsed.spec!.edges.length, 2);
  assert.equal(parsed.spec!.edges[1].label, 'answer');
});

test('flow parsing reports why a response was rejected', () => {
  assert.match(parseFlowText('no json here').reason ?? '', /no JSON/);
  assert.match(
    parseFlowText('{"title":"x","stages":[{"id":"a","title":"A"}],"edges":[]}').reason ?? '',
    /only 1/
  );
});

test('flow stages keep the code citation they were given', () => {
  const spec = parseFlow({
    title: 'Run',
    stages: [
      { id: 'a', title: 'Task', kind: 'input', source: '`agent::run()`' },
      { id: 'b', title: 'Answer', kind: 'output', handler: 'reply::decide' }
    ],
    edges: [{ from: 'a', to: 'b' }]
  });
  assert.ok(spec);
  assert.equal(spec!.stages[0].source, 'agent::run');
  assert.equal(spec!.stages[1].source, 'reply::decide');
});

test('flow sources resolve to the file and line the diagram can open', () => {
  const model = buildArchitecture({
    revision: 'r',
    crate: 'demo',
    root: '/demo',
    sources: {
      'src/main.rs': ['fn main() {}'],
      'src/agent.rs': ['pub fn run() {}', 'pub struct Agent;', 'impl Agent { pub fn new() {} }']
    },
    symbols: [
      {
        file: 'src/agent.rs',
        name: 'run',
        kind: 'fn',
        start: 1,
        end: 1,
        signature: 'pub fn run()',
        occurrences: []
      },
      {
        file: 'src/agent.rs',
        name: 'Agent',
        kind: 'struct',
        start: 2,
        end: 2,
        signature: 'pub struct Agent;',
        occurrences: []
      },
      {
        file: 'src/agent.rs',
        name: 'Agent::new',
        kind: 'fn',
        start: 3,
        end: 3,
        signature: 'pub fn new()',
        occurrences: []
      }
    ]
  });
  const spec = parseFlow({
    title: 'Run',
    stages: [
      { id: 'a', title: 'Task', kind: 'input', source: 'agent::run' },
      { id: 'b', title: 'Hold', kind: 'step', source: 'agent::Agent' },
      { id: 'c', title: 'Lost', kind: 'step', source: 'unknown::thing' },
      { id: 'd', title: 'Reply', kind: 'output', source: 'main' },
      { id: 'e', title: 'Fresh', kind: 'step', source: 'agent::Agent::new' }
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'd' },
      { from: 'd', to: 'e' }
    ]
  });
  assert.ok(spec);
  linkFlowSources(spec!, model);
  assert.deepEqual(
    spec!.stages.map((stage) => [stage.source, stage.file ?? null, stage.line ?? null]),
    [
      ['agent', 'src/agent.rs', 1],
      ['agent', 'src/agent.rs', 2],
      ['unknown::thing', null, null],
      ['main', 'src/main.rs', 1],
      ['agent', 'src/agent.rs', 3]
    ]
  );
});
