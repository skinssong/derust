# File-level overview: research and design

**Question.** When a Rust file opens, can the reader show a short, high-level orientation — what the file is for, its key constructs and behaviors, and how it relates to other files — without a model call on every open and without duplicating VS Code's Outline?

**Status.** The deterministic layer described under "Spike 1" shipped in v0.4.0. The AI brief described under "Spike 2" shipped in v0.5.0: one model call per file content, cached, with mechanism-first wording and key-function walkthroughs. The tone research behind its prompt is in [`OVERVIEW-TONE.md`](OVERVIEW-TONE.md).

**Implementation note.** Opening the Overview from the line-0 glance or the `Show File Overview` command generates the brief when it is missing; `derust.briefOnOverview` turns that off and leaves the `Explain this file` button. `Open Panel` and following the active file do not start a model call, so the structural overview remains the zero-cost default everywhere else. The panel does not render the source module-doc block; those docs remain input to the brief and are replaced by its role and purpose. The glance therefore shows construct and import counts rather than the first module-doc sentence. Parallel rules and stop conditions are nested as bullets under the How it works step whose line range contains them; unmapped rules fall back to an "Other rules and edge cases" section. There is no separate constraints or invariants section. On the Overview lens, panel clicks scroll the editor but editor scrolling and cursor movement do not scroll the panel, so the panel stays in control. The separate Start reading section was removed; the How it works order and its line links are the reading order. Briefs are looked up across workspace cache directories by file content; a prompt-version or source mismatch is shown stale instead of disappearing, and startup restore can reopen a cached brief even when no full analysis exists.

## Bottom line

- The market has **structural maps** (Mole, Terrain, Visual Code Map) and **AI file summaries** (CodeFunc, chat assistants), but almost nothing combines deterministic, cross-file structure with a short LLM narrative that is anchored to lines and cached per file. That is the gap.
- The least intrusive on-open surface is a **single line-0 CodeLens glance**, not an auto-opened panel. CodeFunc validates this pattern. The rich detail belongs in a new first panel tab called **Overview**.
- Build it in two layers: an **instant deterministic overview** (module docs, symbols, imports, references) and an **optional AI brief** (purpose, 4–7 prose steps, key constructs, reading path). Cache the brief; do not call the model on open by default.
- Rust gives us a head start: `//!` module docs, `pub` visibility, the `mod` tree, and `Cargo.toml` are already a file-level outline. The tool should surface that structure first, then translate it for a reader who does not know Rust.

## What exists

Install counts are from the VS Code Marketplace on 2026-11-17. They are a demand signal, not a quality signal; several of these are very new.

| Tool | Surface | Scope | How it gets facts | AI | Gap for us |
|---|---|---|---|---|---|
| **Mole: Code Map** (`raychu23.mole-code-map`, 1 install) | Panel beside code | File + one-hop relations | TypeScript compiler, SQLite index | No | TypeScript/TSX only; defines/calls/imports, no purpose or behavior |
| **CodeFunc - File Overview** (`TanvirSdq.codefunc-vscode`, 5 installs) | Line-0 CodeLens + side panel | File | `web-tree-sitter` AST skeleton, provider API | Yes (Gemini, Groq, OpenRouter) | AGPLv3; architecture-level, no Rust semantics or ownership; tiny install base |
| **CodeViz** (`CodeViz.codeviz`, ~89k installs) | Codebase map | Repository | LLM + static analysis | Yes | Codebase-level, not a per-file on-open surface |
| **Terrain Code Map** (`gigi-didberidze.terrain`, 3 installs) | Codebase map | Repository | Deterministic offline analysis | No | Nested rectangles and lenses, no narrative |
| **Visual Code Map** (`prawal-sharma.visual-code-map`, ~1.1k installs) | Dependency graph | Repository | JS/TS analysis | No | JS/TS only; no file meaning |
| **Code Outline** (`patrys.vscode-code-outline`, ~103k installs) | Symbol tree | File | LSP/document symbols | No | Names and nesting only |
| **Aider repo map** | LLM context | Repository | tree-sitter symbols + dependency graph ranking | No UI | Not a reader surface; excellent context-selection technique |
| **Repomix** | LLM context | Repository | tree-sitter code compression | No UI | Packs repos for models; no reading UI |
| **NL Outlines** (arXiv 2408.04820) | Research prototype | File | LLM-generated natural-language statements | Yes | Not a product; validates the prose-outline idea |
| **DeepWiki / DeepWiki-open** | Wiki | Repository | LLM | Yes | Repo-level docs, not file-level on open |
| **AI chat assistants** (Copilot, Claude Code, Cody, Continue) | Chat | Selection/file/repo | LLM | Yes | Transient answers; no persistent, cached, line-anchored file overview |

