import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAnalysis } from '../src/analyzer';

const source = [
  'fn main() {',
  '    let x = 1;',
  '    println!("{x}");',
  '}'
].join('\n');

const meta = { file: 'src/lib.rs', model: 'test-model' };

function baseRaw(): any {
  return {
    version: 1,
    file: 'src/lib.rs',
    typeInventory: [{ name: 'main', kind: 'fn', start: 1, end: 4 }],
    spotlights: [
      {
        code: 'let x = 1;',
        start: 2,
        end: 2,
        means: 'binds one owned integer',
        equivalent: '—'
      }
    ],
    ownership: [
      {
        name: 'main',
        kind: 'fn',
        start: 1,
        end: 4,
        points: [{ text: '`x` owns an integer on the stack.', scope: 'line', start: 2, end: 2 }]
      }
    ],
    memory: [
      {
        function: 'main',
        start: 1,
        end: 4,
        frames: [{ id: 'main', name: 'main', start: 1, end: 4, parent: null }],
        values: [
          {
            id: 'x',
            name: 'x',
            type: 'i32',
            frame: 'main',
            kind: 'binding',
            mutable: false,
            start: 2,
            end: 3
          },
          {
            id: 'out',
            name: 'out',
            type: 'Stdout',
            frame: 'main',
            kind: 'binding',
            mutable: true,
            start: 3,
            end: 3,
            pointers: [{ heap: 'buf' }]
          }
        ],
        heap: [
          {
            id: 'buf',
            type: 'String',
            label: 'stdout buffer',
            start: 3,
            end: 3,
            cells: ['{x}']
          }
        ],
        events: []
      }
    ]
  };
}

test('keeps a well-formed analysis', () => {
  const { analysis, issues } = validateAnalysis(baseRaw(), source, meta);
  assert.equal(analysis.file, 'src/lib.rs');
  assert.equal(analysis.spotlights.length, 1);
  assert.equal(analysis.ownership[0].points.length, 1);
  assert.equal(analysis.memory.length, 1);
  assert.equal(analysis.memory[0].values.length, 2);
  assert.equal(analysis.memory[0].heap.length, 1);
  assert.deepEqual(issues, []);
});

test('drops an out-of-range spotlight and reports it', () => {
  const raw = baseRaw();
  raw.spotlights.push({
    code: 'println!',
    start: 99,
    end: 99,
    means: 'prints',
    equivalent: '—'
  });

  const { analysis, issues } = validateAnalysis(raw, source, meta);
  assert.equal(analysis.spotlights.length, 1);
  assert.ok(issues.some((issue) => issue.includes('dropped')));
  assert.ok(analysis.warnings && analysis.warnings.length > 0);
});

test('snaps a quote to its unique location', () => {
  const raw = baseRaw();
  raw.spotlights[0].start = 3;
  raw.spotlights[0].end = 3;

  const { analysis, issues } = validateAnalysis(raw, source, meta);
  assert.equal(analysis.spotlights[0].start, 2);
  assert.equal(analysis.spotlights[0].end, 2);
  assert.deepEqual(issues, []);
});

test('drops points outside their group and invalid memory records', () => {
  const raw = baseRaw();
  raw.ownership[0].points.push({
    text: 'outside',
    scope: 'line',
    start: 9,
    end: 9
  });

  raw.memory[0].values[1].pointers.push({ heap: 'missing' });
  raw.memory[0].values.push({
    id: 'r',
    name: 'r',
    type: '&i32',
    frame: 'main',
    kind: 'ref',
    mutable: false,
    start: 2,
    end: 4,
    borrowOf: 'x',
    borrowMode: 'shared'
  });
  raw.memory[0].events.push({ line: 3, kind: 'move', from: 'x', to: 'missing' });

  const { analysis, issues } = validateAnalysis(raw, source, meta);
  assert.equal(analysis.ownership[0].points.length, 1);
  assert.equal(analysis.memory[0].values.length, 2);
  assert.equal(analysis.memory[0].events.length, 0);
  assert.equal(analysis.memory[0].values[1].pointers?.length, 1);
  assert.ok(issues.some((issue) => issue.includes('point')));
  assert.ok(issues.some((issue) => issue.includes('pointer')));
  assert.ok(issues.some((issue) => issue.includes('borrow')));
  assert.ok(issues.some((issue) => issue.includes('destination')));
});

test('accepts a v2 event inside the source lifetime', () => {
  const raw = baseRaw();
  raw.memory[0].events.push({ line: 3, kind: 'move', from: 'x', toLabel: 'println' });

  const { analysis, issues } = validateAnalysis(raw, source, meta);
  assert.equal(analysis.memory[0].events.length, 1);
  assert.deepEqual(issues, []);
});

test('drops plain type declarations from spotlights', () => {
  const declarationSource = [
    'pub struct Point {',
    '    x: i32,',
    '}',
    '',
    'fn main() {}'
  ].join('\n');

  const raw = {
    version: 1,
    file: 'src/lib.rs',
    typeInventory: [],
    spotlights: [
      {
        code: 'pub struct Point {\n    x: i32,\n}',
        start: 1,
        end: 3,
        means: 'a point type',
        equivalent: '—'
      }
    ],
    ownership: []
  };

  const { analysis, issues } = validateAnalysis(raw, declarationSource, meta);
  assert.equal(analysis.spotlights.length, 0);
  assert.ok(issues.some((issue) => issue.includes('declaration')));
});

test('keeps up to three key-function memory records', () => {
  const raw = baseRaw();
  const prototype = JSON.parse(JSON.stringify(raw.memory[0]));
  raw.memory = [0, 1, 2, 3].map((index) => ({
    ...JSON.parse(JSON.stringify(prototype)),
    function: `key_${index}`
  }));

  const { analysis, issues } = validateAnalysis(raw, source, meta);
  assert.equal(analysis.memory.length, 3);
  assert.deepEqual(
    analysis.memory.map((record) => record.function),
    ['key_0', 'key_1', 'key_2']
  );
  assert.deepEqual(issues, []);
});
