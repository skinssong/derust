import {
  IndexRelation,
  ModuleContext,
  ModuleProfile,
  OverviewSymbol,
  ProfileDelegate,
  ProfileFunction,
  ProfileOperation
} from './contract';
import { GENERAL_VOICE } from './voice';

export const PROFILE_PROMPT_VERSION = 'profile-v1';

export type CallGroup = {
  source: string;
  targetModule: string;
  functions: string[];
  start: number;
  end: number;
};

export type ProfileCandidates = {
  file: string;
  modulePath?: string;
  crateName?: string;
  moduleDoc?: string;
  publicSurface: OverviewSymbol[];
  imports: string[];
  callers: IndexRelation[];
  callees: IndexRelation[];
  tests: IndexRelation[];
  dependencies: string[];
  delegates: ProfileDelegate[];
  callGroups: CallGroup[];
  keyFunctions: ProfileFunction[];
};

const profileSchema = {
  type: 'object',
  required: ['role', 'owns', 'delegates', 'operations', 'keyFunctions'],
  properties: {
    role: { type: 'string', description: 'One sentence: what this module is for.' },
    owns: {
      type: 'array',
      minItems: 2,
      maxItems: 5,
      items: { type: 'string' }
    },
    delegates: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        required: ['concern', 'to'],
        properties: {
          concern: { type: 'string' },
          to: { type: 'string' },
          symbols: { type: 'array', items: { type: 'string' } }
        }
      }
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
    keyFunctions: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: {
        type: 'object',
        required: ['name', 'why'],
        properties: {
          name: { type: 'string' },
          why: { type: 'string' }
        }
      }
    }
  }
};

export const PROFILE_SYSTEM_PROMPT = [
  'You write a module profile for a programmer who knows other languages but not Rust.',
  'The reader needs the module’s role and its key operations before reading individual functions.',
  'Return one JSON object only, matching this JSON Schema:',
  JSON.stringify(profileSchema),
  GENERAL_VOICE,
  'Rules:',
  '- role: one sentence, at most 18 words, beginning with a verb or a noun phrase. Say what the module is for, not what it contains.',
  '- owns: 2-5 responsibilities. These are the things this module is accountable for; do not list type names.',
  '- delegates: only concerns that appear in DELEGATES. Name the concern and the target module. Include symbols only when the index lists them.',
  '- operations: 2-5 operations in execution or reading order. An operation is a module-level contract, not a function-by-function list. Use CALL GROUPS and the source to group them. Each operation names its entry function and the functions involved, with a valid line range.',
  '- keyFunctions: 1-3 public functions from PUBLIC FUNCTIONS. Say why each matters. Do not include constructors, getters or one-line accessors.',
  '- Avoid repeating the module docs verbatim. Do not invent callers, callees or dependencies.',
  '- Use active voice and concrete verbs. No marketing language and no bullet-point fragments.'
].join('\n');

export function buildProfileCandidates(
  context: ModuleContext,
  source: string
): ProfileCandidates {
  const publicSurface = context.publicSurface.filter(
    (symbol) => symbol.kind !== 'impl' && symbol.kind !== 'mod'
  );
  const delegates = deriveDelegates(context);
  const callGroups = deriveCallGroups(context, publicSurface);
  const keyFunctions = deriveKeyFunctions(context, publicSurface);
  const imports = source
    .split(/\r?\n/)
    .filter((line) => /^\s*use\s+/.test(line))
    .map((line) => line.trim());

  return {
    file: context.file,
    modulePath: context.modulePath,
    crateName: context.crateName,
    moduleDoc: context.moduleDoc,
    publicSurface,
    imports,
    callers: context.callers,
    callees: context.callees,
    tests: context.tests,
    dependencies: context.dependencies,
    delegates,
    callGroups,
    keyFunctions
  };
}

