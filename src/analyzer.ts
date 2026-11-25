import {
  Analysis,
  MemoryEvent,
  MemoryEventKind,
  MemoryFrame,
  MemoryHeap,
  MemoryModel,
  MemoryPointer,
  MemoryValue,
  Point,
  Scope,
  Spotlight,
  TraceGroup,
  TraceKind,
  TypeItem,
  TypeKind,
  Usage
} from './contract';
import { analysisJsonSchema, PROMPT_VERSION } from './schema';
import { blankComments } from './comments';
import { completeJson, ProviderSettings } from './provider';
import { GENERAL_VOICE } from './voice';

export type SourceMeta = {
  file: string;
  crateName?: string;
  docs?: string;
  model: string;
};

export type AnalyzeResult = {
  analysis: Analysis;
  issues: string[];
  raw: string;
  usage?: Usage;
};

const scopeValues: Scope[] = ['fn', 'struct', 'line'];
const traceKinds: TraceKind[] = ['fn', 'struct', 'enum', 'impl'];
const typeKinds: TypeKind[] = ['struct', 'enum', 'trait', 'type', 'fn', 'mod', 'impl'];
const edgeKinds: MemoryEventKind[] = ['move', 'copy', 'clone', 'drop', 'assign'];

export const SYSTEM_PROMPT = [
  'You produce a structured reading of one Rust file for a programmer who knows other languages but not Rust.',
  'Return one JSON object only, with no markdown fences and no text outside it, matching this JSON Schema:',
  JSON.stringify(analysisJsonSchema),
  GENERAL_VOICE,
  'Rules:',
  '- typeInventory: every type declared in the file, one entry each.',
  '- spotlights: at most 14, ordered by line. Quote the construct exactly as it appears, shortened with … only if necessary. Prioritise lifetimes, borrows/moves/clones, async, trait/generic machinery (impl<T>, associated types, blanket impls, dyn), attribute and derive macros, then dense idioms (?, ok_or, map_err, combinators, matches!, let-else, if let, while let, impl Into/AsRef). Never spotlight plain struct, enum, trait, type or module declarations, field access, ordinary method calls, getters, constructors, if/for, modules, or tests. When the construct is a derive or attribute, quote only the attribute lines, not the item declaration that follows.',
  '- means: one sentence with no undefined Rust jargon. equivalent: the desugared or expanded form, or "—" when there is none. trap: one line only when there is a common misreading.',
  '- ownership: only include a group when at least one point is non-obvious. Skip trivial getters, constructors and one-line accessors. At most 10 groups. Each point has scope "fn", "struct" or "line" and exact start/end lines. For fn/struct points use the group range. State only what the code or the supplied project context supports; do not add inferred "why" rationale.',
  '- memory: one to three records, one for each key function with distinct ownership behavior. Include the main loop, the resume or continuation path, and the state-reconstruction helper when the source has them, even when the helper is private; skip trivial helpers and one-line accessors. Do not collapse several key functions into one record. For each record, emit frames; values (bindings, references, temporaries) with stable ids, exact start/end lines, mutability, frame, heap pointers, and for references borrowOf/borrowMode or external; heap objects with type, label, live range, a few cells, optional ptr/len/cap; and events move/copy/clone/drop/assign with line, from, and to or toLabel. A borrow is a reference value (kind "ref", or a temp with borrowOf), not an event. Event endpoints must name ids defined in values or heap; do not use function calls as endpoints. Do not emit per-line snapshots or permissions. Keep each record under 20 values, 12 heap objects and 30 events.',
  '- All line numbers are 1-based and must refer to the numbered source. Do not use HTML.'
].join('\n');

