# Structural index spike

**Question.** Can we build a cheap, deterministic repository index that gives the brief writer a module card and a one-hop call context, without a full LLM review of the codebase?

**Result.** Yes. A standalone Node spike using rust-analyzer's LSP and `cargo metadata` indexed the `harness` crate in about 9 seconds:

- 28 Rust files
- 580 symbols
- 1,080 references
- 183 call-hierarchy edges
- a 460 KB JSON index
- a 4 KB per-file role packet for `src/agent.rs`

The standalone prototype is [scripts/index-spike.js](../scripts/index-spike.js). The extension now has its own [IndexService](../src/indexService.ts), which uses VS Code's running rust-analyzer rather than spawning another LSP process.

```bash
cd /path/to/derust
npm run index:spike
```

Outputs:

- `out/index-harness.json`
- `out/index-agent-packet.md`
- `out/index-cache/<workspace-hash>.json`

The second run reuses the cache instead of starting rust-analyzer; it completes in about 0.08 seconds. `--force` rebuilds from scratch, and `INDEX_OUT_DIR` can redirect the output for testing.

## What the index contains

```text
workspace
  crate metadata
    package name/version
    targets and source paths
    dependencies
  modules[]
    path, module path, module docs
    symbols[]
      name, kind, start/end, selection
      visibility, signature, doc, test
    tests[]
  references[]
    symbol → file:line
  calls[]
    direction (incoming/outgoing)
    source/target name and file/line
```

The current spike stores the full index as JSON. A production version should use an incremental store keyed by file content hash, but the shape is already useful.

## The role packet

For `src/agent.rs`, the packet contains:

- crate and module coordinates;
- the `//!` module docs;
- the public surface with signatures and line ranges;
- the file's imports;
- outgoing calls (what the file calls);
- incoming calls (who calls the file);
- test functions that call into the file;
- references to public symbols, capped for readability;
- crate dependencies.

The important sections are small. The full reference list is large, but the role packet only needs the boundary facts:

```text
Crate: harness 0.1.0
Module: crate::agent

Public surface:
  struct Limits L33-46
  method Limits::spent_usd L62-64
  struct Outcome L68-72
  enum Error L75-90
  enum Decision L95-103
  function decide L105-110
  function run L112-273

Calls out:
  run → complete (src/client.rs:107)
  run → project (src/context.rs:78)
  run → decide (src/agent.rs:105)
  run → dispatch (src/tool.rs:171)
  run → record (src/log.rs:32)

Calls in:
  run → run (src/main.rs:202)
  replay → decide (src/replay.rs:105)
  a_run_stops_when_it_overspends → run (tests/agent.rs:259)
```

That is enough to write a credible role paragraph:

> `agent.rs` is the turn engine. It owns the stop rules and the order of operations. Provider I/O lives in `client.rs`, tool execution in `tool.rs`, and context projection in `context.rs`. It is called by `main.rs` and by the agent tests.

The model does not need to read `client.rs`, `tool.rs`, or `context.rs` to say that. It needs the edges and the public surface.

## Persistence

The spike now stores a cache keyed by the workspace path:

- `fileHashes` records a SHA-256 per source file.
- `revision` is a hash of the sorted file:hash list.
- A run with an unchanged revision skips rust-analyzer entirely and only regenerates the packet.
- A run with a changed revision reuses the cached symbol/module data for every unchanged file and re-parses only the changed files.
- References and call edges are rebuilt for the new revision. They are not yet invalidated per symbol; that is the next optimization.

Measured on the harness:

- first build: 9.0 seconds, 28 files, 580 symbols, 1,080 references, 183 call edges
- unchanged reopen: 0.08 seconds, cache hit, no rust-analyzer process
- one file changed: 1 file re-parsed, 27 files reused, edges rebuilt, 8.9 seconds

The 8-second semantic wait dominates the changed-file run. A production version should wait on rust-analyzer progress/status instead of a fixed sleep.

## What worked

- **rust-analyzer LSP is enough for the structural layer.** `textDocument/documentSymbol`, `textDocument/references`, `textDocument/prepareCallHierarchy`, `callHierarchy/incomingCalls`, and `callHierarchy/outgoingCalls` all returned useful data.
- **`cargo metadata` gives the crate context cheaply.** Package name, targets, and dependencies are one command.
- **Document symbols include nested methods.** Flattening `impl` children with qualified names gives `Limits::spent_usd`, `Reply::from_json`, and so on.
- **Tests are discoverable without a separate test parser.** Incoming calls from `tests/` identify the test functions that touch the file. The symbol test flag also catches `#[test]`/`#[tokio::test]` inside a file.
- **The packet is small.** The per-file role packet is a few KB even when the full index is hundreds of KB.