export function buildProfileUserPrompt(
  source: string,
  candidates: ProfileCandidates
): string {
  const lines = source.split(/\r?\n/);
  const numbered = lines
    .map((line, index) => `${String(index + 1).padStart(5, ' ')}  ${line}`)
    .join('\n');

  return [
    `FILE: ${candidates.file}`,
    `MODULE: ${candidates.modulePath ?? 'unknown'}`,
    `CRATE: ${candidates.crateName ?? 'unknown'}`,
    `MODULE DOCS:\n${candidates.moduleDoc ?? '(none)'}`,
    `PUBLIC SURFACE:\n${formatPublicSurface(candidates.publicSurface)}`,
    `IMPORTS:\n${candidates.imports.join('\n') || '(none)'}`,
    `DELEGATES:\n${formatDelegates(candidates.delegates)}`,
    `CALL GROUPS:\n${formatCallGroups(candidates.callGroups)}`,
    `CALLERS:\n${formatRelations(candidates.callers)}`,
    `CALLEES:\n${formatRelations(candidates.callees)}`,
    `TESTS:\n${formatRelations(candidates.tests)}`,
    `DEPENDENCIES:\n${candidates.dependencies.join(', ') || '(none)'}`,
    `KEY FUNCTION CANDIDATES:\n${formatKeyFunctions(candidates.keyFunctions)}`,
    'SOURCE (numbered, 1-based):',
    numbered,
    'Write the profile. Group the call groups into a small number of operations; do not turn every call edge into an operation. Explain ownership and delegation before listing the operations.'
  ].join('\n\n');
}

export function parseProfileJson(text: string): unknown {
  let value = text.trim();
  if (value.startsWith('```')) {
    value = value.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('Profile response was not valid JSON.');
  }
}

export function validateProfile(
  value: unknown,
  source: string,
  candidates: ProfileCandidates,
  meta: { revision: string }
): { profile: ModuleProfile; issues: string[] } {
  if (!isObject(value)) {
    throw new Error('Profile response was not a JSON object.');
  }

  const issues: string[] = [];
  const lineCount = source.length === 0 ? 0 : source.split(/\r?\n/).length;
  const role = truncate(asString(value.role), 180);
  if (!role) {
    throw new Error('Profile response had no role.');
  }

  const owns = asArray(value.owns)
    .map((item) => truncate(asString(item), 120))
    .filter((item) => item.length > 0)
    .slice(0, 5);
  if (owns.length < 2) {
    issues.push('Profile had fewer than two valid responsibilities.');
  }

  const delegates: ProfileDelegate[] = [];
  const allowedDelegates = new Map(
    candidates.delegates.map((delegate) => [delegate.to, delegate])
  );
  for (const raw of asArray(value.delegates)) {
    if (!isObject(raw)) {
      continue;
    }
    const to = asString(raw.to);
    const concern = truncate(asString(raw.concern), 80);
    const allowed = allowedDelegates.get(to);
    if (!allowed || !concern) {
      issues.push(`Dropped delegation to unknown target "${to}".`);
      continue;
    }
    const symbols = asArray(raw.symbols)
      .map((item) => asString(item))
      .filter((item) => allowed.symbols?.includes(item))
      .slice(0, 8);
    delegates.push({ concern, to, symbols: symbols.length > 0 ? symbols : undefined });
    if (delegates.length === 8) {
      break;
    }
  }

  const operations: ProfileOperation[] = [];
  const allowedFunctions = new Set(candidates.callees.map((item) => item.name));
  for (const raw of asArray(value.operations)) {
    if (!isObject(raw)) {
      continue;
    }
    const name = truncate(asString(raw.name), 70);
    const purpose = truncate(asString(raw.purpose), 240);
    const entry = asString(raw.entry);
    const start = Math.floor(Number(raw.start));
    const end = Math.floor(Number(raw.end));
    const functions = asArray(raw.functions)
      .map((item) => asString(item))
      .filter((item) => allowedFunctions.has(item))
      .slice(0, 8);

    if (
      !name ||
      !purpose ||
      !entry ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 1 ||
      end < start ||
      start > lineCount
    ) {
      issues.push(`Dropped operation "${name || '(unnamed)'}" with an invalid range or text.`);
      continue;
    }

    operations.push({
      name,
      purpose,
      entry,
      functions,
      start,
      end: Math.min(end, lineCount)
    });
    if (operations.length === 5) {
      break;
    }
  }

  operations.sort((left, right) => left.start - right.start);
  if (operations.length < 2) {
    throw new Error('Profile response had too few valid operations.');
  }

  const keyFunctions: ProfileFunction[] = [];
  const publicFunctions = new Map(
    candidates.publicSurface
      .filter((symbol) => symbol.kind === 'fn')
      .map((symbol) => [symbol.name, symbol])
  );
  for (const raw of asArray(value.keyFunctions)) {
    if (!isObject(raw)) {
      continue;
    }
    const name = asString(raw.name);
    const symbol = publicFunctions.get(name);
    if (!symbol) {
      issues.push(`Dropped unknown key function "${name}".`);
      continue;
    }
    const why = truncate(asString(raw.why), 200);
    if (!why) {
      continue;
    }
    keyFunctions.push({
      name,
      start: symbol.start,
      end: symbol.end,
      why
    });
    if (keyFunctions.length === 3) {
      break;
    }
  }

  return {
    profile: {
      version: 1,
      file: candidates.file,
      revision: meta.revision,
      role,
      owns,
      delegates,
      operations,
      keyFunctions
    },
    issues
  };
}