export async function analyzeSource(
  source: string,
  meta: SourceMeta,
  settings: ProviderSettings,
  signal?: AbortSignal
): Promise<AnalyzeResult> {
  const user = buildUserPrompt(source, meta);
  const result = await completeJson(SYSTEM_PROMPT, user, settings, signal);
  const parsed = parseAnalysisJson(result.text);
  const { analysis, issues } = validateAnalysis(parsed, source, meta);

  if (result.usage) {
    analysis.usage = { input: result.usage.input, output: result.usage.output };
  }
  analysis.generatedAt = new Date().toISOString();
  analysis.model = meta.model;

  return { analysis, issues, raw: result.text, usage: analysis.usage };
}

export function buildUserPrompt(source: string, meta: SourceMeta): string {
  const lines = blankComments(source).split(/\r?\n/);
  const numbered = lines
    .map((line, index) => `${String(index + 1).padStart(5, ' ')}  ${line}`)
    .join('\n');

  const parts = [
    `File: ${meta.file}`,
    `Crate: ${meta.crateName ?? 'unknown'}`,
    `Language: Rust`,
    `Lines: ${lines.length}`,
    ''
  ];

  if (meta.docs?.trim()) {
    parts.push('Project context (design notes; may state intent):', '```', truncate(meta.docs, 8000), '```', '');
  }

  parts.push('Numbered source:', '```rust', numbered, '```', '', 'Return the JSON analysis for this file.');
  return parts.join('\n');
}

export function validateAnalysis(
  raw: unknown,
  source: string,
  meta: SourceMeta
): { analysis: Analysis; issues: string[] } {
  if (!isObject(raw)) {
    throw new Error('Model response was not a JSON object.');
  }

  const lines = source.split(/\r?\n/);
  const lineCount = lines.length;
  const issues: string[] = [];

  const typeInventory = sanitizeTypes(raw.typeInventory, lineCount, issues);
  const spotlights = sanitizeSpotlights(raw.spotlights, source, lineCount, issues);
  const ownership = sanitizeGroups(raw.ownership, 'ownership', lineCount, issues);
  const memory = sanitizeMemory(raw.memory, lineCount, issues);

  const analysis: Analysis = {
    version: 1,
    file: meta.file,
    model: meta.model,
    typeInventory,
    spotlights,
    ownership,
    memory
  };

  if (issues.length > 0) {
    analysis.warnings = issues.slice(0, 8);
  }

  return { analysis, issues };
}

function sanitizeTypes(value: unknown, lineCount: number, issues: string[]): TypeItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const out: TypeItem[] = [];
  for (const item of value) {
    if (!isObject(item)) {
      continue;
    }

    const name = text(item.name);
    const kind = text(item.kind) as TypeKind;
    const start = integer(item.start);
    const end = integer(item.end);

    if (!name || !typeKinds.includes(kind) || !validRange(start, end, lineCount)) {
      issues.push('a type inventory entry was dropped');
      continue;
    }

    out.push({ name, kind, start: start as number, end: end as number });
  }

  return out.slice(0, 60);
}

function sanitizeSpotlights(value: unknown, source: string, lineCount: number, issues: string[]): Spotlight[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const out: Spotlight[] = [];
  for (const item of value) {
    if (!isObject(item)) {
      continue;
    }

    const code = text(item.code);
    const means = text(item.means);
    const equivalent = text(item.equivalent);
    let start = integer(item.start);
    let end = integer(item.end);

    if (!code || !means || !equivalent || !validRange(start, end, lineCount)) {
      issues.push('a spotlight was dropped: missing fields or invalid range');
      continue;
    }

    if (isTypeDeclarationQuote(code)) {
      issues.push('a spotlight was dropped: plain type declarations are not spotlights');
      continue;
    }

    const lines = source.split(/\r?\n/);
    if (!quoteFitsRange(code, lines, start as number, end as number)) {
      const snapped = snapQuote(code, source);
      if (snapped) {
        start = snapped.start;
        end = snapped.end;
      } else {
        issues.push(`spotlight "${shorten(code)}" was dropped: its quote was not found in the source`);
        continue;
      }
    }

    const spotlight: Spotlight = {
      code,
      start: start as number,
      end: end as number,
      means,
      equivalent
    };
    const trap = text(item.trap);
    if (trap) {
      spotlight.trap = trap;
    }
    out.push(spotlight);
  }

  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return out.slice(0, 24);
}

