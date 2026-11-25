import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReadingInput, parseReading } from '../src/reading';
import { buildArchitecture } from '../src/architecture';

test('reading steps keep only known files and drop empty steps', () => {
  const files = new Set(['src/main.rs', 'src/agent.rs', 'src/client.rs']);
  const spec = parseReading(
    {
      steps: [
        { title: 'Start', why: 'Entry.', files: ['src/main.rs', 'nope.rs'] },
        { title: 'Empty', why: 'Nothing.', files: ['missing.rs'] },
        { title: 'Loop', why: 'The loop.', files: ['src/agent.rs'] },
        { title: 'Exchange', why: 'One call.', files: ['src/client.rs', 'src/client.rs'] }
      ]
    },
    files
  );
  assert.ok(spec);
  assert.deepEqual(
    spec!.steps.map((step) => step.title),
    ['Start', 'Loop', 'Exchange']
  );
  assert.deepEqual(spec!.steps[0].files, ['src/main.rs']);
  assert.deepEqual(spec!.steps[2].files, ['src/client.rs']);
  assert.equal(parseReading({ steps: [{ title: 'x', files: ['src/main.rs'] }] }, files), undefined);
});

test('reading input lists the allowed files and no comments', () => {
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
  const input = buildReadingInput(model);
  assert.ok(input.includes('FILE LIST'));
  assert.ok(input.includes('- src/main.rs'));
  assert.ok(input.includes('- src/agent.rs'));
  assert.ok(!input.includes('Secret doc'));
});
