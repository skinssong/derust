import {
  BriefStep,
  FileBrief,
  FunctionBrief,
  FunctionStep,
  ModuleContext,
  ProfileOperation,
  StructuralOverview
} from './contract';
import {
  ProfileCandidates,
  formatCallGroups,
  formatDelegates,
  formatPublicSurface,
  formatRelations
} from './profile';
import { GENERAL_VOICE } from './voice';

export const BRIEF_PROMPT_VERSION = 'brief-v13';

export type BriefSourceMeta = {
  file: string;
  crateName?: string;
  docs?: string;
  model: string;
  sourceHash: string;
  overview: StructuralOverview;
  moduleContext?: ModuleContext;
  candidates?: ProfileCandidates;
};

const briefSchema = {
  type: 'object',
  required: ['role', 'purpose', 'operations', 'functions', 'rules'],
  properties: {
    role: { type: 'string', description: 'One sentence: what the module is for.' },
    purpose: {
      type: 'string',
      description: 'Two to four sentences: the module behavior, one unit of work, and how it ends.'
    },
    boundaries: {
      type: 'string',
      description: 'Optional one sentence: what this module delegates and to whom.'
    },
    operations: {
      type: 'array',
      minItems: 2,
      maxItems: 5,
      items: {
        type: 'object',
        required: ['name', 'purpose', 'entry', 'functions', 'start', 'end'],
        properties: {
          name: { type: 'string' },
          purpose: { type: 'string' },
          entry: { type: 'string' },
          functions: { type: 'array', items: { type: 'string' } },
          start: { type: 'integer' },
          end: { type: 'integer' }
        }
      }
    },
    functions: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: {
        type: 'object',
        required: ['name', 'summary', 'why', 'steps'],
        properties: {
          name: { type: 'string' },
          summary: { type: 'string' },
          why: { type: 'string', description: 'One sentence: why this function exists.' },
          inputs: { type: 'string' },
          returns: { type: 'string' },
          errors: { type: 'string' },
          sideEffects: { type: 'string' },
          steps: {
            type: 'array',
            minItems: 2,
            maxItems: 8,
            items: {
              type: 'object',
              required: ['text', 'start', 'end'],
              properties: {
                text: { type: 'string' },
                start: { type: 'integer' },
                end: { type: 'integer' }
              }
            }
          }
        }
      }
    },
    rules: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        required: ['title', 'text', 'start', 'end'],
        properties: {
          title: { type: 'string' },
          text: { type: 'string' },
          start: { type: 'integer' },
          end: { type: 'integer' }
        }
      }
    }
  }
};

export const BRIEF_SYSTEM_PROMPT = [
  'You write a module reading for a programmer who knows other languages but not Rust.',
  'The reader is competent and busy. They need orientation, not a tutorial.',
  'Return one JSON object only, with no markdown fences and no text outside it, matching this JSON Schema:',
  JSON.stringify(briefSchema),
  GENERAL_VOICE,
  'SECTION RULES',
  '- role: exactly one sentence, at most 18 words, present tense, beginning with an active verb. Say what the module is for, not what it contains. Do not list stop conditions, outcomes, rules, operations, or types. Do not repeat the purpose or any rule. Use a code identifier only when it is the public entry point. Example: "Reads a file and returns its parsed contents."',
  '- purpose: two to four sentences, 50-90 words; prefer three. Describe the module behavior without requiring the reader to open the file. Open with the module job, not its internal call graph or entry-point relationships; never start with "A and B both call C" or "The entry points are...". Sentence 1: begin with "This module" followed by a present-tense verb and say what the module does as a whole. After the first sentence, use "it" or a concrete noun such as "a run", "a call", or "the request"; do not repeat "This module" or "the module". Sentence 2: what one unit of work does (one turn, request, job, or pass) in general programming terms. Sentence 3: how a run starts or resumes and how it can end: success, a normal stop, a pause, or a failure category. Do not name entry or helper functions such as `run`, `resume`, `drive`, or `decide`; describe behavior instead. Do not explain how a run starts internally. Use general terms such as module, function, request, reply, call, result, record, pause, and stop. Do not name Rust constructs or explain syntax. Do not include line ranges. Do not enumerate stop conditions, thresholds, error variants, or operation steps; rules and operations own those. Do not repeat the role verbatim. At most one sentence of rationale ("so..." or "because..."). No bullet points and no more than one backticked identifier.',
  '- boundaries: optional. One sentence naming only the main external boundaries and the modules that own them. Use targets in DELEGATES and direct calls visible in SOURCE. Do not list helpers or every call edge. Omit the field when the evidence is too partial to name the main boundaries.',
  '- operations: 2-5 module-level contracts in execution or reading order. An operation is a contract, not a sequence; do not list its internal steps. Group CALL GROUPS into operations and do not create one operation per call edge. Do not create operations for pure helpers such as `decide`, `asking`, `allowed`, `observe`, `record_tool`, `pending_turn`, or `rebuild`; fold them into the operation that uses them. Aim for four operations when the module has those paths: start, resume, take a turn, act on calls. Each operation names a short human-readable name, one sentence stating the contract, its entry function, the functions involved when the index lists them, and a valid line range. Prefer a public entry point or the function that owns the loop. The line range must cover the entry and the work described; do not claim the whole loop from a wrapper range.',
  '- functions: 1-3 names from FUNCTIONS, including methods such as `Reply::from_json`. Prefer public entry points and the function that owns the loop; avoid pure helpers such as `rebuild`, `asking`, or `decide`. For each, write a summary of one sentence, at most 14 words, naming only the function job; do not include setup, arguments, steps, or rationale. Add a required why sentence that states why the function exists; attach the reason to the object it explains. Then give 4-8 ordered steps with exact subranges. Each step says what changes, what is read or written, and what can fail; do not narrate every line. Include inputs, returns, errors and side effects. Do not restate an operation contract; show how the function implements it.',
  '- rules: required. Return [] when there is no non-obvious rule. Each rule states an invariant, exception, or stop condition that the function walkthrough does not already explain. When a condition has three or more parallel items, use one rule per item. Give each rule the line range of the condition, not the whole function. Do not turn rules into a second walkthrough. Never write settle, settles, settled, or gate in any form; state the action and the actor.',
  '- Do not generate outline, constructs, or rust notes. Highlights owns the Rust syntax explanations.',
  '- Use the file own identifiers in backticks. Do not invent cross-file behavior; use only the supplied imports, signatures, index facts, and project context.'
].join('\n');

