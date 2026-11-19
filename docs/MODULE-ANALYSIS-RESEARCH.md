# Module analysis: role, operations, and dataflow

**Question.** How can AI produce a module-level role, a set of key operations, and function walkthroughs without reading the whole codebase or literally simulating every call? Does it need a codebase review first? How does it get dataflow?

**Short answer.**

- **It needs a structural review of the repository, not a full read of every file.** Build a shallow, persistent index of the crate/module graph, symbols, references, callers/callees, public surface, tests, and docs. Then send the model a per-file context packet and a one- or two-hop call/dataflow slice.
- **Role comes from the module graph plus public surface, callers/callees, and docs.** You do not need every function body to say what a file owns or what would break if it disappeared.
- **Operations come from entry points and call slices, with function summaries.** An operation is a contract at module altitude: “take a turn”, “act on tool calls”, “stop”. It is not a second walkthrough of one function.
- **Function walkthroughs come from local static facts and callee summaries.** Use MIR or runtime traces for the hard ownership/async/error paths; do not attempt a whole-program simulation for every file.
- **The LLM should synthesize over facts, not invent the facts.** Research on code LLMs shows poor performance at call-graph and dataflow generation; the index and analyzer should own those. The model writes the explanation and the validator checks it against line anchors and graph facts.
- **Use progressive disclosure:** module card → key operations → function walkthroughs → reference. Each layer must add information the next layer does not contain.

## Why not a full codebase review

A full LLM review of a repository is expensive, slow, stale quickly, and dominated by irrelevant code. The useful part is the **structure**:

- which crates and modules exist;
- what is public and what is private;
- which files call which;
- which types and functions cross module boundaries;
- what the tests and docs say.

That is a deterministic index, not a narrative review. Repository-level research points in the same direction:

- Aider's repo map sends a concise map of files and key symbols/signatures, ranked by dependency graph, within a token budget ([Aider](https://aider.chat/docs/repomap.html)).
- RepoGraph, CodexGraph, and Code Graph Model show that repository structure and graph navigation improve repository-level tasks more than raw context alone ([RepoGraph](https://arxiv.org/abs/2410.14684), [CodexGraph](https://arxiv.org/abs/2408.03910), [CGM](https://arxiv.org/abs/2505.16901)).
- AOCI builds a persistent symbolic-semantic index that an LLM can read in one pass, with incremental updates, and reports fewer defects and far fewer tokens than agent exploration ([AOCI](https://arxiv.org/abs/2605.02421)).
- Codebase-Memory builds a persistent Tree-sitter knowledge graph and reports roughly 10× fewer tokens for comparable answer quality ([Codebase-Memory](https://arxiv.org/abs/2603.27277)).
- Code summarization research finds that class/module context improves summaries beyond function context ([Context Matters](https://arxiv.org/abs/2611.18964), [Code Summarization Beyond Function Level](https://arxiv.org/abs/2502.16704)).

A one-time architecture pass can be useful, but it should be a **cached structural profile**, not an LLM read of every file. The per-file analysis can then query that profile.

## What each layer needs

| Layer | Question | Minimum facts | Typical output |
|---|---|---|---|
| Module card | What is this file, and what role does it play? | Crate/module graph, public surface, imports/exports, one-hop callers/callees, module docs, tests | One-sentence identity, ownership boundaries, what it delegates |
| Key operations | How does it achieve that role? | Entry points, call slices, function summaries, data/state movement | 3–5 operation contracts in execution/reading order |
| Function walkthrough | How does each key function work? | Local AST/CFG, types, ownership/borrow facts, callee summaries, error paths | Ordered steps with line anchors, inputs/outputs/effects/errors |
| Reference | What are the pieces? | Symbols, signatures, imports, visibility | Lookup list, no narrative |

The failure mode is using the same facts and the same altitude for two layers. That is why “How it works” and “How the key functions work” currently overlap: both describe the inside of `run`. The first should be an operation map; the second is the implementation.

## How established explainers separate the layers

- **C4** moves context → container → component → code. Each level refines the previous one; a component diagram does not repeat the class implementation ([C4 model](https://c4model.com/)).
- **arc42** separates the building-block view (static responsibilities and dependencies) from the runtime view (sequences of interaction) ([arc42](https://arc42.org/overview)). Module role and function walkthrough are different views, not two summaries of the same view.
- **Diátaxis** separates explanation (why and how it fits), reference (what the pieces are), and how-to (what happens next) ([Diátaxis](https://diataxis.fr/)). Mixing them creates duplication.
- **NL outlines** use progressive disclosure: a statement introduces an idea, then lower-level statements expand it; the expansion does not restate the introduction ([paper](https://arxiv.org/abs/2408.04820)).

The common rule: each level must add information the next level does not contain. If a sentence can be replaced by a sentence in the next section without losing meaning, it belongs at the lower altitude.

## How to get the role

Role is a **module-level claim**:

- What does this file own?
- What does it deliberately leave to other files?
- Who calls it, and what does it call?
- What is its public surface?
- What would break if it were removed?

Build a module context packet from:

1. **Crate graph** — `cargo metadata` for workspace members, targets, dependencies, features.
2. **Module tree** — `mod`/`use` declarations and file layout; `cargo modules structure` can render it.
3. **Public surface** — `pub` items and signatures, preferably from rustdoc JSON rather than regex.
4. **Callers/callees** — rust-analyzer references, definitions, implementations, and call hierarchy. One hop is enough for role; two for operations.
5. **Tests** — `#[test]`, integration tests, examples; they show intended usage and entry points.
6. **Docs** — `//!`, README, DESIGN, Cargo description. These carry domain context the graph cannot.
7. **Runtime evidence, optional** — test names, logs, traces.

The LLM does not need all function bodies to infer role. It needs the boundary facts and the docs. If the module has a clear public API, callers, and callees, a role paragraph can be written from the packet. If it is a binary entry point with no public API, use the entry points and tests.

## How to get operations

An **operation** is a contract the module offers or performs at its own altitude. For `agent.rs`:

- Start a run.
- Take a turn: project, call, record, decide.
- Act on calls: check budget, dispatch tools, shape observations.
- Stop: answer, budget, repetition, ceiling, transport failure.

These are not the internal phases of `run`; they are the module's vocabulary. To discover them:

1. Find entry points/public functions.
2. Take a call slice from each entry point, one or two hops.
3. Summarize each callee as a **function summary**.
4. Group summaries into operations by data and control flow.
5. Give each operation a contract: inputs, outputs, state changes, errors, effects.

The operation map should be terse. If an operation bullet contains a threshold or an error variant, it is already at function altitude; move that detail into the walkthrough.

## What a function summary should contain

A function summary is the scalable alternative to whole-program simulation:

```text
fn run(client, registry, workspace, request, limits, recorder) -> Result<Outcome, Error>
  inputs: borrowed client/registry/workspace; owned request/limits; mutable recorder
  outputs: outcome on answer; typed error on stop
  state: spent, previous_turn, repeats, masking flag
  calls: client.complete, context::project, decide, registry.dispatch, recorder.record
  effects: records events, runs tools, prints one stderr notice
  errors: Client, Log, BudgetExceeded, Stuck, TurnsExceeded
  branches: answer / act / budget / stuck / ceiling / transport
  confidence: static + observed / inferred
```

Summaries can be generated by static analysis and/or an LLM, then cached and invalidated by content hash. Compose them along the call graph to explain an operation. This is abstract interpretation, not literal execution.

## What “simulate the dataflow” should mean

Do not simulate every call instruction. Use the cheapest abstraction that answers the question:

1. **Intraprocedural facts.** AST/CFG for statements and branches; type and name resolution; def-use and liveness where available. For Rust ownership and borrows, MIR is the reliable source; rustc uses MIR dataflow for initialization, liveness, and borrows ([rustc dev guide](https://rustc-dev-guide.rust-lang.org/mir/dataflow.html)).
2. **Function summaries.** Pre/post conditions, state changes, effects, error paths, calls. Compose summaries along the call graph. This is how you narrate a cross-file flow without reading every body.
3. **Demand-driven static analysis.** For a specific question (“does this value move into the call?”, “can this error escape?”), use MIR, rust-analyzer type/borrow info, or a verifier rather than a global simulation.
4. **Dynamic traces.** When the repository has tests or examples, run the specific path under tracing/coverage and capture call order, arguments, returns, and errors. Use this as observed ground truth. Label inferred vs observed claims.
5. **LLM narration.** Give the model the summaries, the slice, and the source lines; ask it to narrate the data and state changes. Validate every line anchor and cross-file fact against the index.

For `run`, you do not need to symbolically execute the whole agent. You need:

- local facts about the loop and state (`spent`, `previous_turn`, `repeats`);
- summaries of `client.complete`, `decide`, `registry.dispatch`, `context::project`, `recorder.record`;
- the order of calls and error paths.

That is enough to explain “one turn” and “how `run` works” without pretending to execute the provider.

## Rust-specific sources of truth

| Need | Source | Notes |
|---|---|---|
| Crate/dependency graph | `cargo metadata` | Stable, cheap; workspace members, targets, features |
| Module tree | `mod`/`use`, `cargo modules structure` | Good for role and boundaries |
| Symbols, references, definitions, implementations, call hierarchy | rust-analyzer LSP | Fast, incremental, semantic; best first index |
| Public API and docs | rustdoc JSON (`--output-format json`, nightly) | Precise signatures and docs; unstable |
| Local dataflow, borrows, liveness | rustc MIR / `ra_ap_mir` | Heavy; use for hard cases, not every file |
| Static call graph | `cargo-call-stack`, rust-analyzer call hierarchy | Incomplete around traits, `dyn`, generics, function pointers |
| Dynamic behavior | `cargo test`, `tracing`, `cargo-llvm-cov`, `tokio-console`, Miri | Observed, partial; excellent for examples |
| Formal contracts | Kani, Creusot, Prusti | Verify specific properties; not a narrative generator |

Rust makes interprocedural analysis harder than the source suggests:

- trait dispatch and `dyn` hide the concrete callee;
- generics monomorphize, so one source function becomes many machine functions;
- macros expand before semantic analysis;
- async functions become state machines;
- ownership and borrows live in MIR, not in the surface AST.

A call graph is therefore an approximation. Use rust-analyzer for semantic navigation, MIR for local precision, and runtime traces when you need observed behavior. Mark confidence instead of claiming completeness.

## Prior art on LLM + program analysis

- **LLMDFA** decomposes dataflow analysis into subtasks and uses LLMs to synthesize queries and outsource precise reasoning to external tools, rather than asking the model to hold the whole dataflow graph in its head ([LLMDFA](https://arxiv.org/abs/2402.10754)).
- **RepoAudit** explores a repository on demand, analyzes dataflow facts along feasible paths within individual functions, and validates claims; it explicitly targets context limits and hallucination ([RepoAudit](https://arxiv.org/abs/2501.18160)).
- **IRIS** combines LLMs with static analysis for whole-repository security reasoning; the LLM infers specifications and context, while static analysis does the graph work ([IRIS](https://arxiv.org/abs/2405.17238)).
- **“Do Code LLMs Do Static Analysis?”** finds that code LLMs perform poorly at call-graph generation, AST generation, and dataflow generation, and that training on those tasks does not transfer to better code intelligence ([paper](https://arxiv.org/abs/2505.12118)). This is the strongest argument against asking the model to infer structure directly.
- **NL Outlines** shows that LLMs can write accurate prose outlines aligned to code, but the outline is a presentation layer over code the model can see; it is not a substitute for a code graph ([paper](https://arxiv.org/abs/2408.04820)).
- **RepoQA** shows that long-context models still struggle to search and understand repositories without structure ([paper](https://arxiv.org/abs/2406.06025)).

The pattern is consistent: **LLM for language and synthesis, static/runtime analysis for structure and facts.**

## Recommended architecture

```text
source
  │
  ▼
Repo index (incremental, deterministic)
  crate graph · module tree · symbols · references · callers/callees
  public surface · signatures · tests · docs
  │
  ├──► Module context packet (target file + 1–2 hops + docs/tests)
  │
  ├──► Function summaries (static + LLM, cached by content hash)
  │
  ├──► Operation graph (entry points → call slices → operations)
  │
  └──► Optional trace adapter (run a targeted test/example, observed facts)
  │
  ▼
Brief writer (LLM)
  module card · key operations · key-function walkthroughs · rules
  │
  ▼
Validator
  line ranges · symbol names · call/relation facts · observed vs inferred labels
```

### Stage 1: Repo index

- Build once per workspace; update incrementally by file content hash.
- rust-analyzer LSP for symbols, references, definitions, implementations, call hierarchy.
- `cargo metadata` for crates/targets/deps.
- Module tree from `mod`/`use`.
- Public surface from rustdoc JSON or LSP.
- Tests/docs map.
- Store the index on disk (SQLite/JSON) so reopening is cheap; do not rebuild the whole world on each file.

### Stage 2: Context packet

For the target file, include:

- file and module path;
- module docs and doc comments;
- symbols with signatures and visibility;
- imports/exports;
- one-hop callers and callees with signatures and one-line docs;
- tests/examples that touch the file;
- Cargo target/dependency context;
- optionally, a ranked repo map (Aider-style) limited to a token budget.

This packet answers role without reading dependency bodies.

### Stage 3: Function summaries

For each function in the target file and each one-hop callee:

- inputs, outputs, state/effects, errors, calls, key branches;
- line anchors;
- confidence: `static`, `runtime`, `inferred`.

Generate summaries lazily. Cache them by function content hash. An LLM can write the prose; static facts fill the signatures, call names, and line ranges. For hard functions, enrich with MIR facts or a trace.

### Stage 4: Operation graph

- Start from public functions/entry points.
- Build a small call graph slice (1–2 hops).
- Group callees into operations by data/control flow.
- Write 3–5 operation contracts.
- Do not write a second walkthrough of the same function here.

### Stage 5: Brief writer and validator

- Give the model the context packet, summaries, operation graph, and selected source lines.
- Ask for a module card, operations, and function walkthroughs.
- Validate:
  - line ranges exist;
  - symbol names and signatures match the index;
  - caller/callee claims are in the graph;
  - every cross-file claim is either indexed or marked inferred;
  - operation bullets contain contracts, not function-internal thresholds.
- Reject or mark claims that cannot be supported.

### Stage 6: Trace adapter (optional, opt-in)

- Run a targeted test/example under tracing or coverage.
- Capture call order, arguments, returns, errors, and side effects.
- Attach “observed” labels to the walkthrough.
- Do not run arbitrary code by default; this is a user-approved action.

## Example: `agent.rs`

**Role packet**

- Public surface: `Limits`, `Outcome`, `Error`, `Decision`, `decide`, `run`.
- Callers: `main.rs` calls `agent::run`; `replay.rs` calls `decide`.
- Callees: `client.complete`, `context::project`, `registry.dispatch`, `recorder.record`.
- Docs: “The loop: call, act, observe, repeat until an answer.”
- Tests/examples: harness entry point.

**Operations**

1. Start a run — record `Start`, seed usage/repeat state.
2. Take a turn — project, call, record, decide.
3. Act on calls — budget, dispatch, shape, observe, signature.
4. Stop — answer, budget, repetition, ceiling, transport failure.

**Function summaries**

- `client.complete` — one provider call, returns `Reply` or `ClientError`.
- `context::project` — wire-only projection; does not mutate the transcript.
- `decide` — `Reply` → `Decision`, total over variants.
- `registry.dispatch` — one tool call → observation; errors become observations.

**Walkthrough**

`run` gets the eight-step detailed treatment. The operation map stays one line per operation. Rules attach to the operation they qualify. No separate “Start reading” and no second flow section.

## What not to do

- Do not ask one LLM call to read the whole repository and infer the call graph.
- Do not claim a complete call graph when traits, `dyn`, generics, macros, or async are involved.
- Do not simulate every call or run full symbolic execution for a narrative.
- Do not treat the operation map as a second function walkthrough.
- Do not upload the whole repository to a provider when a local index and a small packet suffice.
- Do not hide uncertainty: label inferred relations.

## Evaluation plan

Measure the things the feature is supposed to improve:

1. **Role accuracy** — does the module card match what callers/docs/tests imply?
2. **Operation coverage** — are the 3–5 operations the ones a maintainer would name?
3. **Walkthrough factuality** — are call names, data moves, errors, and line anchors correct?
4. **Cross-file precision** — are caller/callee claims supported by the index?
5. **Inference discipline** — are unsupported claims labeled or omitted?
6. **Cost/latency** — index build, packet size, summary cache hit rate, model tokens.
7. **Human usefulness** — can a reader answer “what is this, what does it do, where do I start?” without scrolling the code?

Compare three baselines: raw file only, file + one-hop context, and full repo map. The expected winner is file + structured one-hop context + summaries, not the largest context.

## Recommended spike sequence

1. **Index spike**: one crate, rust-analyzer LSP + `cargo metadata`; export module tree, symbols, callers/callees, public surface, tests/docs as JSON.
2. **Role spike**: generate module cards for 5 files from the packet alone; compare against a human-written role.
3. **Summary spike**: generate 2–3 function summaries per file; validate signatures/calls/line ranges; cache.
4. **Operation spike**: compose summaries into 3–5 operations; check that it does not duplicate the function walkthrough.
5. **Dataflow spike**: for `run` and `Reply::from_json`, add MIR facts or a trace; compare inferred vs observed claims.
6. **Evaluation**: factuality, coverage, tokens, latency; decide whether an architecture profile is needed.

## Open decisions

- **Index source:** rust-analyzer LSP first; tree-sitter fallback for non-workspace files; MIR only for targeted questions.
- **Summary generation:** static-only vs LLM-assisted. LLM-assisted summaries are likely better prose and cheaper than full source, but need validation.
- **Trace adapter:** opt-in per workspace or per analysis; running code is a security and reproducibility decision.
- **Architecture profile:** a cached module-role profile is useful for cross-module context; it should be deterministic + docs first, LLM only for synthesis.
- **Context budget:** how much one-hop context and how many callee summaries before the model loses focus.

## Bottom line

- Build a **structural index**, not a full LLM review.
- Derive **role** from the module graph, public surface, one-hop callers/callees, tests, and docs.
- Derive **operations** from entry points and call slices, using cached function summaries.
- Derive **function walkthroughs** from local static facts plus callee summaries; use MIR or traces only for the hard cases.
- Treat “simulation” as **summary composition and targeted observation**, not a whole-program execution.
- Let the LLM write the explanation; let the analyzer own the facts and the validator enforce them.

## Sources

- Aider repository map — <https://aider.chat/docs/repomap.html>
- RepoGraph — <https://arxiv.org/abs/2410.14684>
- CodexGraph — <https://arxiv.org/abs/2408.03910>
- Code Graph Model (CGM) — <https://arxiv.org/abs/2505.16901>
- AOCI symbolic-semantic indexing — <https://arxiv.org/abs/2605.02421>
- Codebase-Memory — <https://arxiv.org/abs/2603.27277>
- RepoAudit — <https://arxiv.org/abs/2501.18160>
- LLMDFA — <https://arxiv.org/abs/2402.10754>
- IRIS — <https://arxiv.org/abs/2405.17238>
- Do Code LLMs Do Static Analysis? — <https://arxiv.org/abs/2505.12118>
- Context Matters: Hierarchical Code Summarization — <https://arxiv.org/abs/2611.18964>
- Code Summarization Beyond Function Level — <https://arxiv.org/abs/2502.16704>
- RepoQA — <https://arxiv.org/abs/2406.06025>
- Natural Language Outlines for Code — <https://arxiv.org/abs/2408.04820>
- rust-analyzer architecture — <https://rust-analyzer.github.io/book/contributing/architecture.html>
- rustc MIR dataflow — <https://rustc-dev-guide.rust-lang.org/mir/dataflow.html>
- SCIP code indexing — <https://sourcegraph.com/blog/announcing-scip>
- Joern code property graph — <https://joern.io/>
- Kani — <https://model-checking.github.io/kani/>
- Creusot — <https://creusot.rs/>
- cargo-modules — <https://github.com/regexident/cargo-modules>
- cargo-call-stack — <https://github.com/rust-secure-code/cargo-call-stack>
- cargo metadata — <https://doc.rust-lang.org/cargo/commands/cargo-metadata.html>
- rustdoc JSON — <https://doc.rust-lang.org/nightly/rustdoc/unstable-features.html#json-output>