function sanitizeGroups(value: unknown, label: string, lineCount: number, issues: string[]): TraceGroup[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const out: TraceGroup[] = [];
  for (const item of value) {
    if (!isObject(item)) {
      continue;
    }

    const name = text(item.name);
    const kind = text(item.kind) as TraceKind;
    const start = integer(item.start);
    const end = integer(item.end);

    if (!name || !traceKinds.includes(kind) || !validRange(start, end, lineCount)) {
      issues.push(`a ${label} group was dropped: missing fields or invalid range`);
      continue;
    }

    const points = sanitizePoints(item.points, start as number, end as number, lineCount, issues);
    if (points.length === 0) {
      issues.push(`a ${label} group was dropped: no valid points`);
      continue;
    }

    out.push({ name, kind, start: start as number, end: end as number, points });
  }

  return out.slice(0, 10);
}

function sanitizePoints(
  value: unknown,
  groupStart: number,
  groupEnd: number,
  lineCount: number,
  issues: string[]
): Point[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const out: Point[] = [];
  for (const item of value) {
    if (!isObject(item)) {
      continue;
    }

    const body = text(item.text);
    const scope = text(item.scope) as Scope;
    let start = integer(item.start);
    let end = integer(item.end);

    if (!body || !scopeValues.includes(scope)) {
      issues.push('an ownership/constraint point was dropped: missing fields');
      continue;
    }

    if (scope !== 'line') {
      start = groupStart;
      end = groupEnd;
    } else if (!validRange(start, end, lineCount) || (start as number) < groupStart || (end as number) > groupEnd) {
      issues.push('an ownership/constraint point was dropped: line range outside its group');
      continue;
    }

    out.push({ text: body, scope, start: start as number, end: end as number });
  }

  return out;
}

function sanitizeMemory(value: unknown, lineCount: number, issues: string[]): MemoryModel[] {
  const items = Array.isArray(value) ? value : isObject(value) ? [value] : [];
  if (items.length === 0) {
    return [];
  }

  const out: MemoryModel[] = [];

  for (const item of items) {
    if (!isObject(item)) {
      continue;
    }

    const fn = text(item.function);
    const start = integer(item.start);
    const end = integer(item.end);
    if (!fn || !validRange(start, end, lineCount)) {
      issues.push('a memory record was dropped: missing function or invalid range');
      continue;
    }

    const recordStart = start as number;
    const recordEnd = end as number;
    const frames = sanitizeFrames(item.frames, recordStart, recordEnd, lineCount, issues);
    if (frames.length === 0) {
      issues.push('a memory record was dropped: no valid frames');
      continue;
    }

    const frameIds = new Set(frames.map((frame) => frame.id));
    const heap = sanitizeHeap(item.heap, recordStart, recordEnd, lineCount, issues);
    const heapIds = new Set(heap.map((box) => box.id));
    const values = sanitizeValues(item.values, frameIds, heapIds, recordStart, recordEnd, lineCount, issues);
    const valueIds = new Set(values.map((entry) => entry.id));

    const validValues: MemoryValue[] = [];
    for (const entry of values) {
      if (entry.kind === 'ref' && !entry.external) {
        if (!entry.borrowOf || (!valueIds.has(entry.borrowOf) && !heapIds.has(entry.borrowOf))) {
          issues.push(`memory value "${entry.name}" was dropped: its borrow target is missing`);
          continue;
        }
        const target = findMemoryTarget(entry.borrowOf, values, heap);
        if (target && (entry.start < target.start || entry.end > target.end)) {
          issues.push(`memory value "${entry.name}" was dropped: its borrow outlives its target`);
          continue;
        }
      }
      validValues.push(entry);
    }

    const validValueIds = new Set(validValues.map((entry) => entry.id));
    const events = sanitizeEvents(
      item.events,
      memoryRanges(validValues, heap),
      recordStart,
      recordEnd,
      lineCount,
      issues
    );

    if (validValues.length < 2 && heap.length === 0) {
      issues.push('a memory record was dropped: too little content');
      continue;
    }

    const record: MemoryModel = {
      function: fn,
      start: recordStart,
      end: recordEnd,
      frames,
      values: validValues,
      heap,
      events
    };

    const returns = text(item.returns);
    if (returns && (validValueIds.has(returns) || heapIds.has(returns))) {
      record.returns = returns;
    }

    out.push(record);
    if (out.length >= 3) {
      break;
    }
  }

  return out;
}