export function formatModuleProfile(profile: ModuleProfile): string {
  const lines = [
    `# Module profile: ${profile.file}`,
    '',
    `Revision: ${profile.revision.slice(0, 16)}`,
    '',
    '## Role',
    '',
    profile.role,
    '',
    '## Owns',
    '',
    ...profile.owns.map((item) => `- ${item}`),
    '',
    '## Delegates',
    '',
    ...profile.delegates.map(
      (delegate) =>
        `- ${delegate.concern} → ${delegate.to}${
          delegate.symbols?.length ? ` (${delegate.symbols.join(', ')})` : ''
        }`
    ),
    '',
    '## Operations',
    ''
  ];

  for (const operation of profile.operations) {
    lines.push(
      `### ${operation.name} — L${operation.start}-${operation.end}`,
      '',
      operation.purpose,
      '',
      `Entry: \`${operation.entry}\``,
      operation.functions.length > 0
        ? `Functions: ${operation.functions.map((item) => `\`${item}\``).join(', ')}`
        : '',
      ''
    );
  }

  lines.push('## Key functions', '');
  for (const fn of profile.keyFunctions) {
    lines.push(`- \`${fn.name}\` L${fn.start}-${fn.end} — ${fn.why}`);
  }

  return `${lines.filter((line) => line !== undefined).join('\n').trim()}\n`;
}

function deriveDelegates(context: ModuleContext): ProfileDelegate[] {
  const groups = new Map<string, Set<string>>();

  for (const relation of context.callees) {
    if (relation.file === context.file || relation.file.startsWith('tests/')) {
      continue;
    }
    const to = moduleNameForFile(relation.file);
    if (!groups.has(to)) {
      groups.set(to, new Set());
    }
    groups.get(to)?.add(relation.name);
  }

  return Array.from(groups.entries())
    .map(([to, symbols]) => ({
      concern: to.split('::').pop() ?? to,
      to,
      symbols: Array.from(symbols).sort()
    }))
    .sort((left, right) => left.to.localeCompare(right.to));
}

function deriveCallGroups(
  context: ModuleContext,
  publicSurface: OverviewSymbol[]
): CallGroup[] {
  const groups = new Map<
    string,
    { source: string; targetModule: string; functions: Set<string>; start: number; end: number }
  >();

  for (const relation of context.callees) {
    if (!relation.source) {
      continue;
    }
    const targetModule = moduleNameForFile(relation.file);
    const key = `${relation.source}\0${targetModule}`;
    const symbol = publicSurface.find(
      (candidate) => candidate.name === relation.source && candidate.kind === 'fn'
    );
    const existing = groups.get(key);
    if (existing) {
      existing.functions.add(relation.name);
      existing.start = Math.min(existing.start, symbol?.start ?? relation.line);
      existing.end = Math.max(existing.end, symbol?.end ?? relation.line);
    } else {
      groups.set(key, {
        source: relation.source,
        targetModule,
        functions: new Set([relation.name]),
        start: symbol?.start ?? relation.line,
        end: symbol?.end ?? relation.line
      });
    }
  }

  return Array.from(groups.values())
    .map((group) => ({
      source: group.source,
      targetModule: group.targetModule,
      functions: Array.from(group.functions).sort(),
      start: group.start,
      end: group.end
    }))
    .sort(
      (left, right) =>
        left.start - right.start ||
        left.source.localeCompare(right.source) ||
        left.targetModule.localeCompare(right.targetModule)
    )
    .slice(0, 40);
}

