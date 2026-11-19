import assert from 'node:assert/strict';
import test from 'node:test';
import { validateBrief } from '../src/brief';
import { buildStructuralOverview } from '../src/overview';

const SAMPLE = `//! The turn loop.
use crate::client::Client;

pub struct Limits {
    pub max: u32,
}

pub enum Decision {
    Act,
    Answer,
}

pub fn run(client: &Client) -> u32 {
    let value = 1;
    value
}
`;

const PURPOSE =
  'This module runs the agent turn loop. Each turn sends the current conversation to the model, records the reply, and either returns an answer or carries out the requested tool calls. A run can start fresh or resume after a pause, and it ends with an answer, a stop rule, or a request for approval.';

function meta() {
  return {
    file: 'src/agent.rs',
    crateName: 'harness',
    model: 'test-model',
    sourceHash: 'test-hash',
    overview: buildStructuralOverview({
      file: 'src/agent.rs',
      text: SAMPLE,
      modulePath: 'crate::agent',
      crateName: 'harness'
    })
  };
}

test('keeps a well-formed module reading and fills function ranges from symbols', () => {
  const { brief, issues } = validateBrief(
    {
      role: 'Runs the agent turn loop from a fresh start or a pause.',
      purpose: PURPOSE,
      boundaries: 'This module delegates provider I/O to crate::client.',
      operations: [
        {
          name: 'Define the limits',
          purpose: 'Defines the stop conditions for a run.',
          entry: 'run',
          functions: ['run'],
          start: 4,
          end: 6
        },
        {
          name: 'Run the loop',
          purpose: 'Sends a turn to the model and returns the result.',
          entry: 'run',
          functions: ['run'],
          start: 13,
          end: 16
        }
      ],
      functions: [
        {
          name: 'run',
          summary: 'Calls the provider and returns the value.',
          why: 'Replay and resume need the start event.',
          inputs: 'A borrowed client.',
          returns: 'The value.',
          errors: 'None in this sample.',
          sideEffects: 'Calls the provider.',
          steps: [
            { text: 'Creates a local value.', start: 14, end: 14 },
            { text: 'Returns the value.', start: 15, end: 15 }
          ]
        }
      ],
      rules: [
        { title: 'Stop early', text: 'The run stops when the reply carries no calls.', start: 8, end: 11 }
      ]
    },
    SAMPLE,
    meta()
  );

  assert.equal(brief.version, 2);
  assert.equal(brief.file, 'src/agent.rs');
  assert.equal(brief.sourceHash, 'test-hash');
  assert.equal(brief.boundaries, 'This module delegates provider I/O to crate::client.');
  assert.deepEqual(brief.operations?.map((operation) => operation.start), [4, 13]);
  assert.deepEqual(brief.rules?.map((rule) => rule.title), ['Stop early']);
  assert.equal(brief.functions.length, 1);
  assert.equal(brief.functions[0].start, 13);
  assert.equal(brief.functions[0].end, 16);
  assert.match(brief.functions[0].signature || '', /pub fn run/);
  assert.equal(brief.functions[0].why, 'Replay and resume need the start event.');
  assert.equal(brief.functions[0].steps.length, 2);
  assert.equal(issues.length, 0);
});

test('drops invalid operations, functions and rules', () => {
  const { brief, issues } = validateBrief(
    {
      role: 'Runs the turn loop.',
      purpose: PURPOSE,
      operations: [
        {
          name: 'Good',
          purpose: 'A valid operation.',
          entry: 'run',
          functions: ['run'],
          start: 13,
          end: 16
        },
        {
          name: 'Bad range',
          purpose: 'Outside the source.',
          entry: 'run',
          functions: ['run'],
          start: 99,
          end: 120
        },
        {
          name: 'Good again',
          purpose: 'Another valid operation.',
          entry: 'run',
          functions: ['run'],
          start: 4,
          end: 6
        }
      ],
      functions: [
        {
          name: 'missing',
          summary: 'Not a function in this file.',
          steps: [
            { text: 'Nope.', start: 1, end: 2 },
            { text: 'Nope.', start: 2, end: 3 }
          ]
        },
        {
          name: 'run',
          summary: 'Calls the provider.',
          steps: [
            { text: 'Outside the function.', start: 1, end: 2 },
            { text: 'Inside the function.', start: 14, end: 14 }
          ]
        }
      ],
      rules: [{ title: 'Bad', text: 'Outside the source.', start: 99, end: 120 }]
    },
    SAMPLE,
    meta()
  );

  assert.equal(brief.operations?.length, 2);
  assert.equal(brief.rules, undefined);
  assert.equal(brief.functions.length, 0);
  assert.ok(issues.some((issue) => issue.includes('invalid range')));
  assert.ok(issues.some((issue) => issue.includes('missing')));
  assert.ok(issues.some((issue) => issue.includes('too few valid steps')));
});

test('reports role and purpose style violations without dropping the reading', () => {
  const longRole =
    'Runs the agent turn loop and stops on an answer, the turn ceiling, the budget, or repeated calls in the same signature';
  const { brief, issues } = validateBrief(
    {
      role: longRole,
      purpose: 'Runs the loop.',
      operations: [
        {
          name: 'One',
          purpose: 'A valid operation.',
          entry: 'run',
          functions: [],
          start: 13,
          end: 16
        },
        {
          name: 'Two',
          purpose: 'Another valid operation.',
          entry: 'run',
          functions: [],
          start: 4,
          end: 6
        }
      ],
      functions: [],
      rules: []
    },
    SAMPLE,
    meta()
  );

  assert.equal(brief.role, longRole);
  assert.ok(issues.some((issue) => issue.includes('limit is 18')));
  assert.ok(issues.some((issue) => issue.includes('expected 2-4')));
  assert.ok(issues.some((issue) => issue.includes('expected 50-100')));
  assert.ok(issues.some((issue) => issue.includes('begin with "This module"')));
});

test('matches a method by unqualified name and normalizes it', () => {
  const text = `pub struct Reply;

impl Reply {
    pub fn from_json(raw: &str) -> u32 { 1 }
}
`;
  const sourceMeta = {
    file: 'src/reply.rs',
    crateName: 'harness',
    model: 'test-model',
    sourceHash: 'test-hash',
    overview: buildStructuralOverview({ file: 'src/reply.rs', text })
  };

  const { brief } = validateBrief(
    {
      role: 'Parses one reply.',
      purpose: PURPOSE,
      operations: [
        {
          name: 'Parse the reply',
          purpose: 'Reads one provider reply.',
          entry: 'from_json',
          functions: ['from_json'],
          start: 4,
          end: 4
        },
        {
          name: 'Return the value',
          purpose: 'Returns the parsed value.',
          entry: 'from_json',
          functions: ['from_json'],
          start: 4,
          end: 4
        }
      ],
      functions: [
        {
          name: 'from_json',
          summary: 'Parses one reply.',
          steps: [
            { text: 'Reads the body.', start: 4, end: 4 },
            { text: 'Returns the value.', start: 4, end: 4 }
          ]
        }
      ],
      rules: []
    },
    text,
    sourceMeta
  );

  assert.equal(brief.functions.length, 1);
  assert.equal(brief.functions[0].name, 'Reply::from_json');
  assert.equal(brief.functions[0].start, 4);
  assert.equal(brief.functions[0].end, 4);
});