function sanitizeFrames(
  value: unknown,
  start: number,
  end: number,
  lineCount: number,
  issues: string[]
): MemoryFrame[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const out: MemoryFrame[] = [];
  const ids = new Set<string>();

  for (const item of value) {
    if (!isObject(item)) {
      continue;
    }

    const id = text(item.id);
    const name = text(item.name);
    const frameStart = integer(item.start);
    const frameEnd = integer(item.end);

    if (
      !id ||
      !name ||
      !validRange(frameStart, frameEnd, lineCount) ||
      (frameStart as number) < start ||
      (frameEnd as number) > end ||
      ids.has(id)
    ) {
      issues.push('a memory frame was dropped');
      continue;
    }

    ids.add(id);
    const frame: MemoryFrame = {
      id,
      name,
      start: frameStart as number,
      end: frameEnd as number
    };

    if (typeof item.parent === 'string') {
      frame.parent = item.parent;
    } else {
      frame.parent = null;
    }

    out.push(frame);
    if (out.length >= 8) {
      break;
    }
  }

  const frameIds = new Set(out.map((frame) => frame.id));
  for (const frame of out) {
    if (frame.parent && !frameIds.has(frame.parent)) {
      frame.parent = null;
    }
  }

  return out;
}

function sanitizeHeap(
  value: unknown,
  start: number,
  end: number,
  lineCount: number,
  issues: string[]
): MemoryHeap[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const out: MemoryHeap[] = [];
  const ids = new Set<string>();

  for (const item of value) {
    if (!isObject(item)) {
      continue;
    }

    const id = text(item.id);
    const type = text(item.type);
    const label = text(item.label);
    const heapStart = integer(item.start);
    const heapEnd = integer(item.end);

    if (
      !id ||
      !type ||
      !label ||
      !validRange(heapStart, heapEnd, lineCount) ||
      (heapStart as number) < start ||
      (heapEnd as number) > end ||
      ids.has(id)
    ) {
      issues.push('a heap object was dropped');
      continue;
    }

    ids.add(id);
    const box: MemoryHeap = {
      id,
      type,
      label,
      start: heapStart as number,
      end: heapEnd as number
    };

    if (Array.isArray(item.cells)) {
      const cells = item.cells
        .filter((cell): cell is string => typeof cell === 'string')
        .slice(0, 8);
      if (cells.length > 0) {
        box.cells = cells;
      }
    }

    if (isObject(item.layout)) {
      const layout: { ptr?: string; len?: number; cap?: number } = {};
      const ptr = text(item.layout.ptr);
      if (ptr) {
        layout.ptr = ptr;
      }
      const len = integer(item.layout.len);
      if (len !== undefined) {
        layout.len = len;
      }
      const cap = integer(item.layout.cap);
      if (cap !== undefined) {
        layout.cap = cap;
      }
      if (Object.keys(layout).length > 0) {
        box.layout = layout;
      }
    }

    const note = text(item.note);
    if (note) {
      box.note = note;
    }

    out.push(box);
    if (out.length >= 16) {
      break;
    }
  }

  return out;
}