### The closest two

**Mole** is the closest structural interface. It opens a panel beside the code and shows the file's **defines, called by, calls, imported by, and imports**. Clicking a box jumps to the line. It follows the active editor, caps lists at 25 boxes (`+N more`), indexes locally, makes no network requests, and runs no AI. It is a good model for the deterministic half of our feature: fast, local, one-hop, and capped. Its limits are also instructive: TypeScript only, no purpose, no behavior, no Rust ownership or traits.

**CodeFunc** is the closest on-open interface. It places a **CodeLens glance at line 0**:

```text
🔍 Role: Docker container build based on python:3.10-slim
📦 Uses: python:3.10-slim
💾 I/O: Exposes port 8000
[📖 Detailed Overview] [⚡ Refresh]
```

Clicking opens a side panel with a longer architectural overview. Its 2.0 release introduced **AST semantic skeletons**: `web-tree-sitter` strips function bodies and sends only imports, signatures, and docstrings, which it claims cuts tokens by up to 95%. It caches by the **AST skeleton hash**, so editing a variable name or a function body does not trigger a refetch. It supports Rust, along with Python, TypeScript, Go, Java, C, C++, C#, and infrastructure files. It has an offline heuristic fallback.

That is very close to the user's request. Two differences matter:

1. CodeFunc's glance is **architectural** (role, uses, I/O), not a reading guide. It does not tell you the order in which to read the file, nor which Rust constructs carry the meaning.
2. Its skeleton is optimized for token cost, but a skeleton alone cannot explain **behavior**. Behavior lives in function bodies. Our brief should use the full file when it fits, and fall back to a skeleton plus selected bodies for long files.

CodeFunc is **AGPLv3**. Do not copy its code. Its ideas — line-0 glance, AST skeleton, skeleton-hash cache — are fair to learn from and independently implement.

## What the prior art teaches

1. **Deterministic structure is instant and trustworthy.** Mole, Terrain, Code Outline, and Visual Code Map all work without a model. A file's symbols, imports, and references are facts. The overview should show those facts immediately and never let the model invent them.
2. **Zero-click beats a panel for orientation.** CodeFunc puts the first answer at line 0, where the eye already is, and keeps the side panel for depth. Auto-opening a panel on every file is more intrusive than a one-line glance.
3. **Compress before you send.** CodeFunc's skeleton, Aider's repo map, and Repomix all select signatures and structure instead of whole files. For cross-file context, send module docs and signatures, not dependency bodies.
4. **A prose outline is a navigation device, not just a summary.** The NL Outlines paper partitions code into short natural-language statements that correspond to code regions, and supports bidirectional synchronization between code and outline. That is a better model than a generic "this file does X" paragraph: each statement can link to a line range, so the overview doubles as a table of contents.
5. **Cap and rank.** Mole caps at 25 boxes; Aider enforces a token budget; Terrain uses lenses to choose what matters. Our overview needs hard caps: one role sentence, at most four sentences of purpose, 4–7 outline steps, 3–6 key constructs, 8 relations, and 5 reading links.
6. **Cache by content, but be careful with line anchors.** CodeFunc's skeleton hash is clever for cost, but our outline will link to line ranges. If function bodies change, line numbers shift even when the skeleton is unchanged. Use the full source hash for exact cache hits unless anchors are re-matched against quoted snippets.

## Recommended product shape

### 1. A glance at line 0

Register a `CodeLensProvider` for Rust files that emits one lens on line 0. It does not modify the file. It is clickable and supports ThemeIcons.

With a cached brief:

```text
$(book) Role: Runs the agent loop and its stop rules · 6 constructs · 10 imports
```

Without a brief:

```text
$(list-tree) 6 constructs · 10 imports · 2 used by · [Overview]
```

Clicking the lens runs `derust.showOverview`, which opens the panel on the Overview tab. The glance is computed from the document text and symbols, so it can render before the model is involved. If symbols are not ready yet, render the text-only counts first and update via `onDidChangeCodeLenses`.

