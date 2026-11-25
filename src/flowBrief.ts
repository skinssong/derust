import { ArchitectureModel } from './architecture';
import { extractJsonObject, FlowSpec } from './flow';

export const FLOW_BRIEF_PROMPT_VERSION = 'flow-brief-v2';

export const FLOW_BRIEF_SYSTEM_PROMPT = [
  'You write the opening of a project view for a single Rust crate, for a reader who has never seen the code.',
  'You are given a derived archetype (it may be unknown), the entry point and one representative execution path: ordered stages with a title, a kind and a one-sentence description, plus the transitions between them (a label marks a condition; an unlabelled transition is the plain next step). Where the archetype and the path disagree, trust the path.',
  'Write two sentences, at most 55 words in total. Begin the first sentence with the crate name.',
  "First sentence: name what the crate is — for a library, the type or trait its callers use — saying it is Rust, and the two or three outcomes a user gets from it, in the domain's terms — not the steps it performs to produce them.",
  "Second sentence: name the path's control shape — a main loop (say what it iterates over), a request-response exchange, a pipeline, a traversal over the entries it examines, a call from an embedding caller, or an event cycle — and, if the path shows how it ends, how it ends. Do not count startup or setup failures as endings; mention an error exit only when it is a normal way one use ends. Never name optional extras — notifications, previews, one-shot modes: if the path branches into one, leave that branch out.",
  'If the path is a loop that never returns (an editor, server, daemon or game), describe one run as a loop over the unit it handles — a request, one interactive cycle, one file change — say that it repeats and, if the run ends, how; do not narrate startup.',
  "Compress: name purposes, never enumerate the stages in order, and leave peripheral features out. Leave out exit codes, flags, limits, configuration fields, module names, function names and file paths. Keep domain nouns that appear in stage titles; drop incidental tool or library names, though a tool the work operates on (Cargo commands) is a domain noun.",
  'Register, not content (do not copy): "resizr appears to be a Rust image-resizing command-line tool: it reads the given images, scales each to the requested size and writes the results. Each use is a pipeline over the input files, ending when every image is written." / "exprkit appears to be a Rust expression library: it parses a source string into a tree, binds names and evaluates a value. Each use is centred on one call from the embedding program, ending with a value or a described error."',
  'Ground everything in the supplied path. Do not invent features. Hedge with "appears to be" because the kind is inferred from code, not stated.',
  'The brief is plain text; return only the JSON object {"brief": "..."} with no text outside it.'
].join('\n');

/** The archetype, entry point, stages with their kinds, and the transitions.
 * No source code and no comments. */
export function buildFlowBriefInput(model: ArchitectureModel, flow: FlowSpec): string {
  const entry = model.brief.startHere.find((item) => item.reason.startsWith('entry'));
  const lines = [
    `CRATE: ${model.meta.crate}`,
    `ARCHETYPE: ${model.brief.overview.archetype || 'unknown'}`,
    `ENTRY: ${entry ? entry.id : 'none (library API)'}`,
    '',
    'EXECUTION PATH (one use):'
  ];
  for (const stage of flow.stages) {
    lines.push(`- [${stage.kind}] ${stage.title}: ${stage.detail ?? ''}`);
  }
  lines.push('', 'BRANCHES (a label is a condition; an unlabelled transition is the plain next step):');
  const byId = new Map(flow.stages.map((stage) => [stage.id, stage]));
  for (const edge of flow.edges) {
    const from = byId.get(edge.from)?.title ?? edge.from;
    const to = byId.get(edge.to)?.title ?? edge.to;
    lines.push(`- ${from} -> ${to}${edge.label ? ` (${edge.label})` : ''}`);
  }
  lines.push('', 'Values that cannot be determined are marked unknown.');
  return lines.join('\n');
}

/** Validate the model's opening; anything that is not a JSON object with a
 * non-empty "brief" string is rejected so the identity line stays. */
export function parseFlowBrief(text: string): string | undefined {
  const value = extractJsonObject(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const brief = typeof record.brief === 'string' ? record.brief : record.narrative;
  if (typeof brief !== 'string') {
    return undefined;
  }
  const cleaned = brief
    .replace(/\s+/g, ' ')
    .replace(/^`+|`+$/g, '')
    .trim();
  if (!cleaned) {
    return undefined;
  }
  return cleaned.length > 600 ? cleaned.slice(0, 600) : cleaned;
}
