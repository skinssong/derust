import { ArchitectureModel } from './architecture';

export const FLOW_PROMPT_VERSION = 'flow-v3';

export const FLOW_SYSTEM_PROMPT = [
  'You turn a Rust codebase run path into a process diagram for a contributor who has never seen the code.',
  'You are given FACTS and CODE SAMPLE: real source excerpts with comments blanked out. Read the code; the facts are only orientation.',
  'Describe the flow of ONE normal run end to end: what comes in, how it is enriched, where it leaves the process, what comes back, how it is parsed, what may happen next, and how it ends.',
  'Return one JSON object only:',
  '{"title": "...", "stages": [{"id": "kebab-case", "title": "2-5 words", "detail": "one sentence", "kind": "input|step|decision|output|halt", "source": "module"}], "edges": [{"from": "id", "to": "id", "label": "optional 1-3 words"}]}',
  'Rules: 8 to 14 stages; unique ids; every edge endpoint must be a stage id; include the normal path and labelled branches for answers, tool calls, approval pauses and halts (loop back with a "repeat" edge where the run continues).',
  'Titles are product concepts, not file names and not code identifiers unless the concept itself is named that way. Details say what changes at that stage, not which function implements it.',
  '"source" is the single top-level module whose code carries out that stage, as named in MODULES (for example agent, client, tools). Module name only: no items, no paths.',
  'Ground every stage in the supplied material. No comments were provided; do not ask for them. Do not invent features or external services.',
  'No markdown, no text outside the JSON object. Your reply must begin with { and end with }; any analysis before the JSON is discarded and fails the run.'
].join('\n');

export type FlowStageKind = 'input' | 'step' | 'decision' | 'output' | 'halt';

export type FlowStage = {
  id: string;
  title: string;
  detail?: string;
  kind: FlowStageKind;
  /** module::item that does the work, as cited by the model. */
  source?: string;
  /** Workspace-relative file the source resolved to. */
  file?: string;
  /** 1-based line of the resolved symbol. */
  line?: number;
};

export type FlowEdge = {
  from: string;
  to: string;
  label?: string;
};

export type FlowSpec = {
  title: string;
  stages: FlowStage[];
  edges: FlowEdge[];
  /** Opening line written from the stages; absent on flows drawn before it. */
  brief?: string;
};

export type StoredFlow = FlowSpec & {
  model: string;
  revision: string;
  generatedAt: string;
};