## Problems found and fixed in the spike

- **DocumentSymbol ranges start at attributes.** For `#[derive]` items, the range starts on the attribute line, which made visibility and signatures wrong. Using `selectionRange` for the item start fixed public detection and signatures.
- **Visibility must read from column zero.** Using the selection column cut off `pub` and marked public items private.
- **Semantic requests need indexing time.** Document symbols are syntax-backed and return immediately; references and call hierarchy return empty until analysis is ready. The spike waits 8 seconds after opening the files. A production version should wait on `$/progress` or an analyzer-status signal, not a fixed sleep.
- **CallHierarchyItem names are unqualified.** `input`, `output`, `text`, and `calls` are ambiguous without the container. The index keeps the file and line; the next version should include `detail`/container names and resolve the caller/callee identity by URI + range, not name alone.
- **References are noisy.** 1,080 references include same-file uses and test uses. The packet caps the list; a production packet should rank external references and separate tests from production callers.
- **Development dependencies can duplicate normal dependencies.** Deduplicate by crate name and kind.

## Limitations of this spike

- No incremental cache; every run rebuilds the index.
- No on-disk SQLite/JSON store yet; the output is a full JSON snapshot.
- No cross-crate indexing; only the workspace crate and its files.
- No trait/`dyn`/generic/macro resolution beyond what rust-analyzer's call hierarchy exposes.
- No dataflow or MIR facts; this is a call/reference graph, not a dataflow graph.
- No function summaries or operation graph yet.
- The module path is a path heuristic (`src/foo.rs` → `crate::foo`), not a full module tree from `mod` declarations and Cargo targets.
- The role packet uses all incoming/outgoing edges; ranking and budget limits are future work.

## What this proves for the architecture

- **No full codebase review is needed.** The role packet comes from the graph, public surface, docs, and tests.
- **The index should be deterministic and local.** rust-analyzer already owns Rust semantics; the LLM should not re-derive them.
- **A one-hop packet is enough for the module card.** Two hops and function summaries are the next layer for operations.
- **The index is cheap on a small crate.** Nine seconds for 28 files is acceptable as a background build. A larger workspace needs incremental updates and persistence.

## Next steps

1. **Persist the index incrementally.** Store symbols, references, and call edges by file content hash in SQLite or a compact JSON store. Rebuild only changed files and their one-hop neighbors.
2. **Add a real module tree.** Parse `mod` declarations and Cargo targets instead of relying on file paths.
3. **Build a context-packet service.** For a target file, select public surface, imports, ranked callers/callees, tests, and docs under a token budget.
4. **Generate function summaries.** For each target function and one-hop callee, produce inputs, outputs, effects, errors, calls, and confidence; cache by content hash.
5. **Add an operation graph.** Group entry points and summaries into 3–5 operations. This is the layer that replaces the current overlap between “How it works” and the function walkthrough.
6. **Add targeted dataflow.** Start with MIR for local ownership/borrow facts on selected functions; add runtime traces only where tests/examples exist.
7. **Integrate.** Expose the index as a VS Code service and feed the packet to the brief writer; keep the JSON spike as the evaluation harness.

## Extension integration

`src/indexService.ts` ports the index into the extension:

- it uses `vscode.executeDocumentSymbolProvider` and the built-in call-hierarchy commands through the language server already running in VS Code;
- it persists modules, file hashes, revision, and per-target relations under `globalStorage/derust-index/<workspace-hash>/index.json`;
- it computes a module packet with public surface, imports, callers, callees, tests, and crate dependencies;
- `explainFile` includes that packet in the brief prompt as `MODULE CONTEXT`;
- `Derust: Rebuild Workspace Index` forces a fresh build;
- the brief cache key includes the index revision, so a changed caller graph regenerates the brief rather than reusing a stale role.

Current limitations of the extension port:

- relations are cached per target file, not per symbol; a workspace revision change rebuilds the target's relations;
- call hierarchy is an approximation for trait/`dyn`/generic/macro dispatch;
- the module tree is still derived from file paths;
- function summaries and operation graphs are not in this integration yet.

## Verdict

The structural index is viable and cheap enough to be the first stage of the analysis pipeline. It gives the model what it needs to write the module card without reading the repository, and it leaves the expensive semantic work — function summaries and dataflow — for targeted, cacheable steps.