function deriveKeyFunctions(
  context: ModuleContext,
  publicSurface: OverviewSymbol[]
): ProfileFunction[] {
  const functions = publicSurface.filter((symbol) => symbol.kind === 'fn');
  const scored = functions.map((symbol) => {
    const incoming = context.callers.filter((relation) => relation.target === symbol.name);
    const outgoing = context.callees.filter((relation) => relation.source === symbol.name);
    const external = incoming.filter((relation) => !relation.file.startsWith('tests/'));
    const entry = external.some((relation) => /(^|\/)main\.rs$/.test(relation.file));
    const score = incoming.length * 2 + outgoing.length + (entry ? 10 : 0);
    const why = entry
      ? `Entry point called from ${external[0]?.file ?? 'outside the module'}.`
      : incoming.length > 0
        ? `Called from ${incoming.length} place${incoming.length === 1 ? '' : 's'} and orchestrates ${outgoing.length} call${outgoing.length === 1 ? '' : 's'}.`
        : `Public entry point that orchestrates ${outgoing.length} call${outgoing.length === 1 ? '' : 's'}.`;
    return { symbol, score, why };
  });

  return scored
    .sort((left, right) => right.score - left.score || left.symbol.start - right.symbol.start)
    .slice(0, 3)
    .map(({ symbol, why }) => ({
      name: symbol.name,
      start: symbol.start,
      end: symbol.end,
      why
    }));
}

function moduleNameForFile(file: string): string {
  let cleaned = file.replace(/\.rs$/, '');
  if (cleaned === 'src/lib' || cleaned === 'src/main') {
    return 'crate';
  }
  if (cleaned.startsWith('src/')) {
    cleaned = cleaned.slice(4);
  }
  cleaned = cleaned.replace(/\/mod$/, '');
  return cleaned ? `crate::${cleaned.split('/').join('::')}` : 'crate';
}

export function formatPublicSurface(symbols: OverviewSymbol[]): string {
  return (
    symbols
      .slice(0, 24)
      .map(
        (symbol) =>
          `${symbol.kind} ${symbol.name} L${symbol.start}-${symbol.end}${
            symbol.signature ? ` — ${symbol.signature}` : ''
          }`
      )
      .join('\n') || '(none)'
  );
}

export function formatDelegates(delegates: ProfileDelegate[]): string {
  return (
    delegates
      .map(
        (delegate) =>
          `${delegate.to} (${delegate.concern})${
            delegate.symbols?.length ? `: ${delegate.symbols.join(', ')}` : ''
          }`
      )
      .join('\n') || '(none)'
  );
}

export function formatCallGroups(groups: CallGroup[]): string {
  return (
    groups
      .map(
        (group) =>
          `${group.source} → ${group.targetModule}: ${group.functions.join(', ')} (L${group.start}-${group.end})`
      )
      .join('\n') || '(none)'
  );
}

export function formatRelations(relations: IndexRelation[]): string {
  return (
    relations
      .slice(0, 30)
      .map(
        (relation) =>
          `${relation.source ?? relation.name} → ${relation.target ?? relation.name} (${relation.file}:${relation.line})`
      )
      .join('\n') || '(none)'
  );
}

function formatKeyFunctions(functions: ProfileFunction[]): string {
  return (
    functions
      .map((fn) => `${fn.name} L${fn.start}-${fn.end} — ${fn.why}`)
      .join('\n') || '(none)'
  );
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
  return `${(lastSpace > 40 ? slice.slice(0, lastSpace) : slice).trimEnd()}…`;
}