export function formatModuleContext(context: ModuleContext | undefined): string {
  if (!context) {
    return '(none)';
  }

  const lines: string[] = [`Module: ${context.modulePath ?? context.file}`];
  if (context.crateName) {
    lines.push(`Crate: ${context.crateName}`);
  }
  lines.push('Public surface:');
  for (const symbol of context.publicSurface.slice(0, 20)) {
    lines.push(
      `  ${symbol.kind} ${symbol.name} L${symbol.start}-${symbol.end}${
        symbol.signature ? ` — ${symbol.signature}` : ''
      }`
    );
  }

  if (context.callers.length > 0) {
    lines.push('Callers:');
    for (const relation of context.callers.slice(0, 30)) {
      lines.push(`  ${relation.name} (${relation.file}:${relation.line})`);
    }
  }
  if (context.callees.length > 0) {
    lines.push('Callees:');
    for (const relation of context.callees.slice(0, 30)) {
      lines.push(`  ${relation.name} (${relation.file}:${relation.line})`);
    }
  }
  if (context.tests.length > 0) {
    lines.push('Tests:');
    for (const relation of context.tests.slice(0, 15)) {
      lines.push(`  ${relation.name} (${relation.file}:${relation.line})`);
    }
  }
  if (context.imports.length > 0) {
    lines.push('Imports:');
    for (const item of context.imports.slice(0, 20)) {
      lines.push(`  ${item}`);
    }
  }
  if (context.dependencies.length > 0) {
    lines.push(`Dependencies: ${context.dependencies.slice(0, 20).join(', ')}`);
  }

  return lines.join('\n');
}

export function buildBriefUserPrompt(source: string, meta: BriefSourceMeta): string {
  const lines = source.split(/\r?\n/);
  const numbered = lines
    .map((line, index) => `${String(index + 1).padStart(5, ' ')}  ${line}`)
    .join('\n');
  const functions = meta.overview.functions
    .map(
      (symbol) =>
        `${symbol.name}  L${symbol.start}-L${symbol.end}${
          symbol.signature ? `  ${symbol.signature}` : ''
        }`
    )
    .join('\n');
  const imports = meta.overview.imports
    .map(
      (item) =>
        `${item.external ? 'external' : 'local'}  ${item.path}${
          item.symbols && item.symbols.length > 0 ? `  ${item.symbols.join(', ')}` : ''
        }`
    )
    .join('\n');
  const candidates = meta.candidates;
  const publicSurface = candidates
    ? formatPublicSurface(candidates.publicSurface)
    : meta.overview.symbols
        .map((symbol) => `${symbol.kind} ${symbol.name} L${symbol.start}-L${symbol.end}`)
        .join('\n');
  const delegates = candidates ? formatDelegates(candidates.delegates) : '(none)';
  const callGroups = candidates ? formatCallGroups(candidates.callGroups) : '(none)';
  const callers = candidates ? formatRelations(candidates.callers) : '(none)';
  const callees = candidates ? formatRelations(candidates.callees) : '(none)';
  const tests = candidates ? formatRelations(candidates.tests) : '(none)';
  const dependencies = candidates ? candidates.dependencies.join(', ') : '(none)';

  return [
    `FILE: ${meta.file}`,
    `MODULE: ${meta.moduleContext?.modulePath ?? meta.overview.modulePath ?? 'unknown'}`,
    `CRATE: ${meta.crateName ?? 'unknown'}`,
    `MODULE DOCS:\n${meta.overview.moduleDoc ?? '(none)'}`,
    `PROJECT CONTEXT:\n${meta.docs || '(none)'}`,
    `PUBLIC SURFACE:\n${publicSurface || '(none)'}`,
    `FUNCTIONS:\n${functions || '(none)'}`,
    `IMPORTS:\n${imports || '(none)'}`,
    `DELEGATES:\n${delegates}`,
    `CALL GROUPS:\n${callGroups}`,
    `CALLERS:\n${callers}`,
    `CALLEES:\n${callees}`,
    `TESTS:\n${tests}`,
    `DEPENDENCIES:\n${dependencies}`,
    'SOURCE (numbered, 1-based):',
    numbered,
    'Write the module reading. Explain the module behavior before listing its operations. Group call groups into a small number of operations; do not turn every call edge into an operation. For the function walkthrough, explain what happens in order, what changes, and what can fail. Do not merely restate signatures.'
  ].join('\n\n');
}