/** Facts plus comment-free code excerpts, the material the flow may use. */
export function buildFlowInput(model: ArchitectureModel): string {
  const brief = model.brief;
  const entry = brief.startHere.find((item) => item.reason.startsWith('entry'));
  const lines: string[] = [
    `CRATE: ${model.meta.crate}`,
    `ENTRY: ${entry ? entry.id : '(no fn main; library)'}`,
    `IDENTITY: ${brief.overview.identity}`,
    `CORE FLOW: ${brief.overview.flow}`,
    `DATA FLOW: ${brief.overview.dataFlow}`,
    `TRANSFORMATIONS: ${brief.overview.transformations}`,
    `TECHNOLOGY: ${brief.overview.technology}`,
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

const STAGE_KINDS: FlowStageKind[] = ['input', 'step', 'decision', 'output', 'halt'];

const KIND_ALIASES: Record<string, FlowStageKind> = {
  input: 'input',
  start: 'input',
  source: 'input',
  output: 'output',
  end: 'output',
  finish: 'output',
  sink: 'output',
  decision: 'decision',
  branch: 'decision',
  choice: 'decision',
  condition: 'decision',
  halt: 'halt',
  error: 'halt',
  failure: 'halt',
  stop: 'halt',
  step: 'step',
  process: 'step',
  action: 'step'
};

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'stage';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Pull the first JSON object out of a response that may be fenced or
 * surrounded by prose. */
export function extractJsonObject(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```[a-zA-Z]*\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
  const candidates = [trimmed];
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) {
    candidates.push(trimmed.slice(first, last + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isRecord(parsed)) {
        for (const key of ['flow', 'result', 'data']) {
          if (isRecord(parsed[key])) {
            return parsed[key];
          }
        }
        return parsed;
      }
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

function normalizeSource(value: string): string {
  return value
    .replace(/^`+|`+$/g, '')
    .replace(/\([^)]*\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function parseFlowValue(value: unknown): { spec?: FlowSpec; reason?: string } {
  if (Array.isArray(value)) {
    value = { stages: value };
  }
  if (!isRecord(value)) {
    return { reason: 'the response was not a JSON object' };
  }
  const title =
    (typeof value.title === 'string' && value.title.trim()) ||
    (typeof value.name === 'string' && value.name.trim()) ||
    'One normal run';
  const rawStages = [value.stages, value.nodes, value.steps].find(Array.isArray) as
    | unknown[]
    | undefined;
  if (!rawStages || rawStages.length === 0) {
    return { reason: 'no stages array was found' };
  }
  const stages: FlowStage[] = [];
  const ids = new Set<string>();
  const titleToId = new Map<string, string>();
  for (const item of rawStages.slice(0, 18)) {
    const stage = isRecord(item) ? item : typeof item === 'string' ? { title: item } : undefined;
    if (!stage) {
      continue;
    }
    const stageTitle =
      (typeof stage.title === 'string' && stage.title.trim()) ||
      (typeof stage.label === 'string' && stage.label.trim()) ||
      (typeof stage.name === 'string' && stage.name.trim()) ||
      (typeof stage.id === 'string' && stage.id.trim()) ||
      '';
    if (!stageTitle) {
      continue;
    }
    let id = (typeof stage.id === 'string' && stage.id.trim()) || slugify(stageTitle);
    if (ids.has(id)) {
      let suffix = 2;
      while (ids.has(`${id}-${suffix}`)) {
        suffix += 1;
      }
      id = `${id}-${suffix}`;
    }
    ids.add(id);
    titleToId.set(stageTitle, id);
    titleToId.set(stageTitle.toLowerCase(), id);
    const kindValue =
      typeof stage.kind === 'string'
        ? stage.kind.toLowerCase()
        : typeof stage.type === 'string'
          ? stage.type.toLowerCase()
          : 'step';
    const detailValue = [stage.detail, stage.description, stage.summary, stage.why].find(
      (itemValue): itemValue is string => typeof itemValue === 'string' && Boolean(itemValue.trim())
    );
    const sourceValue = [stage.source, stage.handler, stage.where, stage.module, stage.symbol, stage.code, stage.location].find(
      (itemValue): itemValue is string => typeof itemValue === 'string' && Boolean(itemValue.trim())
    );
    stages.push({
      id,
      title: stageTitle.slice(0, 60),
      detail: detailValue ? detailValue.trim().slice(0, 220) : undefined,
      kind: KIND_ALIASES[kindValue] ?? 'step',
      source: sourceValue ? normalizeSource(sourceValue) : undefined
    });
  }
  if (stages.length < 2) {
    return { reason: `only ${stages.length} readable stage(s)` };
  }
  const rawEdges = [value.edges, value.connections, value.links, value.transitions, value.arrows].find(
    Array.isArray
  ) as unknown[] | undefined;
  const resolve = (valueUnknown: unknown): string | undefined => {
    if (typeof valueUnknown !== 'string') {
      return undefined;
    }
    const raw = valueUnknown.trim();
    if (ids.has(raw)) {
      return raw;
    }
    const byTitle = titleToId.get(raw) ?? titleToId.get(raw.toLowerCase());
    if (byTitle) {
      return byTitle;
    }
    return ids.has(slugify(raw)) ? slugify(raw) : undefined;
  };
  const edges: FlowEdge[] = [];
  for (const item of (rawEdges ?? []).slice(0, 40)) {
    if (!isRecord(item)) {
      continue;
    }
    const from = resolve(item.from ?? item.source ?? item.start);
    const to = resolve(item.to ?? item.target ?? item.end);
    if (!from || !to || from === to) {
      continue;
    }
    if (edges.some((existing) => existing.from === from && existing.to === to)) {
      continue;
    }
    const labelValue = [item.label, item.name, item.condition].find(
      (itemValue): itemValue is string => typeof itemValue === 'string' && Boolean(itemValue.trim())
    );
    edges.push({ from, to, label: labelValue ? labelValue.trim().slice(0, 40) : undefined });
  }
  if (edges.length === 0) {
    return { reason: 'no edges connected the stages' };
  }
  return {
    spec: { title: title.slice(0, 80), stages, edges }
  };
}

/** Validate a parsed flow value (shape from JSON.parse). */
export function parseFlow(value: unknown): FlowSpec | undefined {
  return parseFlowValue(value).spec;
}

/** Parse a raw model response, reporting why it was rejected. */
export function parseFlowText(text: string): { spec?: FlowSpec; reason?: string } {
  const value = extractJsonObject(text);
  if (value === undefined) {
    return {
      reason: text.includes('{')
        ? 'the JSON object was incomplete or malformed, likely cut off at the output cap'
        : 'no JSON object was found in the response'
    };
  }
  return parseFlowValue(value);
}

function moduleBase(file: string): string {
  const normalized = file.replace(/\\/g, '/');
  const segment = normalized.slice(normalized.lastIndexOf('/') + 1).replace(/\.rs$/, '');
  if (segment !== 'mod') {
    return segment;
  }
  const parent = normalized.slice(0, Math.max(0, normalized.lastIndexOf('/')));
  return parent.slice(parent.lastIndexOf('/') + 1) || segment;
}

/**
 * Resolve each stage's `module::item` citation against the analysed code so the
 * panel can open the exact file and line. Citations that cannot be resolved are
 * left as the model wrote them, unlinked.
 */
export function linkFlowSources(spec: FlowSpec, model: ArchitectureModel): void {
  const components = model.nodes.filter((node) => !node.external);
  for (const stage of spec.stages) {
    if (!stage.source) {
      continue;
    }
    const cleaned = stage.source.replace(/\([^)]*\)\s*$/, '').trim();
    const parts = cleaned
      .split('::')
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length === 0) {
      stage.source = undefined;
      continue;
    }
    let head = parts[0].replace(/\\/g, '/');
    if (head.includes('/')) {
      head = head.slice(head.lastIndexOf('/') + 1);
    }
    head = head.replace(/\.rs$/, '');
    const component =
      components.find((node) => node.id === head) ??
      components.find((node) => node.id.toLowerCase() === head.toLowerCase()) ??
      components.find((node) =>
        node.modules.some((file) => moduleBase(file).toLowerCase() === head.toLowerCase())
      );
    if (!component) {
      continue;
    }
    const itemParts = parts.slice(1);
    const item = itemParts.length > 0 ? itemParts[itemParts.length - 1] : '';
    const qualified = itemParts.length > 1 ? itemParts.slice(-2).join('::') : '';
    const byName = (name: string): ((candidate: { name: string }) => boolean) => {
      const lower = name.toLowerCase();
      return (candidate) => candidate.name === name || candidate.name.toLowerCase() === lower;
    };
    let symbol: (typeof component.symbols)[number] | undefined;
    if (item) {
      const lookups = [
        qualified ? byName(qualified) : undefined,
        byName(item),
        (candidate: { name: string }) => candidate.name.endsWith(`::${item}`),
        (candidate: { name: string }) => candidate.name.toLowerCase().endsWith(`::${item.toLowerCase()}`)
      ];
      for (const lookup of lookups) {
        if (!lookup) {
          continue;
        }
        symbol = component.symbols.find(lookup);
        if (symbol) {
          break;
        }
      }
    }
    if (symbol) {
      stage.source = component.id;
      stage.file = symbol.file;
      stage.line = symbol.start;
      continue;
    }
    const primary =
      component.modules.find((file) => file.endsWith('/mod.rs')) ?? component.modules[0];
    stage.source = component.id;
    if (primary) {
      stage.file = primary;
      stage.line = 1;
    }
  }
}