function sanitizeValues(
  value: unknown,
  frameIds: Set<string>,
  heapIds: Set<string>,
  start: number,
  end: number,
  lineCount: number,
  issues: string[]
): MemoryValue[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const out: MemoryValue[] = [];
  const ids = new Set<string>();

  for (const item of value) {
    if (!isObject(item)) {
      continue;
    }

    const id = text(item.id);
    const name = text(item.name);
    const type = text(item.type);
    const frame = text(item.frame);
    const kind = text(item.kind) as MemoryValue['kind'];
    const mutable = typeof item.mutable === 'boolean' ? item.mutable : undefined;
    const valueStart = integer(item.start);
    const valueEnd = integer(item.end);

    if (
      !id ||
      !name ||
      !type ||
      !frame ||
      !frameIds.has(frame) ||
      !['binding', 'ref', 'temp'].includes(kind) ||
      mutable === undefined ||
      !validRange(valueStart, valueEnd, lineCount) ||
      (valueStart as number) < start ||
      (valueEnd as number) > end ||
      ids.has(id)
    ) {
      issues.push('a memory value was dropped');
      continue;
    }

    ids.add(id);
    const entry: MemoryValue = {
      id,
      name,
      type,
      frame,
      kind,
      mutable,
      start: valueStart as number,
      end: valueEnd as number
    };

    const borrowOf = text(item.borrowOf);
    if (borrowOf) {
      entry.borrowOf = borrowOf;
    }

    const borrowMode = text(item.borrowMode);
    if (borrowMode === 'shared' || borrowMode === 'mutable') {
      entry.borrowMode = borrowMode;
    }
    if (kind === 'ref' && !entry.borrowMode) {
      entry.borrowMode = 'shared';
    }

    const external = text(item.external);
    if (external) {
      entry.external = external;
    }

    if (entry.kind !== 'ref' && (entry.borrowOf || entry.borrowMode)) {
      entry.kind = 'ref';
      if (!entry.borrowMode) {
        entry.borrowMode = 'shared';
      }
    }

    if (Array.isArray(item.pointers)) {
      const pointers: MemoryPointer[] = [];
      for (const pointer of item.pointers) {
        if (!isObject(pointer)) {
          continue;
        }
        const heap = text(pointer.heap);
        if (!heap || !heapIds.has(heap)) {
          issues.push('a memory pointer was dropped: its heap object is missing');
          continue;
        }
        const valuePointer: MemoryPointer = { heap };
        const field = text(pointer.field);
        if (field) {
          valuePointer.field = field;
        }
        const pointerKind = text(pointer.kind);
        if (pointerKind === 'owns' || pointerKind === 'borrow') {
          valuePointer.kind = pointerKind;
        }
        pointers.push(valuePointer);
      }
      if (pointers.length > 0) {
        entry.pointers = pointers;
      }
    }

    const note = text(item.note);
    if (note) {
      entry.note = note;
    }

    out.push(entry);
    if (out.length >= 24) {
      break;
    }
  }

  return out;
}

