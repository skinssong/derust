import assert from 'node:assert/strict';
import test from 'node:test';
import { buildArchitecture } from '../src/architecture';
import { layoutArchitecture, routeToSegments } from '../src/elkLayout';

test('routeToSegments converts world bend points', () => {
  const segments = routeToSegments(
    [785, 384],
    [443, 456],
    [
      [585, 379],
      [585, 448.72]
    ]
  );
  assert.deepEqual(segments.w, [0.557, 0.5981]);
  assert.deepEqual(segments.d, [46.09, -22.13]);
});

test('ELK places nodes left to right and attaches segment data', async () => {
  const sources: Record<string, string[]> = {
    'src/a.rs': ['pub struct A;'],
    'src/b.rs': ['pub fn build() -> A { A }'],
    'src/c.rs': ['pub fn run() {', '    build();', '}']
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
        name: 'build',
        kind: 'fn',
        start: 1,
        end: 1,
        signature: 'pub fn build() -> A',
        occurrences: [{ file: 'src/c.rs', line: 2, kind: 'call' }]
      }
    ]
  });
  const laidOut = await layoutArchitecture(model);
  assert.ok(laidOut.positions.a && laidOut.positions.b && laidOut.positions.c);
  assert.ok(laidOut.positions.c[0] < laidOut.positions.b[0]);
  const edge = laidOut.edges.find((item) => item.source === 'c' && item.target === 'b');
  assert.ok(edge);
  assert.ok(Array.isArray(edge!.segW));
  assert.ok(Array.isArray(edge!.segD));

  const again = await layoutArchitecture(model);
  assert.deepEqual(again.positions, laidOut.positions);
});
