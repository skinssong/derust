import { ArchitectureModel } from './architecture';

export const NARRATIVE_PROMPT_VERSION = 'narrative-v2';

export const NARRATIVE_SYSTEM_PROMPT = [
  'You write the opening section of an architecture brief for a Rust workspace, for a contributor who has never seen the code.',
  'You are given FACTS (module names, entry point, typed flow, carriers, technology) and CODE SAMPLE: real source excerpts from the highest-signal files, with comments blanked out. Read the code itself; the facts are only orientation.',
  'Write one section answering: what this project is (name the kind of program, e.g. an LLM agent harness, a CLI, an HTTP service, a library); what it appears to do end to end, inferred from how the code is structured and what it calls; its core components and how they connect; the core technology; and where a new reader should start.',
  'Ground every claim in the supplied facts or code. No comments were provided and you must not ask for them. Do not invent features, services, frameworks or goals. Where purpose is implied rather than stated, hedge with "appears to" or "is structured as".',
  'One to three short paragraphs, plain text, no headings and no markdown, under 200 words.',
  'Return one JSON object only: {"narrative": "..."}. Your reply must begin with { and end with }; no text outside it.'
].join('\n');

/** Facts plus comment-free code excerpts: the material the narrative may use. */
export function buildNarrativeInput(model: ArchitectureModel): string {
  const brief = model.brief;
  const entry = brief.startHere.find((item) => item.reason.startsWith('entry'));
  const lines: string[] = [
    `CRATE: ${model.meta.crate}`,
    `MODULES: ${model.nodes.length}`,
    `ENTRY: ${entry ? entry.id : '(no fn main; library)'}`,
    `IDENTITY: ${brief.overview.identity}`,
    `CORE FLOW: ${brief.overview.flow}`,
    `TECHNOLOGY: ${brief.overview.technology}`,
    `MAP: ${brief.overview.map}`,
    '',
    'MODULES:'
  ];
  for (const module of brief.modules) {
    lines.push(`- ${module.id}: ${module.description}`);
  }
  if (brief.carriers.length > 0) {
    lines.push('', 'CARRIERS:');
    for (const carrier of brief.carriers) {
      lines.push(`- ${carrier.name} (defined in ${carrier.owner}, used by ${carrier.users.length} components)`);
    }
  }
  const callEdges = model.edges
    .filter((edge) => (edge.kinds.calls ?? 0) > 0)
    .sort((left, right) => (right.kinds.calls ?? 0) - (left.kinds.calls ?? 0))
    .slice(0, 12);
  if (callEdges.length > 0) {
    lines.push('', 'CALL EDGES (calls only):');
    for (const edge of callEdges) {
      lines.push(`- ${edge.source} -> ${edge.target} (${edge.kinds.calls} call sites)`);
    }
  }
  lines.push(
    '',
    'CODE SAMPLE (comments blanked; excerpts from the highest-signal files):',
    model.codeSample || '(no code sample available)',
    '',
    'Everything above is derived from the code. No comments are included; do not assume anything that is not shown here.'
  );
  return lines.join('\n');
}
