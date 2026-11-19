# Module profile derivation

**Question.** The structural index gives module docs, public surface, imports, callers/callees, tests and dependencies. How do we turn that evidence into the module layer of the reading design — role, ownership, delegation, key operations and key functions — without turning it into another raw list?

**Status.** Standalone derivation spike; not wired into the extension yet.

```bash
cd /path/to/derust
npm run index:spike          # build/refresh the structural index
npm run profile:spike agent.rs
npm run profile:spike reply.rs
```

Outputs:

- `out/profile-agent.json`
- `out/profile-agent.md`
- `out/profile-reply.json`
- `out/profile-reply.md`

The profile is one additional model call over the index packet and source. It is not cached by the extension yet.

## Inputs

The profile writer receives:

- the existing module packet from the index:
  - module path and module docs;
  - public surface with signatures and line ranges;
  - imports;
  - callers, callees and tests;
  - crate dependencies;
- the target source, numbered;
- derived candidates:
  - **delegates**: callees grouped by target module;
  - **call groups**: source function → target module, with the functions involved;
  - **key-function candidates**: public functions ranked by inbound/outbound connectivity, with `main` callers treated as entry points.

The candidates are deterministic. The model only synthesizes the profile; it does not invent graph facts.

## Derivation

### 1. Delegates

Every local callee is grouped by its target module:

```text
run → crate::client        complete
run → crate::context       project, masked_count
run → crate::tool          dispatch, shaped
run → crate::log           record
```

The profile states these as concerns:

> model completion → `crate::client`
> tool execution and observation shaping → `crate::tool`

Callees in the same file and in `tests/` are excluded from delegation.

### 2. Call groups

Callees are grouped by `(source function, target module)`:

```text
run → crate::client: complete (L112-273)
run → crate::context: project, masked_count (L112-273)
run → crate::tool: dispatch, shaped (L112-273)
```

These groups are evidence for **operations**. The model groups them into a small number of contracts; it must not output one operation per call group.

### 3. Key-function candidates

For each public function:

```text
score = incoming_calls * 2 + outgoing_calls
       + 10 if an external caller is main.rs
```

The top three become candidates. Their line ranges come from the index, not from the model.

### 4. Profile synthesis

The model returns:

- `role` — one sentence;
- `owns` — 2–5 responsibilities, not type names;
- `delegates` — only targets that appear in the index;
- `operations` — 2–5 contracts in execution/reading order, each with entry function, involved functions, and a line range;
- `keyFunctions` — 1–3 public functions with a reason.

Validation drops unknown delegate targets, unknown key functions, invalid ranges and operations with too few valid records.

## Live result: `agent.rs`

```text
Role
Drives the agent loop: call the model, act on tool calls, observe results,
stop on answer or limit.

Owns
- Counting turns as model calls and enforcing the per-run ceiling
- Stopping the run on budget overspend or on a repeating call-and-result pair
- Projecting the conversation onto the wire while keeping the record whole
- Dispatching tool calls and feeding shaped observations back into the transcript
- Writing each turn to the recorder before the turn is acted on

Delegates
- model completion over the wire → crate::client
- token cost computation → crate::config
- context projection and masking counts → crate::context
- event and turn recording → crate::log
- building tool result messages → crate::message
- tool execution and observation shaping → crate::tool
- request continuation and per-field access → crate::request
- reply accessors and usage arithmetic → crate::reply

Operations
1. Open the run — L112-134
   Record the start event and initialize spend, repetition and masking state.
2. Send a projected request and collect the reply — L135-167
   Project the transcript, call the client, accumulate usage; a transport
   failure halts the run.
3. Record the turn and branch on its decision — L168-188
   Write the reply to the recorder, then return an answer or prepare to act.
4. Check the budget and execute the calls — L189-233
   Halt on overspend, otherwise dispatch, shape, record and append observations.
5. Detect stagnation, continue, or stop at the ceiling — L234-273
   Compare signatures, halt when stuck, otherwise continue; ceiling error on exit.

Key functions
- run L112-273 — the whole loop; stopping, recording and tool execution
- decide L105-110 — answer-vs-calls rule, reusable by replay
- Limits::spent_usd L62-64 — turns usage into the dollar figure the budget needs
```

This is the layer that was missing from the raw packet. It is not a second function walkthrough: the five operations are module contracts, and `run` remains the detailed function walkthrough in the brief.

## Live result: `reply.rs`

The same derivation works for a parser module:

- role: defines the reply model and turns raw JSON into an answer or tool-call request;
- owns: the two-variant invariant, parsing, derived usage, operator rendering;
- delegates: none, because the module has no local callees;
- operations: accumulate usage, parse a reply, read a reply, render a reply;
- key functions: `Reply::from_json`, `Usage::plus`, `Reply::report`.

The empty delegation list is correct evidence, not a failure: the file uses external crates and stays local.

## What this solves

- **Role and ownership** come from module docs, public surface and call edges, not from generic prose.
- **Delegation** is explicit: the reader can see what the file does not own.
- **Operations** are grouped from call groups and source order, not emitted one per callee.
- **Key functions** are selected by connectivity and entry points, with index-backed ranges.
- The raw packet remains available as evidence; the profile is the human-readable layer.

## Limitations

- Operations are model-grouped; their line ranges need validation against source. The current validator checks range existence, not that the range exactly covers the operation.
- Call groups depend on call hierarchy; trait/`dyn`/generic/macro dispatch can hide edges.
- Delegates only cover local callees; external crates are in dependencies but not assigned concerns.
- Key functions are top-level/method symbols from the index; constructors/getters are not filtered beyond the public surface.
- No rules or function walkthroughs are produced here; those remain the brief layer.
- The profile is not cached or integrated into the extension yet. It is one model call per profile.

## Integration plan

1. Add `ProfileCache` keyed by `fileKey + sourceHash + indexRevision + model + promptVersion`.
2. Add **Derust: Build Module Profile** to open the Markdown profile beside the editor.
3. Feed the cached profile into the brief prompt as a `MODULE PROFILE` section; brief cache keys include the profile revision.
4. Add function summaries and rules as the next layer, not as another module summary.
5. Keep **Show Index Packet** as debug evidence and **Show Module Profile** as the review surface.

## Tests

The pure derivation and validation have tests:

- delegates group local callees and exclude same-file/test callees;
- call groups preserve source function and target module;
- key-function candidates rank entry points;
- validation drops unknown delegates/key functions and invalid operations;
- a profile with too few operations is rejected.

`npm test` currently reports 22 passing tests.