export function parseBriefJson(textValue: string): unknown {
  let value = textValue.trim();
  if (value.startsWith('```')) {
    value = value.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  }

  try {
    return JSON.parse(value);
  } catch {
    throw new Error('Brief response was not valid JSON.');
  }
}

export function validateBrief(
  value: unknown,
  source: string,
  meta: BriefSourceMeta
): { brief: FileBrief; issues: string[] } {
  if (!isObject(value)) {
    throw new Error('Brief response was not a JSON object.');
  }

  const issues: string[] = [];
  const lineCount = source.length === 0 ? 0 : source.split(/\r?\n/).length;

  const role = truncate(asString(value.role), 160);
  if (!role) {
    throw new Error('Brief response had no role.');
  }
  const roleWords = countWords(role);
  if (roleWords > 18) {
    issues.push(`Role has ${roleWords} words; the limit is 18.`);
  }

  const rawPurpose = truncate(asString(value.purpose), 900);
  if (!rawPurpose) {
    throw new Error('Brief response had no purpose.');
  }
  const fitted = fitPurpose(rawPurpose);
  const purpose = fitted.text;
  if (fitted.trimmed) {
    issues.push('Purpose exceeded 100 words and was shortened.');
  }
  const purposeSentences = countSentences(purpose);
  const purposeWords = countWords(purpose);
  if (purposeSentences < 2 || purposeSentences > 4) {
    issues.push(`Purpose has ${purposeSentences} sentences; expected 2-4.`);
  }
  if (purposeWords < 50 || purposeWords > 100) {
    issues.push(`Purpose has ${purposeWords} words; expected 50-100.`);
  }
  if (!/^This module\s+\S+/i.test(purpose)) {
    issues.push('Purpose should begin with "This module" and a present-tense verb.');
  } else if ((purpose.match(/\bThis module\b/gi) || []).length > 1) {
    issues.push('Purpose repeats "This module" after the first sentence.');
  }

  const boundaries = truncate(asString(value.boundaries), 320) || undefined;
  const operations = sanitizeOperations(value.operations, meta, lineCount, issues);
  if (operations.length < 2) {
    throw new Error('Brief response had too few valid operations.');
  }
  const functions = sanitizeFunctions(value.functions, meta, lineCount, issues);
  const rules = sanitizeRules(value.rules, lineCount, issues);

  const brief: FileBrief = {
    version: 2,
    file: meta.file,
    sourceHash: meta.sourceHash,
    model: meta.model,
    generatedAt: new Date().toISOString(),
    role,
    purpose,
    boundaries,
    operations,
    rules: rules.length > 0 ? rules : undefined,
    functions
  };

  return { brief, issues };
}

function sanitizeOperations(
  value: unknown,
  meta: BriefSourceMeta,
  lineCount: number,
  issues: string[]
): ProfileOperation[] {
  const operations: ProfileOperation[] = [];
  const knownFunctions = new Set(meta.overview.functions.map((symbol) => symbol.name));
  for (const name of meta.candidates?.callees.map((relation) => relation.name) ?? []) {
    knownFunctions.add(name);
  }

  for (const raw of asArray(value)) {
    if (!isObject(raw)) {
      continue;
    }
    const name = truncate(asString(raw.name), 70);
    const purpose = truncate(asString(raw.purpose), 260);
    const entry = asString(raw.entry);
    const range = validRange(raw.start, raw.end, lineCount);
    const functions = asArray(raw.functions)
      .map((item) => asString(item))
      .filter((item) => knownFunctions.has(item))
      .slice(0, 8);

    if (!name || !purpose || !entry || !range) {
      issues.push(`Dropped operation "${name || '(unnamed)'}" with an invalid range or text.`);
      continue;
    }

    operations.push({ name, purpose, entry, functions, start: range.start, end: range.end });
    if (operations.length === 5) {
      break;
    }
  }

  operations.sort((left, right) => left.start - right.start);
  return operations;
}

