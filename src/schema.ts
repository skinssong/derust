export const PROMPT_VERSION = '5';

export const analysisJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'file', 'typeInventory', 'spotlights', 'ownership'],
  properties: {
    version: { const: 1 },
    file: { type: 'string' },
    typeInventory: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'kind', 'start', 'end'],
        properties: {
          name: { type: 'string' },
          kind: { enum: ['struct', 'enum', 'trait', 'type', 'fn', 'mod', 'impl'] },
          start: { type: 'integer', minimum: 1 },
          end: { type: 'integer', minimum: 1 }
        }
      }
    },
    spotlights: {
      type: 'array',
      maxItems: 14,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'start', 'end', 'means', 'equivalent'],
        properties: {
          code: { type: 'string' },
          start: { type: 'integer', minimum: 1 },
          end: { type: 'integer', minimum: 1 },
          means: { type: 'string' },
          equivalent: { type: 'string' },
          trap: { type: 'string' }
        }
      }
    },
    ownership: {
      type: 'array',
      maxItems: 10,
      items: { $ref: '#/defs/traceGroup' }
    },
    memory: {
      type: 'array',
      maxItems: 3,
      items: { $ref: '#/defs/memoryRecord' }
    }
  },
  defs: {
    scope: { enum: ['fn', 'struct', 'line'] },
    point: {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'scope', 'start', 'end'],
      properties: {
        text: { type: 'string' },
        scope: { $ref: '#/defs/scope' },
        start: { type: 'integer', minimum: 1 },
        end: { type: 'integer', minimum: 1 }
      }
    },
    traceGroup: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'kind', 'start', 'end', 'points'],
      properties: {
        name: { type: 'string' },
        kind: { enum: ['fn', 'struct', 'enum', 'impl'] },
        start: { type: 'integer', minimum: 1 },
        end: { type: 'integer', minimum: 1 },
        points: { type: 'array', items: { $ref: '#/defs/point' } }
      }
    },
    memoryFrame: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'name', 'start', 'end'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        start: { type: 'integer', minimum: 1 },
        end: { type: 'integer', minimum: 1 },
        parent: { type: ['string', 'null'] }
      }
    },
    memoryPointer: {
      type: 'object',
      additionalProperties: false,
      required: ['heap'],
      properties: {
        heap: { type: 'string' },
        field: { type: 'string' },
        kind: { enum: ['owns', 'borrow'] }
      }
    },
    memoryValue: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'name', 'type', 'frame', 'kind', 'mutable', 'start', 'end'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        type: { type: 'string' },
        frame: { type: 'string' },
        kind: { enum: ['binding', 'ref', 'temp'] },
        mutable: { type: 'boolean' },
        start: { type: 'integer', minimum: 1 },
        end: { type: 'integer', minimum: 1 },
        borrowOf: { type: 'string', description: 'A value id or heap id this reference borrows.' },
        borrowMode: { enum: ['shared', 'mutable'] },
        external: { type: 'string', description: 'Set for references to data outside the function, e.g. caller bytes.' },
        pointers: { type: 'array', maxItems: 8, items: { $ref: '#/defs/memoryPointer' } },
        note: { type: 'string' }
      }
    },
    memoryHeap: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'type', 'label', 'start', 'end'],
      properties: {
        id: { type: 'string' },
        type: { type: 'string' },
        label: { type: 'string' },
        start: { type: 'integer', minimum: 1 },
        end: { type: 'integer', minimum: 1 },
        cells: { type: 'array', maxItems: 8, items: { type: 'string' } },
        layout: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ptr: { type: 'string' },
            len: { type: 'integer' },
            cap: { type: 'integer' }
          }
        },
        note: { type: 'string' }
      }
    },
    memoryEvent: {
      type: 'object',
      additionalProperties: false,
      required: ['line', 'kind', 'from'],
      properties: {
        line: { type: 'integer', minimum: 1 },
        kind: { enum: ['move', 'copy', 'clone', 'drop', 'assign'] },
        from: { type: 'string' },
        to: { type: 'string' },
        toLabel: { type: 'string', description: 'Use when ownership leaves the recorded values (callee, field, replacement).' },
        detail: { type: 'string' }
      }
    },
    memoryRecord: {
      type: 'object',
      additionalProperties: false,
      required: ['function', 'start', 'end', 'frames', 'values', 'heap', 'events'],
      properties: {
        function: { type: 'string' },
        start: { type: 'integer', minimum: 1 },
        end: { type: 'integer', minimum: 1 },
        frames: { type: 'array', items: { $ref: '#/defs/memoryFrame' } },
        values: { type: 'array', maxItems: 20, items: { $ref: '#/defs/memoryValue' } },
        heap: { type: 'array', maxItems: 12, items: { $ref: '#/defs/memoryHeap' } },
        events: { type: 'array', maxItems: 30, items: { $ref: '#/defs/memoryEvent' } },
        returns: { type: 'string' }
      }
    }
  }
} as const;
