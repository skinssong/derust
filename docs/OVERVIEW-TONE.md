# File overview tone: research and rewrite

**Question.** The structural Overview is accurate but reads like a table of contents. In `harness/src/agent.rs`, the module doc says "The loop: call, act, observe, repeat until an answer," then immediately lists "Three rules" without explaining what a turn is or how the loop actually runs. The `run` entry has a signature but no walkthrough. What tone should the generated brief use, and what should it say differently?

## What the guides agree on

| Source | Guidance that applies here |
|---|---|
| [Google developer documentation style guide: voice and tone](https://developers.google.com/style/tone) | Conversational, friendly and respectful without slang; "sound like a knowledgeable friend"; avoid jargon and clichés; be concise; don't be super-entertaining or super-dry. |
| [Google: active voice](https://developers.google.com/style/active-voice) | Make the doer the subject. Passive voice hides who is responsible for an action. |
| [Google: second person](https://developers.google.com/style/person) | Address the reader as "you"; assume the reader is the person doing the task. |
| [Microsoft Writing Style Guide: top 10 tips](https://learn.microsoft.com/en-us/style-guide/top-10-tips-style-voice) | Use bigger ideas and fewer words; write like you speak; get to the point fast; front-load what matters. |
| [Rustdoc: how to write documentation](https://doc.rust-lang.org/rustdoc/how-to-write-documentation.html) | Documentation needs expertise but must write to a novice perspective; start with the role and why someone would use it; walk through complex code. |
| [Rust API Guidelines: documentation](https://rust-lang.github.io/api-guidelines/documentation.html) | Examples should show *why* someone would use an item, not just *how* to call it; document errors, panics and safety. |
| [PEP 257: Docstring Conventions](https://peps.python.org/pep-0257/) | A one-line docstring states the effect as a command, not the signature; a multi-line docstring is a summary line, a blank line, then elaboration. |
| [Diátaxis: explanation](https://diataxis.fr/explanation/) and [how-to guides](https://diataxis.fr/how-to-guides/) | Explanation is understanding-oriented and joins things together; how-to is goal-oriented and written from the reader's perspective. Keep them separate from reference material. |
| [Write the Docs: style guides](https://www.writethedocs.org/guide/writing/style-guides/) | Developer docs should explain what happens during a call and what went wrong on failure; clear, well-formatted, detailed docs are part of developer experience. |

The consensus is not "be casual" or "be formal." It is **plain, direct, active, and useful**. The reader is a competent programmer who is new to this file and possibly new to Rust. They need the shape of the thing before the details.

## Ten rules for the file brief

1. **Lead with the job, not the inventory.** Say what the file is for in one sentence a reader could repeat to a colleague. Do not open with "This file contains..." or a list of symbols.
2. **Explain the mechanism before the rules.** A rule is a consequence of how the loop works. If the module doc jumps from "the loop" to "three rules," the brief supplies the missing mechanism first.
3. **Name the actor and use active voice.** "`run` projects the conversation," not "the conversation is projected." "The provider returns a reply," not "a reply is returned."
4. **Prefer concrete verbs.** Send, record, project, dispatch, shape, append, return, stop. Avoid handle, manage, process, deal with.
5. **Use the file's own names in backticks.** `run`, `Limits`, `context::project`, `Error::Stuck`. Names are navigation handles.
6. **Define a Rust term only when it changes the reader's understanding.** Explain `&mut dyn Recorder` or `#[from]` on first use; do not explain `struct` or `if`.
7. **Separate the modes.** The opening and "How it works" are explanation; the function walkthrough is a sequence; signatures and imports are reference. Do not blend a reference dump into the narrative. There is no separate "Start reading" section: the How-it-works order is the reading order.
8. **Show why, not just what.** For a construct, say what problem it solves. For a function, say why the steps are in that order and what can go wrong.
9. **Keep sentences short and paragraphs scannable.** One idea per sentence; one job per paragraph. Front-load the important clause.
10. **Cut filler and marketing.** No "simply," "just," "obviously," "powerful," "seamless," "robust." No anthropomorphism. No exclamation marks.

## Structure for the brief

1. **Role** — one sentence: what the file is for.
2. **Purpose** — two to four sentences: the central mechanism first, then the stop conditions or constraints that follow from it.
3. **How it works** — four to seven phases in execution or reading order, each anchored to a line range. Rules and edge cases are nested under the step they qualify, not repeated in a second outline.
4. **Key function walkthroughs** — one to three functions. For each: inputs, ordered phases, state changes, return value, errors, side effects. This is where `run` gets its detailed walkthrough.
5. **Why these constructs** — three to six types, traits or functions with one sentence on the problem each solves. This complements the structural list rather than repeating its signatures.

The reference material (symbols, signatures, imports) stays in the structural Overview. The brief is the explanation and the reading order.

## Prose vs bullets

Use prose when the reader needs the relationship between ideas: what causes what, why the order matters, what the loop is doing. Use bullets when the items are parallel and enumerable: three or more stop conditions, rules, reasons, error cases, or options. A comma-separated sentence with four conditions makes the reader parse a list in their head; a bullet list lets them scan it.

The sentence that prompted this note is a list:

> The loop stops when the model answers, when spend after a turn exceeds max_usd, when the same call-and-result signature repeats stuck_after times, or when max_turns calls have been made.

Write it as a lead-in plus bullets instead:

> The loop stops in four ways:
>
> - **Answer:** the reply carries no tool calls.
> - **Budget:** spending after a turn exceeds `max_usd`.
> - **Stuck:** the same call-and-result signature repeats `stuck_after` times.
> - **Ceiling:** `max_turns` model calls have been made.

Do not bullet everything. A sequence of phases is an ordered list because order matters; a function walkthrough is a sequence of steps; constructs and imports are sets. The rule is not "always use bullets" but "use the form that matches the relationship." Prose for causality and explanation, bullets for parallel items, ordered lists for sequences.

### How it works vs rules

The two layers need different jobs, or the rules become a second outline.

- **How it works** answers "what happens next?" It is the turn flow: open, project, call, record, branch, dispatch, repeat, stop.
- **Rules and edge cases** answers "what would surprise me?" It holds invariants and exceptions: an answer is the absence of calls, not `finish_reason`; the budget stops tools but not answers; a failed tool is still an observation.

The outline should name a check without explaining its edge case. The rule supplies the edge case and is rendered under that step. If a rule only restates the outline step, cut it.

For example, this outline step does too much:

> **Check the budget before acting.** When a cap and prices are both set, `run` compares spend to the cap. Crossing it records a `Halt` and returns `BudgetExceeded` without running any tool, though an answer that already crossed the cap is still returned.

The flow only needs:

> **Check the budget before acting.** If the reply calls tools, compare spend with the cap before dispatch.

The rule carries the surprise:

> **The budget stops tools, not answers.** The cap is checked after `decide` and before dispatch, so an answer that crossed the cap is still returned.

## Before and after: `agent.rs`

### Before (the source module doc)

> The loop: call, act, observe, repeat until an answer.
>
> Three rules live here.
>
> * The ceiling counts **model calls**, not tool executions, so a turn that asks for four things still costs one turn.
> * The stopping rule is **"are there calls?"**, not `finish_reason`...
> * A tool result goes back as an observation whatever happened...

The first sentence names the loop but does not say what a turn contains, when tools run, how their results return, or what `run` does with state. The rules arrive before the reader has a model of the loop.

### After (the target brief)

**Role.** Runs the agent's turn loop and decides when to stop.

**Purpose.** A turn starts with the conversation so far, sends it to the model, and then either returns the model's answer or executes the tools the model asked for. Tool results go back into the conversation as observations, and the loop repeats until the model answers or a stop rule fires. This file owns that order of operations; provider I/O lives in `client.rs`, tool execution in `tool.rs`, and conversation projection in `context.rs`.

**How it works**

1. **Set the limits** (L33–L65). `Limits` holds the three stop conditions — maximum model calls, an optional dollar budget, and a repeated-call threshold — plus the context policy. The dollar budget is optional because it cannot be computed without per-token prices.
2. **Record the start** (L112–L127). `run` writes a `Start` event before the first model call, so a run that dies mid-tool still leaves a trace.
3. **Project the context** (L135–L148). Before each call, `context::project` chooses what goes on the wire. Older tool results may be masked in the request; the recorded transcript keeps them whole.
4. **Call the model** (L150–L165). A transport error is the only error that ends the run. `run` records a transport halt and returns the client error.
5. **Record, then decide** (L166–L188). The reply is recorded before it is acted on. `decide` turns an answer into an `Outcome`; tool calls go to the next phase.
6. **Check the budget** (L188–L208). The budget is checked before tools run, so crossing the cap stops the turn without side effects. An answer that crossed the cap is still returned because it was already paid for.
7. **Act and observe** (L210–L258). Each tool call is dispatched, shaped to a byte limit, recorded, and appended as an observation. A repeated call/result signature triggers the stuck stop.
8. **Repeat or stop** (L258–L273). The loop continues with the updated request; if the turn ceiling is reached, it records a halt and returns `TurnsExceeded`.

**How `run` works**

`run` is the turn engine. It borrows the client, registry and workspace, takes the request and limits by value, and holds a mutable recorder for the whole run.

1. It sets up `spent`, `previous_turn`, `repeats`, and a one-time warning flag (L129–L133).
2. At the top of each turn it projects the conversation and warns once if older tool results were masked (L135–L148).
3. It calls the provider and adds the reply's usage to `spent` (L150–L167).
4. It records the reply, then branches on `decide(reply)` (L169–L188).
5. An answer returns immediately; a set of tool calls checks the budget before any tool runs (L177–L208).
6. Each tool call is dispatched, shaped, recorded, and appended to the next request (L210–L233).
7. It compares the new call/result signature with the previous turn and stops if the run is repeating itself (L235–L256).
8. It replaces the request with `request.continued(messages)` and starts the next turn (L258).

**Inputs.** `client` for provider I/O, `registry` and `workspace` for tools, `request` for the conversation, `limits` for the stop rules, and `recorder` for the event log.

**Returns.** `Outcome` with the answer, accumulated usage, and the number of turns taken.

**Errors.** `Error::Client` for a transport failure, `Error::Log` if recording fails, and `Error::TurnsExceeded`, `BudgetExceeded` or `Stuck` for the three stop rules.

**Side effects.** It calls the provider, runs tools, mutates the recorder, and returns after recording a halt for every non-answer stop.

**Stop rules** (after the loop)

* The ceiling counts model calls, not tool executions. A turn with four tool calls still costs one model call.
* The budget is checked before tools run, so a turn that crosses the cap does not also execute its tools.
* A repeated call/result signature counts as stuck; the first turn of a streak counts zero, so `--stuck-after 1` does not stop a run on its first call.

This version explains the loop before the rules, gives `run` a phase-by-phase walkthrough, and names the state, errors and side effects a reader needs.

## Live check

A first run on `agent.rs` with the initial prompt produced a useful brief but exposed two problems: the role was a long sentence that the validator truncated, and the first outline step started with `Limits` and its defaults instead of the loop. I changed the prompt to require a role of at most 18 words and to put the central mechanism before supporting types and rules.

The second run produced a clean brief with no dropped records: role "Runs the model-call loop and stops on an answer, budget, ceiling, or repeated call," a seven-step "How it works" section beginning with projecting the transcript and calling the client, and an eight-step walkthrough for `run` covering start recording, projection, the provider call, usage, answer/act branching, budget, tool dispatch, signature comparison, and the ceiling exit. That is the output shape the extension now asks for.

A later check on `reply.rs` exposed a different gap: the first version only collected top-level functions, so methods such as `Reply::from_json` were dropped from walkthroughs. The overview now flattens `impl` methods into a separate function list and qualifies them with their type. The validator also drops a Rust note that ends in an ellipsis instead of displaying a truncated sentence; omitting a note is better than showing half of one.

The final prompt requires a `rules` array. On `agent.rs` it produced six bullets — answer, ceiling, record-before-acting, budget, failed tool, and repetition — instead of packing the stop conditions into a sentence. On `reply.rs` it produced four failure cases: malformed JSON, no choices, no usage, and neither text nor calls. That is the general rule: prose for the mechanism, bullets for parallel conditions, ordered steps for a sequence.

The panel nests each rule under the outline step whose line range contains it, so the rule reads as an edge case for that phase rather than a repeated section. Rules that cannot be mapped to a step fall back to an "Other rules and edge cases" section. On the Overview lens, clicks and panel scroll move the editor, but editor scrolling and cursor movement do not move the panel; the panel is the map, not the follower.

The separate Constraints tab and its "More invariants" section were removed. The brief's rules and edge cases are the only maintained set of conditions.

## Prompt implications

The brief prompt should:

- Include the module docs as context but explicitly say: **do not repeat them; fill the gap they assume**.
- Require a one-sentence role, then a purpose that explains the mechanism **before** any stop rules or constraints.
- Require 4–7 outline steps with line ranges, in execution or reading order.
- Require 1–3 key function walkthroughs with inputs, ordered steps, returns, errors, and side effects.
- Require every cross-file claim to come from the supplied imports or dependency signatures; do not invent behavior.
- Require line ranges that exist in the numbered source; the validator drops invalid steps.
- Prefer concrete verbs and named actors; ban filler and marketing adjectives.
- Keep the reference material (signatures, imports) in the structural list; the brief explains why it matters.

## Sources

- Google developer documentation style guide — <https://developers.google.com/style/tone>, <https://developers.google.com/style/active-voice>, <https://developers.google.com/style/person>
- Microsoft Writing Style Guide — <https://learn.microsoft.com/en-us/style-guide/top-10-tips-style-voice>
- The rustdoc book — <https://doc.rust-lang.org/rustdoc/how-to-write-documentation.html>
- Rust API Guidelines — <https://rust-lang.github.io/api-guidelines/documentation.html>
- PEP 257 — <https://peps.python.org/pep-0257/>
- Diátaxis — <https://diataxis.fr/explanation/>, <https://diataxis.fr/how-to-guides/>
- Write the Docs style guides — <https://www.writethedocs.org/guide/writing/style-guides/>