function sanitizeEvents(
  value: unknown,
  ranges: Map<string, { start: number; end: number }>,
  start: number,
  end: number,
  lineCount: number,
  issues: string[]
): MemoryEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const out: MemoryEvent[] = [];
  const moved = new Set<string>();

  for (const item of value) {
    if (!isObject(item)) {
      continue;
    }

    const line = integer(item.line);
    const kind = text(item.kind) as MemoryEventKind;
    const from = text(item.from);

    if (
      line === undefined ||
      !edgeKinds.includes(kind) ||
      !from ||
      line < start ||
      line > end ||
      line > lineCount
    ) {
      issues.push('a memory event was dropped: invalid fields');
      continue;
    }

    const source = ranges.get(from);
    if (!source) {
      issues.push(`a memory event was dropped: source "${from}" is missing`);
      continue;
    }

    if (line < source.start || line > source.end) {
      issues.push('a memory event was dropped: its line is outside the source lifetime');
      continue;
    }

    if ((kind === 'move' || kind === 'drop') && moved.has(from)) {
      issues.push('a memory event was dropped: the source was already moved or dropped');
      continue;
    }

    const to = text(item.to);
    const toLabel = text(item.toLabel);
    if (kind !== 'drop' && !to && !toLabel) {
      issues.push('a memory event was dropped: no destination');
      continue;
    }

    if (to && !ranges.has(to)) {
      issues.push('a memory event was dropped: its destination is missing');
      continue;
    }

    if (kind === 'move' || kind === 'drop') {
      moved.add(from);
    }

    const event: MemoryEvent = { line, kind, from };
    if (to) {
      event.to = to;
    }
    if (toLabel) {
      event.toLabel = toLabel;
    }
    const detail = text(item.detail);
    if (detail) {
      event.detail = detail;
    }

    out.push(event);
    if (out.length >= 40) {
      break;
    }
  }

  out.sort((a, b) => a.line - b.line);
  return out;
}

function memoryRanges(
  values: MemoryValue[],
  heap: MemoryHeap[]
): Map<string, { start: number; end: number }> {
  const ranges = new Map<string, { start: number; end: number }>();
  for (const value of values) {
    ranges.set(value.id, { start: value.start, end: value.end });
  }
  for (const box of heap) {
    ranges.set(box.id, { start: box.start, end: box.end });
  }
  return ranges;
}

function findMemoryTarget(
  id: string,
  values: MemoryValue[],
  heap: MemoryHeap[]
): { start: number; end: number } | undefined {
  const value = values.find((entry) => entry.id === id);
  if (value) {
    return { start: value.start, end: value.end };
  }

  const box = heap.find((entry) => entry.id === id);
  return box ? { start: box.start, end: box.end } : undefined;
}

export function parseAnalysisJson(textValue: string): unknown {
  const start = textValue.indexOf('{');
  const end = textValue.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('Model response contained no JSON object.');
  }

  try {
    return JSON.parse(textValue.slice(start, end + 1));
  } catch {
    throw new Error('Model response was not valid JSON.');
  }
}

function quoteFitsRange(code: string, lines: string[], start: number, end: number): boolean {
  const range = lines.slice(start - 1, end).join('\n');
  return quotePartsMatch(code, range);
}

function quotePartsMatch(code: string, haystack: string): boolean {
  const parts = code.split('…').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    return false;
  }

  const normalizedHaystack = normalizeWhitespace(haystack);
  let cursor = 0;
  for (const part of parts) {
    const needle = normalizeWhitespace(part);
    const index = normalizedHaystack.indexOf(needle, cursor);
    if (index === -1) {
      return false;
    }
    cursor = index + needle.length;
  }
  return true;
}

function snapQuote(code: string, source: string): { start: number; end: number } | undefined {
  if (code.includes('…')) {
    return undefined;
  }

  const pattern = flexiblePattern(code);
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1 || matches[0].index === undefined) {
    return undefined;
  }

  const index = matches[0].index;
  const start = source.slice(0, index).split('\n').length;
  const span = code.split(/\r?\n/).length - 1;
  return { start, end: start + span };
}

function flexiblePattern(code: string): RegExp {
  const parts = code.trim().split(/\s+/).map(escapeRegExp);
  return new RegExp(parts.join('\\s+'), 'g');
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function isTypeDeclarationQuote(code: string): boolean {
  const lines = code
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#['));

  const first = lines[0] ?? '';
  return /^(pub(\([^)]*\))?\s+)?(struct|enum|trait|type|mod)\b/.test(first);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validRange(start: unknown, end: unknown, lineCount: number): boolean {
  return (
    typeof start === 'number' &&
    typeof end === 'number' &&
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 1 &&
    end >= start &&
    end <= lineCount
  );
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function shorten(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ');
  return oneLine.length <= 40 ? oneLine : `${oneLine.slice(0, 39)}…`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n…`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