The alternative — auto-opening the panel — should exist as a setting but not be the default. It steals editor space and competes with the code. CodeFunc's line-0 lens is the better default.

### 2. An Overview tab, first in the panel

The panel had three tabs: Spotlights, Ownership, Constraints. We added **Overview** before Spotlights. It is a single readable column, not the four-column spotlight layout. The Constraints tab was later removed; the analysis no longer emits constraint points, and the brief rules are the maintained conditions.

```text
┌ Overview ──────────────────────────────────────────────┐
│ agent.rs · src/agent.rs · 260 lines · brief cached     │
│ Runs the agent loop: call, act, observe, repeat, stop. │
│ [Refresh brief]  [Analyze this file]                   │
├ What happens ──────────────────────────────────────────┤
│ 1  Limits defines three stop rules…            L33–L46 │
│ 2  run records Start before the first call…   L112–127 │
│ 3  Each turn projects the context…            L135–148 │
│ 4  A transport error ends the run…            L150–165 │
│ 5  Budget is checked before tools run…        L188–208 │
│ 6  Tool results are shaped and fed back…      L210–258 │
├ Key constructs ────────────────────────────────────────┤
│ struct Limits   L33   max turns, budget, stuck rule…   │
│ enum Decision   L95   answer or act, separated from…   │
│ fn run          L112  the async turn engine…           │
├ Relations ─────────────────────────────────────────────┤
│ Uses: client, config, context, event, log, reply…      │
│ Used by: main.rs (likely entry point)                  │
├ Start reading ─────────────────────────────────────────┤
│ Module docs L1 · Limits L33 · decide L105 · run L112   │
├ Rust notes ────────────────────────────────────────────┤
│ thiserror derive + #[from] L74 · &mut dyn Recorder L118│
│ [Open these in Spotlights]                             │
└────────────────────────────────────────────────────────┘
```

Sections:

- **Role and purpose.** One sentence for the glance, two to four sentences for the tab. Say what the file is responsible for and what it explicitly does not own.
- **What happens.** 4–7 prose statements in reading order, each anchored to a line range. This is the NL-outline idea. Each statement says what changes, what rule is enforced, or why the code is ordered that way. Clicking reveals the range.
- **Key constructs.** 3–6 types, traits, impls, or functions. Each row: name, kind, line, signature, and one sentence on why it exists. This is where Rust-specific meaning belongs: a trait bound, an enum that models a decision, an `Option` that encodes absence, a `dyn` object that erases a concrete recorder.
- **Relations.** Direct local modules used, external crates, and files/symbols that reference this file's public items. Show paths as links. Mark "used by" as approximate.
- **Start reading.** 3–5 line links in a sensible order, often starting with `//!` module docs.
- **Rust notes.** Only when present: traits/generics, async, `Result`/`?`, lifetimes, `dyn`, macros/derives, `unsafe`. Link to the existing Spotlights lens instead of duplicating explanations.

Do not put code blocks in the overview beyond short signatures. The code is already beside the panel.

### 3. Example output for `harness/src/agent.rs`

This is a hand-written example of the target shape, using the current file. It is not model output.

**Role.** Runs the agent loop: call the model, act on tool calls, record every turn, and stop on an answer, a budget, or a repeated call.

**Purpose.** This file is the turn engine. It owns the stopping rules and the order of operations. Provider I/O lives in `client.rs`, tool execution in `tool.rs`, and conversation projection in `context.rs`.

**What happens**

1. `Limits` (L33–L46, with the `Default` and `Limits` impl blocks at L48–L65) defines three ways to stop: a ceiling on model calls, an optional dollar budget, and a repeated-call rule. `Prices` is optional because a budget cannot be computed without per-token prices.
2. `run` records a `Start` event before the first model call (L112–L127), so a run that dies mid-tool still leaves a trace.
3. Each turn projects the conversation to fit the context policy (L135–L148). Older tool results are masked on the wire only; the recorded transcript keeps every byte.
4. The model call is the only place a transport error ends the run (L150–L165). It records `Halt::Transport` before returning, so replay can distinguish a provider failure from a truncated file.
5. `decide` turns a reply into either an answer or a set of tool calls (L105–L110). `run` records the reply before acting on it (L169–L188).
6. The budget is checked before tools run (L188–L208), so crossing the cap stops the turn without side effects. An answer that crossed the cap is still returned because it was already paid for.
7. Tool calls are dispatched one by one, shaped to a byte limit, recorded, and fed back as observations (L210–L258). A repeated call/result signature triggers the stuck stop.

