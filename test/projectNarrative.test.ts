import assert from 'node:assert/strict';
import test from 'node:test';
import { buildArchitecture } from '../src/architecture';
import { buildNarrativeInput } from '../src/projectNarrative';

test('narrative facts carry code-derived structure and no comment text', () => {
  const model = buildArchitecture({
    revision: 'r',
    crate: 'demo',
    root: '/demo',
    sources: {
      'src/lib.rs': ['//! Secret crate doc.', 'pub mod a;'],
      'src/main.rs': ['pub fn main() {', '    build();', '}'],
      'src/a.rs': ['pub struct A;', 'pub fn build(input: B) -> A { A }'],
      'src/b.rs': ['pub struct B;']
    },
    symbols: [
      { file: 'src/main.rs', name: 'main', kind: 'fn', start: 1, end: 1, signature: 'pub fn main()', occurrences: [] },
      { file: 'src/a.rs', name: 'A', kind: 'struct', start: 1, end: 1, occurrences: [] },
      { file: 'src/b.rs', name: 'B', kind: 'struct', start: 1, end: 1, occurrences: [] },
      {
        file: 'src/a.rs',
        name: 'build',
        kind: 'fn',
        start: 2,
        end: 2,
        signature: 'pub fn build(input: B) -> A',
        occurrences: [{ file: 'src/main.rs', line: 2, kind: 'call' }]
      }
    ],
    dependencies: ['tokio']
  });
  const facts = buildNarrativeInput(model);
  assert.ok(facts.includes('CRATE: demo'));
  assert.ok(facts.includes('ENTRY: main'));
  assert.ok(facts.includes('- a: '));
  assert.ok(facts.includes('tokio'));
  assert.ok(facts.includes('CALL EDGES'));
  assert.ok(facts.includes('CODE SAMPLE'));
  assert.ok(!facts.includes('Secret crate doc'));
});