function sanitizeFunctions(
  value: unknown,
  meta: BriefSourceMeta,
  lineCount: number,
  issues: string[]
): FunctionBrief[] {
  const functions: FunctionBrief[] = [];

  for (const raw of asArray(value)) {
    if (!isObject(raw)) {
      continue;
    }

    const name = asString(raw.name).replace(/`/g, '').trim();
    let symbol = meta.overview.functions.find((candidate) => candidate.name === name);
    if (!symbol) {
      const matches = meta.overview.functions.filter((candidate) =>
        candidate.name.endsWith(`::${name}`)
      );
      if (matches.length === 1) {
        symbol = matches[0];
      }
    }
    if (!symbol) {
      issues.push(`Dropped a walkthrough for unknown function "${name}".`);
      continue;
    }

    const summary = truncate(asString(raw.summary), 260);
    if (!summary) {
      issues.push(`Dropped the walkthrough for ${name}: no summary.`);
      continue;
    }
    if (countWords(summary) > 14) {
      issues.push(`Summary for ${name} exceeds 14 words.`);
    }
    const why = truncate(asString(raw.why), 220) || undefined;
    if (!why) {
      issues.push(`Walkthrough for ${name} has no why sentence.`);
    }

    const steps: FunctionStep[] = [];
    for (const rawStep of asArray(raw.steps)) {
      if (!isObject(rawStep)) {
        continue;
      }
      const text = truncate(asString(rawStep.text), 240);
      const range = validRange(rawStep.start, rawStep.end, lineCount);
      if (!text || !range || range.start < symbol.start || range.end > symbol.end) {
        issues.push(`Dropped a step of ${name} outside its line range.`);
        continue;
      }
      steps.push({ text, start: range.start, end: range.end });
      if (steps.length === 8) {
        break;
      }
    }

    if (steps.length < 2) {
      issues.push(`Dropped the walkthrough for ${name}: too few valid steps.`);
      continue;
    }

    steps.sort((left, right) => left.start - right.start);
    functions.push({
      name: symbol.name,
      start: symbol.start,
      end: symbol.end,
      signature: symbol.signature,
      summary,
      why,
      steps,
      inputs: truncate(asString(raw.inputs), 240) || undefined,
      returns: truncate(asString(raw.returns), 240) || undefined,
      errors: truncate(asString(raw.errors), 240) || undefined,
      sideEffects: truncate(asString(raw.sideEffects), 240) || undefined
    });

    if (functions.length === 3) {
      break;
    }
  }

  return functions;
}

function sanitizeRules(value: unknown, lineCount: number, issues: string[]): BriefStep[] {
  const rules: BriefStep[] = [];
  for (const raw of asArray(value)) {
    if (!isObject(raw)) {
      continue;
    }
    const title = truncate(asString(raw.title), 60);
    const text = truncate(asString(raw.text), 240);
    const range = validRange(raw.start, raw.end, lineCount);
    if (!title || !text || !range) {
      issues.push('Dropped a rule with an invalid title, text or line range.');
      continue;
    }
    rules.push({ title, text, start: range.start, end: range.end });
    if (rules.length === 6) {
      break;
    }
  }

  rules.sort((left, right) => left.start - right.start);
  return rules;
}

function countWords(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function sentenceParts(value: string): string[] {
  return value
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function countSentences(value: string): number {
  return sentenceParts(value).length;
}

function fitPurpose(value: string): { text: string; trimmed: boolean } {
  const sentences = sentenceParts(value);
  let text = value;
  while (countWords(text) > 100 && sentences.length > 2) {
    sentences.pop();
    text = sentences.join(' ');
  }
  return { text, trimmed: text !== value };
}

function validRange(
  rawStart: unknown,
  rawEnd: unknown,
  lineCount: number
): { start: number; end: number } | undefined {
  const start = Math.floor(Number(rawStart));
  const end = Math.floor(Number(rawEnd));

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 1 ||
    end < start ||
    start > lineCount
  ) {
    return undefined;
  }

  return { start, end: Math.min(end, lineCount) };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  const slice = value.slice(0, limit - 1);
  const lastSpace = slice.lastIndexOf(' ');
  const trimmed = lastSpace > 40 ? slice.slice(0, lastSpace) : slice;
  return `${trimmed.trimEnd()}…`;
}