**Key constructs**

| Construct | Line | Why it exists |
|---|---|---|
| `struct Limits` | L33 | Groups the three independent stop conditions plus the context policy. |
| `enum Decision` | L95 | Separates what a reply means from how it was obtained, so replay can judge a recorded reply with the same function. |
| `fn decide` | L105 | Converts the provider's `Reply` enum into `Answer` or `Act`; the only place that interpretation lives. |
| `fn run` | L112 | The async turn engine: project, call, record, decide, check budget, act, repeat. |
| `enum Error` | L75 | Typed stop reasons; `thiserror` and `#[from]` turn client/log errors into one error type. |

**Relations.** Uses `client`, `config`, `context`, `event`, `log`, `message`, `reply`, `request`, `tool`, `workspace`. Used by `main.rs` and `replay.rs` (computed from references; approximate).

**Start reading.** Module docs L1 → `Limits` L33 → `decide` L105 → `run` L112 → `Error` L75.

**Rust notes.** `#[derive(Debug, thiserror::Error)]` with `#[from]` conversions (L74–L90); `Result<Outcome, Error>` (L119); `&mut dyn Recorder` (L118); `Option<f64>` for the optional budget (L38). Open these in Spotlights.

This is the level of detail that answers "what is this file about?" without turning into a line-by-line explanation.

## On-open behavior

Recommended sequence:

1. A Rust file becomes active. The CodeLens provider computes the structural summary from the text: module docs, top-level symbols, imports, line count. It renders the glance. **No network.**
2. If a cached brief exists for the current source hash, use its role in the glance. The Overview tab is ready immediately.
3. If no brief exists, the glance uses a structural fallback ("6 constructs · 10 imports"). The Overview tab shows the deterministic skeleton and a single **Explain this file** button. **No model call.**
4. Clicking Explain generates one brief, caches it, and fills the tab. If `derust.briefOnOpen` is `auto`, step 3 generates automatically with a progress indicator and cancellation on file switch.
5. When the source changes, the structural parts update on save. The brief is marked **stale** and offers Refresh. It is not regenerated on every keystroke.
6. The full **Analyze** command remains separate. It produces Spotlights, Ownership, and the memory model. The brief does not wait for it, and the full analysis does not need to repeat the overview.

If the panel is already open and the user switches to another Rust file, show that file's Overview tab. If they switch back, returning to the last tab they used for that file is a nice touch but not required for v1.

Settings:

- `derust.overviewOnOpen`: `glance` (default) | `panel` | `off`.
- `derust.briefOnOpen`: `cached` (default) | `auto` | `off`.
- `derust.overviewUsedBy`: boolean, default `true`, lazy reference search.
- `derust.overviewMaxContextChars`: number, default 30000; larger files use a skeleton.

`cached` is the safe default: orientation is one line immediately, and the AI brief is one click away. `auto` is the "zero-click magic" mode CodeFunc offers, but it spends a model call on every newly opened file, so it should be opt-in.

## Two layers of data

### Deterministic layer (always current)

- **Module docs.** Read the leading `//!` block. In Rust, this is often the best one-paragraph explanation of the file. Use it as the source of truth and show it first, not buried in a tooltip.
- **Symbols.** Use `vscode.executeDocumentSymbolProvider` to get top-level structs, enums, traits, impls, functions, consts, types, and macros, with ranges. rust-analyzer already parses the file, so prefer the provider over regex. If no provider is available, fall back to a lightweight top-level signature scan; the overview should still render, just with less precise ranges.
- **Imports and modules.** Parse `use` statements and `mod` declarations. For a `use crate::foo::Bar`, resolve the target with `vscode.executeDefinitionProvider` at the path position; for `mod foo;`, resolve `foo.rs` or `foo/mod.rs`. Cap at 12 local modules. External crates are names only.
- **Used by.** For public top-level symbols, call `vscode.executeReferenceProvider` at the symbol position. Filter declarations, dedupe, group by file, cap at 8 files. Skip symbols with hundreds of references: a central utility's reference list is noise, not orientation. Do this lazily when the Overview tab opens, not on every file open.
- **Crate and targets.** Read the nearest `Cargo.toml` for the package name and dependencies. Do not read dependency source.
- **Line count and symbol counts.** Cheap and useful for the glance.

