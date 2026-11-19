import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProfileCandidates, formatModuleProfile, validateProfile } from '../src/profile';
import { ModuleContext } from '../src/contract';

const SOURCE = `//! The turn loop.
use crate::client::Client;

pub struct Limits {
    pub max: u32,
}

pub fn run(client: &Client) -> u32 {
    let value = 1;
    value
}

pub fn decide(value: u32) -> u32 {
    value
}
`;

function context(): ModuleContext {
  return {
    file: 'src/agent.rs',
    modulePath: 'crate::agent',
    crateName: 'harness',
    moduleDoc: 'The turn loop.',
    publicSurface: [
      { name: 'Limits', kind: 'struct', start: 4, end: 6, visibility: 'public' },
      { name: 'run', kind: 'fn', start: 8, end: 11, visibility: 'public' },
      { name: 'decide', kind: 'fn', start: 13, end: 15, visibility: 'public' }
    ],
    imports: ['use crate::client::Client;'],
    callers: [
      { name: 'main', file: 'src/main.rs', line: 5, source: 'main', target: 'run' },
      { name: 'a_test', file: 'tests/agent.rs', line: 10, source: 'a_test', target: 'run' }
    ],
    callees: [
      { name: 'complete', file: 'src/client.rs', line: 40, source: 'run', target: 'complete' },
      { name: 'project', file: 'src/context.rs', line: 50, source: 'run', target: 'project' },
      { name: 'decide', file: 'src/agent.rs', line: 60, source: 'run', target: 'decide' }
    ],
    tests: [{ name: 'a_test', file: 'tests/agent.rs', line: 10, source: 'a_test', target: 'run' }],
    dependencies: ['tokio'],
    revision: 'revision-1'
  };
}

test('derives delegates, call groups and key functions from the index packet', () => {
  const candidates = buildProfileCandidates(context(), SOURCE);

  assert.deepEqual(
    candidates.delegates.map((delegate) => delegate.to),
    ['crate::client', 'crate::context']
  );
  assert.deepEqual(
    candidates.callGroups.map((group) => `${group.source}->${group.targetModule}`),
    ['run->crate::agent', 'run->crate::client', 'run->crate::context']
  );
  assert.equal(candidates.keyFunctions[0].name, 'run');
  assert.match(candidates.keyFunctions[0].why, /Entry point|Called from/);
});

test('validates a profile and fills key-function ranges from the index', () => {
  const candidates = buildProfileCandidates(context(), SOURCE);
  const { profile, issues } = validateProfile(
    {
      role: 'Runs the turn loop.',
      owns: ['Turn order', 'Stop rules'],
      delegates: [
        { concern: 'provider I/O', to: 'crate::client', symbols: ['complete'] },
        { concern: 'unknown', to: 'crate::not_there', symbols: ['nope'] }
      ],
      operations: [
        {
          name: 'Take a turn',
          purpose: 'Call the client and return a value.',
          entry: 'run',
          functions: ['complete', 'unknown'],
          start: 8,
          end: 11
        },
        {
          name: 'Decide',
          purpose: 'Map a value to a decision.',
          entry: 'decide',
          functions: ['decide'],
          start: 13,
          end: 15
        }
      ],
      keyFunctions: [
        { name: 'run', why: 'The turn loop.' },
        { name: 'missing', why: 'Not here.' }
      ]
    },
    SOURCE,
    candidates,
    { revision: 'revision-1' }
  );

  assert.equal(profile.role, 'Runs the turn loop.');
  assert.equal(profile.delegates.length, 1);
  assert.equal(profile.operations.length, 2);
  assert.equal(profile.operations[0].functions.length, 1);
  assert.equal(profile.keyFunctions.length, 1);
  assert.equal(profile.keyFunctions[0].start, 8);
  assert.equal(profile.keyFunctions[0].end, 11);
  assert.ok(issues.some((issue) => issue.includes('unknown target')));
  assert.ok(issues.some((issue) => issue.includes('unknown key function')));
  assert.match(formatModuleProfile(profile), /## Operations/);
});

test('rejects a profile without enough operations', () => {
  const candidates = buildProfileCandidates(context(), SOURCE);
  assert.throws(
    () =>
      validateProfile(
        {
          role: 'Runs the loop.',
          owns: ['Turn order', 'Stop rules'],
          delegates: [],
          operations: [
            { name: 'One', purpose: 'Only one.', entry: 'run', functions: [], start: 8, end: 11 }
          ],
          keyFunctions: [{ name: 'run', why: 'Loop.' }]
        },
        SOURCE,
        candidates,
        { revision: 'revision-1' }
      ),
    /too few valid operations/
  );
});
