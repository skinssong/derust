import assert from 'node:assert/strict';
import test from 'node:test';
import { buildArchitecture } from '../src/architecture';
import { buildFlowBriefInput, parseFlowBrief } from '../src/flowBrief';

function demoModel(entry: boolean) {
  return buildArchitecture({
    revision: 'r',
    crate: 'demo',
    root: '/demo',
    sources: entry
      ? { 'src/main.rs': ['fn main() {}'], 'src/agent.rs': ['pub fn run() {}'] }
      : { 'src/lib.rs': ['pub fn run() {}'] },
    symbols: [
      {
        file: entry ? 'src/main.rs' : 'src/lib.rs',
        name: entry ? 'main' : 'run',
        kind: 'fn',
        start: 1,
        end: 1,
        signature: entry ? 'fn main()' : 'pub fn run()',
        occurrences: []
      }
    ]
  });
}

const flow = {
  title: 'One run',
  stages: [
    { id: 'a', title: 'Task intake', detail: 'The task enters the program.', kind: 'input' as const },
    { id: 'b', title: 'Answer', detail: 'The answer is returned.', kind: 'output' as const }
  ],
  edges: [{ from: 'a', to: 'b', label: 'answer' }]
};

test('brief input carries the path with kinds, entry and branches', () => {
  const input = buildFlowBriefInput(demoModel(true), flow);
  assert.match(input, /^CRATE: demo$/m);
  assert.match(input, /^ARCHETYPE: unknown$/m);
  assert.match(input, /^ENTRY: main$/m);
  assert.match(input, /^EXECUTION PATH \(one use\):$/m);
  assert.match(input, /^- \[input\] Task intake: The task enters the program\.$/m);
  assert.match(input, /^- \[output\] Answer: The answer is returned\.$/m);
  assert.match(input, /^BRANCHES \(a label is a condition/m);
  assert.match(input, /^- Task intake -> Answer \(answer\)$/m);
  assert.match(input, /Values that cannot be determined/);
});

test('brief input says the entry is a library API when there is no main', () => {
  const input = buildFlowBriefInput(demoModel(false), flow);
  assert.match(input, /^ENTRY: none \(library API\)$/m);
});

test('brief parsing accepts an object, fenced and wrapped', () => {
  assert.equal(parseFlowBrief('{"brief": "demo appears to be a Rust tool."}'), 'demo appears to be a Rust tool.');
  assert.equal(
    parseFlowBrief('Here it is:\n```json\n{"brief":"  a  brief  "}\n```'),
    'a brief'
  );
  assert.equal(parseFlowBrief('{"narrative": "a legacy field"}'), 'a legacy field');
});

test('brief parsing rejects anything without a brief string', () => {
  assert.equal(parseFlowBrief('no json here'), undefined);
  assert.equal(parseFlowBrief('{"brief": "   "}'), undefined);
  assert.equal(parseFlowBrief('{"other": "x"}'), undefined);
  assert.equal(parseFlowBrief('["a", "b"]'), undefined);
});