Call hierarchy is available through `vscode.prepareCallHierarchy`, `vscode.provideIncomingCalls`, and `vscode.provideOutgoingCalls`, but it is not needed for v1. Direct references and imports already answer "what does this file depend on?" A full call graph is Mole/CodeViz territory and gets noisy fast.

### AI layer (cached, optional)

The brief adds meaning the structure cannot: why the file is organized this way, which construct carries the design, and the order a reader should follow. It should be generated from:

- the full file, when it fits the input cap;
- the `//!` module docs and doc comments;
- the symbol skeleton (signatures only for long files);
- the list of direct local imports and external crates;
- signatures and module docs of direct local dependencies, capped at roughly 6 KB;
- the deterministic "used by" list, if available.

It should **not** receive whole dependency files, the whole repository, or a global call graph. Aider's repo map and Repomix both show that selected signatures and structure are enough for a model to reason about relationships; sending more mostly adds cost and distraction.

For a file larger than `overviewMaxContextChars`, build a skeleton: imports, module docs, symbol signatures, and the bodies of the top public functions only. CodeFunc's AST skeleton is the reference implementation of this idea. Rust files in this project are small enough that the full file is usually the better trade.

## Data contract

Keep the brief separate from the full `Analysis` contract. It has a different job, a different prompt, and a different cache.

```ts
export type FileBrief = {
  version: 1;
  file: string;              // workspace-relative path
  sourceHash: string;
  model: string;
  generatedAt: string;
  role: string;              // one sentence, <= 140 chars
  purpose: string;           // 2-4 sentences, <= 600 chars
  outline: Array<{
    text: string;            // 1-2 sentences, reading order
    startLine: number;       // 1-based, inclusive
    endLine: number;
    constructs?: string[];   // names from keyConstructs
  }>;
  keyConstructs: Array<{
    name: string;
    kind: 'struct' | 'enum' | 'trait' | 'impl' | 'fn' | 'const' | 'type' | 'macro';
    line: number;
    signature?: string;      // copied from source, not invented
    why: string;             // one sentence
  }>;
  uses: Array<{
    path: string;            // local file or crate name
    symbols?: string[];
    external?: boolean;
  }>;
  usedBy: Array<{
    path: string;
    symbols?: string[];
  }>;
  readingPath: Array<{
    label: string;
    line: number;
  }>;
  rustNotes?: string[];      // short pointers to Spotlights
};
```

The structural overview can be a plain runtime object; it does not need to be persisted:

```ts
export type StructuralOverview = {
  file: string;
  modulePath?: string;
  moduleDoc?: string;
  crateName?: string;
  lineCount: number;
  symbols: Array<{ name: string; kind: string; line: number; signature?: string; doc?: string }>;
  imports: Array<{ path: string; symbols?: string[]; external?: boolean }>;
  usedBy: Array<{ path: string; symbols?: string[] }>;
};
```

## Prompt rules

The brief prompt should be strict and short:

- Write for a programmer who knows other languages but not Rust.
- Use the file's own names. Never write "this file defines…" without naming the thing.
- Explain what the file is responsible for and what it deliberately leaves to other files.
- Give 4–7 steps in reading order. Each step must say what changes, what rule is enforced, or why the order matters. Anchor each step to a line range that exists.
- Give 3–6 key constructs. Say why each exists, not just what kind it is.
- Explain a Rust construct only when it changes the meaning: `Result`/`?`, `Option`, lifetimes, `dyn`, trait bounds, `#[derive]`, async, `unsafe`.
- Use only the provided imports, references, and dependency signatures for cross-file claims. If a relation is not in the provided data, omit it.
- Do not restate the module docs verbatim. Translate them for a reader who does not know the language.
- No line-by-line walkthrough. No code blocks except short signatures.
- Return JSON only.

Recommended output budget: 2048 tokens; `reasoning_effort: none` or `low`; JSON mode if the provider supports it. The full analysis uses a much larger budget because it emits spotlights and memory models. The brief is a different, smaller job.

## Validation

