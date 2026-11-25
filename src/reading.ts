import { ArchitectureModel } from './architecture';

export const READING_PROMPT_VERSION = 'reading-v1';

export const READING_SYSTEM_PROMPT = [
  'You plan a reading order for a Rust workspace so a contributor who has never seen the code can understand one normal run.',
  'You are given FACTS and CODE SAMPLE: real source excerpts with comments blanked out. Read the code; the facts are only orientation.',
  'Return one JSON object only:',
  '{"steps": [{"title": "2-5 words", "why": "one sentence", "files": ["src/..."]}]}',
  'Rules: 5 to 8 steps, ordered from the entry point outward along the run path — entry and dispatch, the loop, one provider exchange, tool dispatch, recording, replay and resume.',
  'Each step names one to three files from the supplied FILE LIST, using the exact relative paths. Never invent a path.',
  'Keep each why to one sentence about what the reader should look for at that step. Titles are short concepts, not function names.',
  'Ground everything in the supplied material. No comments were provided; do not ask for them. No markdown, no text outside the JSON object. Your reply must begin with { and end with }.'
].join('\n');

export type ReadingStep = {
  title: string;
  why: string;
  files: string[];
};

export type ReadingSpec = {
  steps: ReadingStep[];
};

export type StoredReading = ReadingSpec & {
  model: string;
  revision: string;
  generatedAt: string;
};

/** Facts, the file list the model may cite, and comment-free code excerpts. */
export function buildReadingInput(model: ArchitectureModel): string {
  const brief = model.brief;
  const entry = brief.startHere.find((item) => item.reason.startsWith('entry'));
  const files = Array.from(new Set(model.nodes.flatMap((node) => node.modules))).sort();
  const lines: string[] = [
    `CRATE: ${model.meta.crate}`,
    `ENTRY: ${entry ? entry.id : '(no fn main; library)'}`,
    `IDENTITY: ${brief.overview.identity}`,
    `CORE FLOW: ${brief.overview.flow}`,
    `TRANSFORMATIONS: ${brief.overview.transformations}`,
    '',
    'FILE LIST (only these relative paths are valid):',
    ...files.map((file) => `- ${file}`),
    '',
    'MODULES:'
  ];
  for (const module of brief.modules) {
    lines.push(`- ${module.id}: ${module.description}`);
  }
  lines.push(
    '',
    'CODE SAMPLE (comments blanked; excerpts from the highest-signal files):',
    model.codeSample || '(no code sample available)',
    '',
    'Everything above is derived from the code. No comments are included.'
  );
  return lines.join('\n');
}

/** Validate the model's reading order; unknown files are dropped, and a
 * step without any valid file is removed. */
export function parseReading(value: unknown, files: Set<string>): ReadingSpec | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const rawSteps = Array.isArray(record.steps) ? record.steps : [];
  const steps: ReadingStep[] = [];
  for (const item of rawSteps.slice(0, 10)) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const step = item as Record<string, unknown>;
    const title = typeof step.title === 'string' ? step.title.trim().slice(0, 60) : '';
    const why = typeof step.why === 'string' ? step.why.trim().slice(0, 220) : '';
    const rawFiles = Array.isArray(step.files) ? step.files : [];
    const stepFiles: string[] = [];
    for (const file of rawFiles) {
      if (typeof file === 'string' && files.has(file) && !stepFiles.includes(file)) {
        stepFiles.push(file);
      }
    }
    if (!title || stepFiles.length === 0) {
      continue;
    }
    steps.push({ title, why, files: stepFiles.slice(0, 3) });
  }
  if (steps.length < 3) {
    return undefined;
  }
  return { steps: steps.slice(0, 8) };
}