The validator is the safety net. The model must not be allowed to turn a fluent guess into a fact.

- **Line ranges.** Every `startLine`/`endLine` must be within the file. Drop invalid outline steps. If fewer than three valid steps remain, fall back to the structural overview.
- **Ordering.** Sort steps by `startLine`. Reject steps that run backwards unless the text explicitly describes a return to an earlier region.
- **Constructs.** Match `keyConstructs[].name` against the document symbols. Take the line and signature from the symbol, not the model. Drop unknown names. If fewer than three remain, keep the structural symbol list.
- **Relations.** Intersect `uses` and `usedBy` with the deterministic sets. Drop paths the model invented. Never let the model add a file that the import/reference scan did not find.
- **Reading path.** Keep only valid lines. If fewer than three remain, derive links from the outline starts.
- **Length.** Cap `role` at 140 characters, `purpose` at 600, each outline step at 220, each `why` at 180. Strip markdown headings and HTML. The panel renders through safe DOM, but short text is also better UI.
- **Signatures.** Normalize whitespace and verify the signature appears in the source. If it does not, omit the signature rather than showing a plausible invention.

If the provider returns unparseable JSON or an empty message, show the structural overview and an error with a Retry button. The overview must remain useful without the model.

## Cache and cost

- Store briefs under the extension's global storage, keyed by workspace and file path, with `sourceHash`, `promptVersion`, `model`, and `generatedAt`.
- A brief is fresh only when `sourceHash`, `promptVersion`, and `model` all match. Otherwise show the last brief with a **stale** badge and a Refresh action.
- Do not regenerate on save. Debounce structural updates; regenerate only on explicit Refresh, on `briefOnOpen: auto`, or when the user runs Analyze if you choose to fold the brief into that flow later.
- One in-flight brief per file. Cancel when the active file changes. Reuse the existing `AbortController` pattern.
- CodeFunc caches by AST skeleton hash so body edits do not refetch. That is a good cost optimization, but our outline is line-anchored. A body edit can shift every line after it, making the anchors wrong even if the architecture is unchanged. Use the source hash for exact hits. If you later quote-match anchors, a skeleton-hash hit can be shown with a "structure unchanged; line links may have moved" warning.
- Cost is roughly one file's worth of input plus about 1k output tokens per content version. That is materially cheaper than the full analysis, which emits spotlights, ownership traces, and memory models. The brief is worth a separate call because it is fast enough to answer an orientation question; the full analysis is not.

## Cross-file context

The user said the overview "maybe depends on other files." Handle that in two levels, and be explicit about the limit:

**Facts (deterministic):**

- Direct local modules from `use`/`mod`, resolved to files.
- External crates from `use` and `Cargo.toml`.
- Files that reference this file's public symbols, from the reference provider.
- Signatures and doc comments of imported local items, not their bodies.

**Meaning (AI):**

- "This file is the turn engine; provider I/O is in `client.rs` and tool execution is in `tool.rs`."
- "It depends on `reply::Reply` for the provider's response shape and on `context::project` for what goes on the wire."
- "It is used by `main.rs` and `replay.rs`."

Do not claim a complete call graph. "This file calls `client.complete`" is safe. "`client.complete` is called only here" is not, unless the reference scan proves it. Mark the used-by list as approximate and show the number of files scanned if it matters.

For Rust specifically, the module tree is a reliable map: `main.rs`/`lib.rs` declares `mod agent;`, `agent.rs` declares its own submodules, and `pub` marks the surface other files can see. A small resolver over `mod`/`use` plus LSP definitions is enough for v1. Do not build a repository-wide index like Mole's SQLite store; the extension is a reader, not an IDE replacement.

## Build plan

### Spike 1 — deterministic overview (no model)

- `src/overview.ts`: build `StructuralOverview` from the document, document symbols, imports, module docs, and `Cargo.toml`.
- `src/overviewLens.ts`: register a CodeLens provider for `**/*.rs`; one lens at line 0; command `derust.showOverview`.
- `media/panel.js`/`panel.css`: add the Overview tab, render role/purpose placeholder, What happens from deterministic section headings, Key constructs from symbols, Relations, Start reading.
- Test on `harness/src/agent.rs`, `reply.rs`, and `main.rs`. Acceptance: the glance appears on open, clicking opens the tab, steps jump to lines, no network request is made.

### Spike 2 — AI brief

- Add `src/brief.ts` with the prompt, JSON schema, parser, and validator.
- Add `BriefCache` with source hash, prompt version, model, generatedAt.
- Add **Explain this file** / **Refresh brief** actions and the stale badge.
- Test with the provider in `harness/.env`. Acceptance: a cached brief renders instantly; one call per source hash; malformed output falls back to the structural overview.

### Spike 3 — cross-file relations

- Resolve `use`/`mod` to local files with `vscode.executeDefinitionProvider` and path heuristics.
- Add lazy used-by via `vscode.executeReferenceProvider`, cap 8 files.
- Add direct dependency signatures to the prompt context, cap 6 KB.
- Acceptance: `agent.rs` names `client`, `context`, `reply`, `tool`, and `workspace`; no full repository scan; the model cannot add a path outside the deterministic set.

### Spike 4 — polish

- Settings (`overviewOnOpen`, `briefOnOpen`, `overviewUsedBy`, `overviewMaxContextChars`).
- Keyboard access, empty/error states, cancellation, tests for the validator and cache.
- README and docs.

### Success criteria

- On opening `agent.rs`, the reader can answer "what is this file for?" and "where do I start?" without scrolling.
- Every claim in the overview has a line link or a relation chip.
- With default settings, no model call happens on open.
- The AI brief never invents a cross-file path that the deterministic scan did not find.
- The Overview remains useful with the provider unavailable.

## What not to build

- A full call graph or repository-wide index. Mole and CodeViz already do that; a reader does not need it to orient within one file.
- A repo-level wiki. DeepWiki already exists, and the user's question is per-file.
- A line-by-line explanation. Spotlights already handle that.
- An auto-opened panel on every file by default. The line-0 glance is enough; the panel is one click away.
- A duplicate of VS Code's Outline. The Overview is about meaning and reading order, not a symbol tree.
- A model call on every open. Cache first; make `auto` opt-in.
- A summary that only restates the module docs. If the docs are good, translate and connect them to the code; do not paraphrase them.

## Open decisions

1. **On-open default:** glance (recommended), panel, or off. Glance is the least intrusive and matches CodeFunc's validated pattern.
2. **Brief default:** cached (recommended), auto, or off. Cached keeps the promise of no surprise model calls; auto is the magic mode for users who want it.
3. **Brief as a separate call or part of the full analysis:** separate (recommended) for speed and independence; folding it into the analysis later is possible if the extra call proves annoying.
4. **Label:** Overview (recommended) rather than Outline, to avoid confusion with VS Code's Outline and to promise meaning rather than enumeration.
5. **Used-by in v1:** lazy and approximate (recommended) or defer to v2. It is the most expensive deterministic part and the easiest to misread.

## Sources

- Mole: Code Map — <https://marketplace.visualstudio.com/items?itemName=raychu23.mole-code-map> and <https://github.com/raychu23/mole-code-map>
- CodeFunc - File Overview — <https://marketplace.visualstudio.com/items?itemName=TanvirSdq.codefunc-vscode>
- CodeViz — <https://marketplace.visualstudio.com/items?itemName=CodeViz.codeviz>
- Terrain Code Map — <https://marketplace.visualstudio.com/items?itemName=gigi-didberidze.terrain>
- Visual Code Map — <https://marketplace.visualstudio.com/items?itemName=prawal-sharma.visual-code-map>
- Code Outline — <https://marketplace.visualstudio.com/items?itemName=patrys.vscode-code-outline>
- Aider repo map — <https://aider.chat/docs/repomap.html>
- Repomix — <https://github.com/yamadashy/repomix>
- Kensen Shi et al., "Natural Language Outlines for Code: Literate Programming in the LLM Era," arXiv:2408.04820 — <https://arxiv.org/abs/2408.04820>
- DeepWiki — <https://deepwiki.com/>; DeepWiki-open — <https://github.com/AsyncFuncAI/deepwiki-open>
- VS Code built-in commands (`executeDocumentSymbolProvider`, `executeDefinitionProvider`, `executeReferenceProvider`, call hierarchy) — <https://code.visualstudio.com/api/references/commands>
- VS Code CodeLens API — <https://code.visualstudio.com/api/language-extensions/programmatic-language-features#codelens-show-actionable-context-information-within-source-code>
