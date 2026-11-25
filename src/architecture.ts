import { blankComments } from './comments';
export type ArchOccurrenceKind = 'call' | 'type use' | 'impl' | 'reference';

export type ArchSnippetLine = { line: number; text: string };

export type ArchOccurrence = {
  kind: ArchOccurrenceKind;
  file: string;
  line: number;
  label: string;
  snippet: ArchSnippetLine[];
};

export type ArchSymbol = {
  name: string;
  kind: string;
  file: string;
  start: number;
  end: number;
  occurrences: ArchOccurrence[];
};

export type ArchRole = 'data' | 'behavior' | 'mixed' | 'empty';

export type NodeSizeClass = 'small' | 'medium' | 'large';

/** Fixed boxes per size class; the contrast is deliberate. */
export const NODE_BOX: Record<NodeSizeClass, { w: number; h: number }> = {
  small: { w: 96, h: 40 },
  medium: { w: 152, h: 54 },
  large: { w: 208, h: 70 }
};

export type ArchComponent = {
  id: string;
  label: string;
  modules: string[];
  symbols: ArchSymbol[];
  external?: boolean;
  /** data: types whose functions never take a foreign type as input.
   * behavior: functions only. mixed: both. */
  role: ArchRole;
  codeLines: number;
  /** Distinct foreign symbols this component references. */
  dependencies: number;
  callSites: number;
  incomingCalls: number;
  incomingComponents: number;
  sizeClass: NodeSizeClass;
  w: number;
  h: number;
};

export type ArchEdge = {
  source: string;
  target: string;
  label: string;
  kinds: Record<string, number>;
  occurrences: ArchOccurrence[];
  /** Orthogonal bend points as segment weights/distances, relative to the
   * source and target node positions. Filled by the ELK layout pass. */
  segW?: number[];
  segD?: number[];
};

export type BriefModule = {
  id: string;
  file: string;
  description: string;
  role: ArchRole;
  sizeClass: NodeSizeClass;
  codeLines: number;
  callSites: number;
  incomingCalls: number;
  incomingComponents: number;
  dependencies: number;
};

export type BriefStart = BriefModule & { reason: string };

export type BriefOverview = {
  identity: string;
  start: string;
  what: string;
  appearsTo: string;
  evidence: string[];
  flow: string;
  dataFlow: string;
  transformations: string;
  technology: string;
  map: string;
};

type ArchTransform = {
  function: string;
  component: string;
  inputs: string[];
  output: string;
  usage: number;
  callCount: number;
  /** True when the function returns its own type (Self): construction. */
  selfBuild: boolean;
};

export type ProjectBrief = {
  overview: BriefOverview;
  startHere: BriefStart[];
  modules: BriefModule[];
  carriers: Array<{ name: string; owner: string; users: string[] }>;
  notes: string[];
};

export type ArchitectureModel = {
  meta: {
    revision: string;
    crate: string;
    root: string;
    components: number;
    indexedReferences: number;
    edges: number;
  };
  nodes: ArchComponent[];
  edges: ArchEdge[];
  positions: Record<string, [number, number]>;
  brief: ProjectBrief;
  /** Comment-free excerpts of the highest-signal source files, for the
   * deeper-dive narrative. */
  codeSample: string;
};

export type RawOccurrence = {
  file: string;
  line: number;
  kind: ArchOccurrenceKind;
  /** Resolved caller, when the call hierarchy knows it. */
  caller?: string;
};

export type RawSymbol = {
  file: string;
  name: string;
  kind: string;
  start: number;
  end: number;
  signature?: string;
  occurrences: RawOccurrence[];
};

export type ArchitectureInput = {
  revision: string;
  crate: string;
  root: string;
  symbols: RawSymbol[];
  sources: Record<string, string[]>;
  dependencies?: string[];
  maxSymbolOccurrences?: number;
  maxEdgeOccurrences?: number;
};

const MAX_SYMBOL_OCCURRENCES = 40;
const MAX_EDGE_OCCURRENCES = 16;

/** A component is the top-level module under `src/`: `src/main.rs` is
 * `main`, `src/tools/bash.rs` is `tools`. Files outside `src/` have no
 * component: the view describes the crate's own architecture. */
export function componentIdFor(file: string): string | undefined {
  const clean = file.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!clean.endsWith('.rs')) {
    return undefined;
  }
  const parts = clean.replace(/\.rs$/, '').split('/');
  if (parts[0] !== 'src' || parts.length < 2) {
    return undefined;
  }
  return parts[1];
}

/** Lines that belong to a `use` statement, including continuation lines of
 * multi-line imports. */
export function useLineSet(lines: string[]): Set<number> {
  const result = new Set<number>();
  let inUse = false;
  stripComments(lines).forEach((raw, index) => {
    const line = raw.trim();
    if (inUse) {
      result.add(index + 1);
      if (line.endsWith(';')) {
        inUse = false;
      }
      return;
    }
    if (/^(pub(?:\([^)]*\))?\s+)?use\b/.test(line)) {
      result.add(index + 1);
      if (!line.endsWith(';')) {
        inUse = true;
      }
    }
  });
  return result;
}

export function isUseLine(text: string): boolean {
  return /^\s*(pub\s*)?use\s+/.test(text);
}

/** Reference providers sometimes include the declaration itself; a
 * declaration is not a usage and must not be shown as one. */
export function isDefinitionLine(symbolKind: string, text: string, name: string): boolean {
  const simple = (name.split('::').pop() ?? name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keyword =
    symbolKind === 'fn' || symbolKind === 'method'
      ? '(?:async\\s+)?fn'
      : symbolKind === 'struct' || symbolKind === 'enum' || symbolKind === 'trait' || symbolKind === 'type' || symbolKind === 'const'
        ? symbolKind
        : 'fn';
  return new RegExp(`\\b(?:${keyword})\\s+${simple}\\b`).test(text);
}

export function classifyOccurrence(
  symbolKind: string,
  lineText: string,
  name: string
): ArchOccurrenceKind {
  const simple = name.split('::').pop() ?? name;
  const escaped = simple.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (symbolKind === 'fn' || symbolKind === 'method') {
    return new RegExp(`\\b${escaped}\\s*\\(`).test(lineText) ? 'call' : 'reference';
  }
  if (/\bimpl\b/.test(lineText)) {
    return 'impl';
  }
  return 'type use';
}

export function buildArchitecture(input: ArchitectureInput): ArchitectureModel {
  const maxSymbol = input.maxSymbolOccurrences ?? MAX_SYMBOL_OCCURRENCES;
  const maxEdge = input.maxEdgeOccurrences ?? MAX_EDGE_OCCURRENCES;

  const components = new Map<
    string,
    { modules: Set<string>; symbols: ArchSymbol[] }
  >();
  const ensure = (id: string) => {
    let entry = components.get(id);
    if (!entry) {
      entry = { modules: new Set(), symbols: [] };
      components.set(id, entry);
    }
    return entry;
  };

  for (const file of Object.keys(input.sources)) {
    const owner = componentIdFor(file);
    if (owner) {
      ensure(owner).modules.add(file);
    }
  }

  for (const symbol of input.symbols) {
    const owner = componentIdFor(symbol.file);
    if (!owner) {
      continue;
    }
    ensure(owner).modules.add(symbol.file);
  }

  // Role: a module is data when it defines types and none of its functions
  // take a type from another module as a parameter.
  const typeOwner = new Map<string, string>();
  for (const symbol of input.symbols) {
    const owner = componentIdFor(symbol.file);
    if (!owner) {
      continue;
    }
    if (isTypeKind(symbol.kind) && !typeOwner.has(symbol.name)) {
      typeOwner.set(symbol.name, owner);
    }
  }
  const hasTypes = new Map<string, number>();
  const hasFunctions = new Map<string, number>();
  const behavioral = new Set<string>();
  for (const symbol of input.symbols) {
    const owner = componentIdFor(symbol.file);
    if (!owner) {
      continue;
    }
    if (isTypeKind(symbol.kind)) {
      hasTypes.set(owner, (hasTypes.get(owner) || 0) + 1);
    } else if (symbol.kind === 'fn' || symbol.kind === 'method') {
      hasFunctions.set(owner, (hasFunctions.get(owner) || 0) + 1);
      if (symbol.signature && takesForeignType(symbol, owner, typeOwner)) {
        behavioral.add(owner);
      }
    }
  }
  // Implementing a trait defined in another module is behavior, even when a
  // signature scan finds no foreign parameters (tool impls, async_trait, ...).
  const implPattern = /\bimpl(?:\s*<[^>]*>)?\s+([A-Z][A-Za-z0-9_]*)\s+for\s+/;
  for (const [file, lines] of Object.entries(input.sources)) {
    const owner = componentIdFor(file);
    if (!owner) {
      continue;
    }
    for (const line of lines) {
      const match = implPattern.exec(line);
      if (!match) {
        continue;
      }
      const traitOwner = typeOwner.get(match[1]);
      if (traitOwner && traitOwner !== owner) {
        behavioral.add(owner);
        break;
      }
    }
  }

  // Constructors are not behavior: a function that returns a type owned by
  // its own module (usually Self) builds data, so its call sites count as
  // type uses of that type rather than calls.
  const constructionTargets = new Map<RawSymbol, string>();
  for (const symbol of input.symbols) {
    const owner = componentIdFor(symbol.file);
    if (!owner) {
      continue;
    }
    const target = constructionTarget(symbol, owner, typeOwner);
    if (target) {
      constructionTargets.set(symbol, target);
    }
  }

  const dependencySets = new Map<string, Set<string>>();
  const callSites = new Map<string, number>();
  const targetCallSites = new Map<string, number>();
  const targetCallers = new Map<string, Set<string>>();
  const dataFlow = new Map<string, { inputs: Set<string>; outputs: Set<string> }>();

  const transformations = new Map<string, ArchTransform>();
  for (const symbol of input.symbols) {
    const owner = componentIdFor(symbol.file);
    if (!owner || (symbol.kind !== 'fn' && symbol.kind !== 'method') || !symbol.signature) {
      continue;
    }
    const carriers = carrierTypes(symbol.signature, typeOwner);
    let output = carriers.output;
    let selfBuild = false;
    if (!output) {
      const bounds = parameterBounds(symbol.signature);
      const arrow = bounds ? symbol.signature.indexOf('->', bounds[1]) : -1;
      const core =
        arrow >= 0 ? returnCore(symbol.signature.slice(arrow + 2)) : undefined;
      if (core === 'Self' && symbol.name.includes('::')) {
        const own = symbol.name.split('::')[0];
        if (typeOwner.has(own)) {
          output = own;
          selfBuild = true;
        }
      }
    }
    if (!output || carriers.inputs.length === 0) {
      continue;
    }
    if (symbol.name.includes('::') && output === symbol.name.split('::')[0]) {
      selfBuild = true;
    }
    const simple = symbol.name.split('::').pop() ?? symbol.name;
    const key = `${simple}|${carriers.inputs.slice().sort().join(',')}|${output}`;
    const entry: ArchTransform = {
      function: symbol.name,
      component: owner,
      inputs: carriers.inputs,
      output,
      usage: symbol.occurrences.length,
      callCount: symbol.occurrences.filter((occurrence) => occurrence.kind === 'call').length,
      selfBuild
    };
    const existing = transformations.get(key);
    if (!existing || entry.usage > existing.usage) {
      transformations.set(key, entry);
    }
  }

  const edges = new Map<string, ArchEdge>();

  for (const symbol of input.symbols) {
    const owner = componentIdFor(symbol.file);
    if (!owner) {
      continue;
    }
    const construction = constructionTargets.get(symbol);
    const occurrenceSeen = new Set<string>();
    const occurrences: ArchOccurrence[] = [];

    for (const raw of symbol.occurrences) {
      const sourceComponent = componentIdFor(raw.file);
      if (!sourceComponent) {
        continue;
      }
      const key = `${raw.file}\0${raw.line}`;
      if (occurrenceSeen.has(key)) {
        continue;
      }
      occurrenceSeen.add(key);
      const constructing = construction !== undefined && raw.kind === 'call';
      const occurrence: ArchOccurrence = {
        kind: constructing ? 'type use' : raw.kind,
        file: raw.file,
        line: raw.line,
        label: constructing
          ? construction
          : raw.caller
            ? `${raw.caller} → ${symbol.name}`
            : symbol.name,
        snippet: snippetFor(input.sources, raw.file, raw.line)
      };
      occurrences.push(occurrence);

      if (sourceComponent === owner) {
        continue;
      }
      let dependencies = dependencySets.get(sourceComponent);
      if (!dependencies) {
        dependencies = new Set();
        dependencySets.set(sourceComponent, dependencies);
      }
      dependencies.add(constructing ? construction! : symbol.name);
      if (raw.kind === 'call' && !constructing) {
        callSites.set(sourceComponent, (callSites.get(sourceComponent) || 0) + 1);
        targetCallSites.set(owner, (targetCallSites.get(owner) ?? 0) + 1);
        let callers = targetCallers.get(owner);
        if (!callers) {
          callers = new Set();
          targetCallers.set(owner, callers);
        }
        callers.add(sourceComponent);
        const carriers = carrierTypes(symbol.signature, typeOwner);
        const flowKey = `${sourceComponent}->${owner}`;
        let bucket = dataFlow.get(flowKey);
        if (!bucket) {
          bucket = { inputs: new Set(), outputs: new Set() };
          dataFlow.set(flowKey, bucket);
        }
        for (const input of carriers.inputs) {
          bucket.inputs.add(input);
        }
        if (carriers.output) {
          bucket.outputs.add(carriers.output);
        }
      }
      const edgeKey = `${sourceComponent}->${owner}`;
      let edge = edges.get(edgeKey);
      if (!edge) {
        edge = {
          source: sourceComponent,
          target: owner,
          label: '',
          kinds: {},
          occurrences: []
        };
        edges.set(edgeKey, edge);
      }
      if (!edge.occurrences.some((item) => item.file === occurrence.file && item.line === occurrence.line && item.label === occurrence.label)) {
        edge.occurrences.push(occurrence);
      }
    }

    ensure(owner).symbols.push({
      name: symbol.name,
      kind: symbol.kind,
      file: symbol.file,
      start: symbol.start,
      end: symbol.end,
      occurrences: sortOccurrences(occurrences).slice(0, maxSymbol)
    });
  }

  for (const edge of edges.values()) {
    sortOccurrences(edge.occurrences);
    edge.occurrences = dedupeOccurrences(edge.occurrences).slice(0, maxEdge);
    const calls = edge.occurrences.filter((item) => item.kind === 'call').length;
    const uses = edge.occurrences.length - calls;
    if (calls > 0) {
      edge.kinds.calls = calls;
    }
    if (uses > 0) {
      edge.kinds.uses = uses;
    }
    const bits: string[] = [];
    if (calls > 0) {
      bits.push(`calls ×${calls}`);
    }
    if (uses > 0) {
      bits.push(`uses ×${uses}`);
    }
    edge.label = bits.join(' · ');
  }

  // A module that only wires other modules (`pub mod`, `use`, `pub use`)
  // and has no edges of its own is scaffolding, not architecture.
  const connected = new Set<string>();
  for (const edge of edges.values()) {
    connected.add(edge.source);
    connected.add(edge.target);
  }
  for (const [id, entry] of Array.from(components.entries())) {
    if (connected.has(id)) {
      continue;
    }
    const modules = Array.from(entry.modules);
    if (
      modules.length > 0 &&
      modules.every((file) => isModuleWiring(input.sources[file] ?? []))
    ) {
      components.delete(id);
    }
  }

  const ids = Array.from(components.keys()).sort();
  const codeLinesById = new Map<string, number>();
  for (const id of ids) {
    const entry = components.get(id)!;
    codeLinesById.set(
      id,
      Array.from(entry.modules).reduce(
        (total, file) => total + countCodeLines(input.sources[file] ?? []),
        0
      )
    );
  }
  const sizeClassById = new Map<string, NodeSizeClass>();
  const classes = sizeClasses(ids.map((id) => codeLinesById.get(id) ?? 0));
  ids.forEach((id, index) => sizeClassById.set(id, classes[index]));

  const nodes: ArchComponent[] = ids.map((id) => {
    const entry = components.get(id)!;
    const typed = (hasTypes.get(id) || 0) > 0;
    const functional = (hasFunctions.get(id) || 0) > 0;
    const calls = callSites.get(id) ?? 0;
    const role: ArchRole =
      !typed && !functional
        ? 'empty'
        : typed && (behavioral.has(id) || calls > 0)
          ? 'mixed'
          : typed
            ? 'data'
            : 'behavior';
    const sizeClass = sizeClassById.get(id) ?? 'small';
    const size = NODE_BOX[sizeClass];
    return {
      id,
      label: id,
      modules: Array.from(entry.modules).sort(),
      symbols: entry.symbols.sort((left, right) => left.name.localeCompare(right.name)),
      role,
      codeLines: codeLinesById.get(id) ?? 0,
      dependencies: (dependencySets.get(id) ?? new Set<string>()).size,
      callSites: callSites.get(id) ?? 0,
      incomingCalls: targetCallSites.get(id) ?? 0,
      incomingComponents: (targetCallers.get(id) ?? new Set<string>()).size,
      sizeClass,
      w: size.w,
      h: size.h
    };
  });

  const edgeList = Array.from(edges.values()).sort(
    (left, right) =>
      left.source.localeCompare(right.source) || left.target.localeCompare(right.target)
  );

  const indexedReferences = nodes.reduce(
    (total, node) => total + node.symbols.reduce((sum, symbol) => sum + symbol.occurrences.length, 0),
    0
  );

  const codeSample = buildCodeSample(input.sources, nodes);

  return {
    meta: {
      revision: input.revision,
      crate: input.crate,
      root: input.root,
      components: nodes.length,
      indexedReferences,
      edges: edgeList.length
    },
    nodes,
    edges: edgeList,
    positions: layeredPositions(ids, edgeList),
    codeSample,
    brief: buildProjectBrief(
      input.crate,
      nodes,
      edgeList,
      input.dependencies ?? [],
      Object.values(input.sources).some((lines) =>
        lines.some((line) => /\basync\s+fn\b/.test(line))
      ),
      entryComponents(input.sources),
      dataFlow,
      input.sources,
      Array.from(transformations.values())
    )
  };
}

function primaryFile(modules: string[]): string {
  const sorted = modules
    .slice()
    .sort(
      (left, right) =>
        Number(!left.endsWith('/mod.rs')) - Number(!right.endsWith('/mod.rs')) ||
        left.localeCompare(right)
    );
  return sorted[0] ?? '';
}

/** Components whose sources define a `fn main`, private or not. */
/** Turn a set of directed moves into up to two compact chains. */
function summarizePaths(paths: Set<string>): string {
  const adjacency = new Map<string, Set<string>>();
  const incoming = new Set<string>();
  for (const path of paths) {
    const parts = path.split('→').map((part) => part.trim());
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      continue;
    }
    const targets = adjacency.get(parts[0]) ?? new Set<string>();
    targets.add(parts[1]);
    adjacency.set(parts[0], targets);
    incoming.add(parts[1]);
  }
  const starts = Array.from(adjacency.keys())
    .filter((node) => !incoming.has(node))
    .sort(
      (left, right) =>
        Number(right === 'main') - Number(left === 'main') || left.localeCompare(right)
    );
  const chains: string[] = [];
  for (const start of starts) {
    const chain = [start];
    let current = start;
    while (chain.length < 4) {
      const next = Array.from(adjacency.get(current) ?? [])
        .filter((node) => !chain.includes(node))
        .sort()[0];
      if (!next) {
        break;
      }
      chain.push(next);
      current = next;
    }
    if (chain.length > 1) {
      chains.push(chain.join(' → '));
    }
    if (chains.length >= 2) {
      break;
    }
  }
  if (chains.length === 0) {
    return Array.from(paths).sort()[0] ?? '—';
  }
  return chains.join('; ');
}

/** Render called transformations as typed input → output lines. */
function formatTransformations(transforms: ArchTransform[]): string {
  if (transforms.length === 0) {
    return 'No called transformations are indexed.';
  }
  const simple = (name: string): string => name.split('::').pop() ?? name;
  const lines = transforms.map(
    (transform) =>
      `${transform.inputs.join(' + ')} → ${transform.output} (${transform.component}::${simple(
        transform.function
      )})`
  );
  return `${lines.join('; ')}.`;
}

type CodeSignals = {
  toolImpls: string[];
  toolNames: string[];
  http: boolean;
  llm: boolean;
  toolContract: boolean;
  records: boolean;
  replays: boolean;
  cli: boolean;
  server: boolean;
  resume: boolean;
  evidence: string[];
};

/** Capability evidence read from the code itself: string literals, field
 * names, trait impls, entry code. Comments are blanked first, so a comment
 * can never produce evidence. */
function inspectCode(
  sources: Record<string, string[]>,
  dependencies: string[]
): CodeSignals {
  const signals: CodeSignals = {
    toolImpls: [],
    toolNames: [],
    http: false,
    llm: false,
    toolContract: false,
    records: false,
    replays: false,
    cli: false,
    server: false,
    resume: false,
    evidence: []
  };
  const notes = new Map<string, string>();
  const note = (kind: string, message: string): void => {
    if (!notes.has(kind)) {
      notes.set(kind, message);
    }
  };
  const toolImpls = new Set<string>();
  const toolNames = new Set<string>();

  for (const [file, lines] of Object.entries(sources)) {
    const code = blankComments(lines.join('\n'));
    const label = file.replace(/^src\//, '');
    if (/\breqwest\b/.test(code)) {
      signals.http = true;
      note('http', `${label}: reqwest HTTP client`);
    }
    if (code.includes('chat/completions')) {
      signals.llm = true;
      note('llm', `${label}: chat-completions endpoint`);
    } else if (
      ['max_tokens', 'tool_calls', 'choices', '"role"'].filter((signal) =>
        code.includes(signal)
      ).length >= 2
    ) {
      signals.llm = signals.llm || signals.http;
      note('llm', `${label}: model wire fields`);
    }
    if (/\btrait\s+Tool\b/.test(code) || /\bimpl\s+Tool\s+for\b/.test(code)) {
      signals.toolContract = true;
    }
    for (const match of code.matchAll(/impl\s+Tool\s+for\s+([A-Z][A-Za-z0-9_]*)/g)) {
      toolImpls.add(match[1]);
    }
    for (const match of code.matchAll(/"(read_file|write_file|list_dir|bash|search)"/g)) {
      toolNames.add(match[1]);
    }
    if (/OpenOptions/.test(code) && /jsonl|serde_json::to_string|write_all/.test(code)) {
      signals.records = true;
      note('records', `${label}: append-only event log`);
    }
    if (/\bfn\s+resume\b/.test(code) && /\bApproval\b/.test(code)) {
      signals.resume = true;
      note('resume', `${label}: pause and resume through Approval`);
    }
    if (/\bfn\s+main\s*\(/.test(code) && /env::args|std::env|Arg::/.test(code)) {
      signals.cli = true;
      note('cli', `${label}: argv entry point`);
    }
    if (/TcpListener|axum|warp|hyper::|Server::|listener/.test(code)) {
      signals.server = true;
      note('server', `${label}: HTTP server`);
    }
    if (file.startsWith('src/replay') && /\bEvent\b/.test(code)) {
      signals.replays = true;
      note('replay', `${label}: replays recorded events`);
    }
  }

  signals.toolImpls = Array.from(toolImpls).sort();
  signals.toolNames = Array.from(toolNames).sort();
  if (toolImpls.size > 0 || toolNames.size > 0) {
    const parts: string[] = [];
    if (toolImpls.size > 0) {
      parts.push(`Tool implementations: ${Array.from(toolImpls).sort().slice(0, 6).join(', ')}`);
    }
    if (toolNames.size > 0) {
      parts.push(`declared tool names: ${Array.from(toolNames).sort().slice(0, 6).join(', ')}`);
    }
    note('tools', parts.join('; '));
  }
  if (dependencies.includes('reqwest') && !notes.has('http')) {
    note('http', 'Cargo.toml: reqwest');
  }

  const priority = ['llm', 'tools', 'records', 'resume', 'replay', 'cli', 'server', 'http'];
  signals.evidence = priority
    .map((kind) => notes.get(kind))
    .filter((item): item is string => Boolean(item));
  return signals;
}

function entryComponents(sources: Record<string, string[]>): Set<string> {
  const entries = new Set<string>();
  for (const [file, lines] of Object.entries(sources)) {
    const owner = componentIdFor(file);
    if (!owner) {
      continue;
    }
    if (lines.some((line) => /^\s*(pub\s+)?(async\s+)?fn\s+main\s*\(/.test(line))) {
      entries.add(owner);
    }
  }
  return entries;
}

/** Crate-defined types in a signature: inputs and the returned type. */
function carrierTypes(
  signature: string | undefined,
  typeOwner: Map<string, string>
): { inputs: string[]; output?: string } {
  const params = parameterList(signature) ?? '';
  const names = params.match(/\b[A-Z][A-Za-z0-9_]*\b/g) ?? [];
  const inputs = Array.from(
    new Set(names.filter((name) => name !== 'Self' && typeOwner.has(name)))
  );
  const bounds = parameterBounds(signature);
  let output: string | undefined;
  if (signature && bounds) {
    const arrow = signature.indexOf('->', bounds[1]);
    if (arrow !== -1) {
      const core = returnCore(signature.slice(arrow + 2));
      if (core && core !== 'Self' && typeOwner.has(core)) {
        output = core;
      }
    }
  }
  return { inputs, output };
}

function shortList(items: string[], max: number): string {
  const head = items.slice(0, max).join(', ');
  return items.length > max ? `${head} +${items.length - max}` : head;
}

/** The module description, derived from symbols only. Names are ranked by
 * how often the index sees them, so entry points and constructors beat
 * alphabetically first helpers. */
function moduleDescription(node: ArchComponent): string {
  const usage = (symbol: ArchSymbol): number => symbol.occurrences.length;
  const types = node.symbols
    .filter((symbol) => isTypeKind(symbol.kind))
    .sort((left, right) => usage(right) - usage(left) || left.name.localeCompare(right.name))
    .map((symbol) => symbol.name);
  const freeFunctions = node.symbols
    .filter((symbol) => symbol.kind === 'fn' && !symbol.name.includes('::'))
    .sort((left, right) => usage(right) - usage(left) || left.name.localeCompare(right.name));

  const methodGroups = new Map<string, ArchSymbol[]>();
  for (const symbol of node.symbols) {
    if (symbol.kind !== 'fn' || !symbol.name.includes('::')) {
      continue;
    }
    const parts = symbol.name.split('::');
    const prefix = parts[0];
    if (parts.length > 2 || prefix.includes('<')) {
      continue;
    }
    const group = methodGroups.get(prefix) ?? [];
    group.push(symbol);
    methodGroups.set(prefix, group);
  }
  const groups = Array.from(methodGroups.values()).sort(
    (left, right) =>
      right.reduce((sum, symbol) => sum + usage(symbol), 0) -
        left.reduce((sum, symbol) => sum + usage(symbol), 0) ||
      left[0].name.localeCompare(right[0].name)
  );
  const bestMethods = groups[0] ?? [];
  const methodUsage = bestMethods.reduce((sum, symbol) => sum + usage(symbol), 0);
  const functionUsage = freeFunctions.reduce((sum, symbol) => sum + usage(symbol), 0);

  const parts = [
    node.role === 'data'
      ? 'data module'
      : node.role === 'mixed'
        ? 'mixed module'
        : node.role === 'behavior'
          ? 'behaviour module'
          : 'module'
  ];
  if (types.length > 0) {
    parts.push(`types ${shortList(types, 3)}`);
  }
  if (freeFunctions.length > 0 && functionUsage >= methodUsage) {
    parts.push(`functions ${shortList(freeFunctions.map((symbol) => symbol.name), 3)}`);
  } else if (bestMethods.length > 0) {
    parts.push(
      `methods ${shortList(
        bestMethods.map((symbol) => symbol.name.split('::').slice(1).join('::')),
        3
      )}`
    );
  }
  parts.push(`${node.codeLines} lines`);
  return parts.join(' · ');
}

/** Simple names of the functions and methods the index sees most. */
function rankedFunctionNames(node: ArchComponent, max: number): string[] {
  const usage = (symbol: ArchSymbol): number => symbol.occurrences.length;
  return node.symbols
    .filter(
      (symbol) =>
        symbol.kind === 'fn' &&
        (symbol.name.split('::').length === 1 || symbol.name.split('::').length === 2)
    )
    .sort((left, right) => usage(right) - usage(left) || left.name.localeCompare(right.name))
    .map((symbol) => symbol.name.split('::').slice(-1)[0])
    .slice(0, max);
}

/** Highest-signal source excerpts, comments blanked, for the deeper dive. */
function buildCodeSample(
  sources: Record<string, string[]>,
  nodes: ArchComponent[]
): string {
  const ordered = nodes
    .slice()
    .sort(
      (left, right) =>
        Number(right.id === 'main') - Number(left.id === 'main') ||
        right.callSites - left.callSites ||
        left.id.localeCompare(right.id)
    );
  const files: string[] = [];
  for (const node of ordered) {
    for (const file of node.modules) {
      if (!files.includes(file)) {
        files.push(file);
      }
    }
  }
  const parts: string[] = [];
  let budget = 24000;
  for (const file of files.slice(0, 8)) {
    const lines = sources[file];
    if (!lines) {
      continue;
    }
    const excerpt = blankComments(lines.join('\n')).split('\n').slice(0, 140).join('\n').trim();
    if (!excerpt) {
      continue;
    }
    const block = `### FILE: ${file}\n${excerpt}`;
    if (block.length > budget) {
      break;
    }
    parts.push(block);
    budget -= block.length;
  }
  return parts.join('\n\n');
}

function buildProjectBrief(
  crate: string,
  nodes: ArchComponent[],
  edges: ArchEdge[],
  dependencies: string[],
  usesAsync: boolean,
  entryIds: Set<string>,
  dataFlow: Map<string, { inputs: Set<string>; outputs: Set<string> }>,
  sources: Record<string, string[]>,
  transformations: ArchTransform[]
): ProjectBrief {
  const modules: BriefModule[] = nodes.map((node) => ({
    id: node.id,
    file: primaryFile(node.modules),
    description: moduleDescription(node),
    role: node.role,
    sizeClass: node.sizeClass,
    codeLines: node.codeLines,
    callSites: node.callSites,
    incomingCalls: node.incomingCalls,
    incomingComponents: node.incomingComponents,
    dependencies: node.dependencies
  }));
  const byId = new Map(modules.map((module) => [module.id, module]));

  const callAdj = new Map<string, Set<string>>();
  const linked = new Set<string>();
  const callLinked = new Set<string>();
  for (const edge of edges) {
    linked.add(edge.source);
    linked.add(edge.target);
    if ((edge.kinds.calls ?? 0) === 0) {
      continue;
    }
    callLinked.add(edge.source);
    callLinked.add(edge.target);
    let targets = callAdj.get(edge.source);
    if (!targets) {
      targets = new Set();
      callAdj.set(edge.source, targets);
    }
    targets.add(edge.target);
  }


  const byOutgoing = (left: BriefModule, right: BriefModule): number =>
    Number(right.id === 'main') - Number(left.id === 'main') ||
    (callAdj.get(right.id)?.size ?? 0) - (callAdj.get(left.id)?.size ?? 0) ||
    left.id.localeCompare(right.id);
  const entries = modules.filter((module) => entryIds.has(module.id)).sort(byOutgoing);
  const roots = [
    ...entries,
    ...modules
      .filter(
        (module) =>
          !entryIds.has(module.id) &&
          (callAdj.get(module.id)?.size ?? 0) > 0 &&
          module.incomingCalls === 0
      )
      .sort(byOutgoing)
  ];
  const rootIds = new Set(roots.map((module) => module.id));

  const order: BriefModule[] = [];
  const seen = new Set<string>();
  const queue: string[] = roots.map((module) => module.id);
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) {
      continue;
    }
    const module = byId.get(id);
    if (!module) {
      continue;
    }
    seen.add(id);
    order.push(module);
    for (const next of callAdj.get(id) ?? []) {
      if (!seen.has(next)) {
        queue.push(next);
      }
    }
  }
  const leftovers = modules
    .filter((module) => !seen.has(module.id))
    .sort(
      (left, right) =>
        right.incomingCalls - left.incomingCalls ||
        right.callSites - left.callSites ||
        right.codeLines - left.codeLines ||
        left.id.localeCompare(right.id)
    );
  order.push(...leftovers);

  const startHere: BriefStart[] = order.slice(0, 6).map((module) => ({
    ...module,
    reason: entryIds.has(module.id)
      ? `entry point · calls ${callAdj.get(module.id)?.size ?? 0} component${
          (callAdj.get(module.id)?.size ?? 0) === 1 ? '' : 's'
        }`
      : rootIds.has(module.id)
        ? `starts the call graph · calls ${callAdj.get(module.id)?.size ?? 0} component${
            (callAdj.get(module.id)?.size ?? 0) === 1 ? '' : 's'
          }`
      : module.incomingCalls > 0
        ? `${module.incomingCalls} call sites in from ${module.incomingComponents} component${
            module.incomingComponents === 1 ? '' : 's'
          }`
        : module.role === 'data'
          ? 'data carrier'
          : 'no incoming calls'
  }));

  const typeUsers = new Map<string, { owner: string; users: Set<string> }>();
  for (const node of nodes) {
    for (const symbol of node.symbols) {
      if (symbol.kind !== 'struct' && symbol.kind !== 'enum' && symbol.kind !== 'trait') {
        continue;
      }
      const users = new Set<string>();
      for (const occurrence of symbol.occurrences) {
        const user = componentIdFor(occurrence.file);
        if (user && user !== node.id) {
          users.add(user);
        }
      }
      if (users.size > 0) {
        typeUsers.set(symbol.name, { owner: node.id, users });
      }
    }
  }
  const usageOf = (name: string): number => typeUsers.get(name)?.users.size ?? 0;
  const carriers = Array.from(typeUsers.entries())
    .filter(([, value]) => value.users.size >= 3)
    .map(([name, value]) => ({ name, owner: value.owner, users: Array.from(value.users).sort() }))
    .sort(
      (left, right) => right.users.length - left.users.length || left.name.localeCompare(right.name)
    )
    .slice(0, 10);

  const notes: string[] = [];
  for (const node of nodes) {
    if (!linked.has(node.id)) {
      notes.push(`${node.id}: no indexed links`);
    } else if (!callLinked.has(node.id)) {
      notes.push(`${node.id}: carrier-only — linked by type uses, no calls`);
    }
  }
  notes.push('Indexed references only: trait dispatch, macros and private calls may be missing.');

  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  const techLabels: Record<string, string> = {
    tokio: 'async runtime',
    reqwest: 'HTTP client',
    serde: 'serialization',
    serde_json: 'JSON',
    schemars: 'JSON schemas',
    'async-trait': 'async traits',
    thiserror: 'errors',
    dotenvy: 'env config'
  };
  const technology = dependencies.length
    ? dependencies
        .slice(0, 7)
        .map((dependency) =>
          techLabels[dependency] ? `${dependency} (${techLabels[dependency]})` : dependency
        )
        .join(', ')
    : 'No external crates are declared in Cargo.toml.';
  const isAsync = dependencies.includes('tokio') || usesAsync;
  const hubs = nodes
    .filter((node) => !entryIds.has(node.id))
    .sort((left, right) => right.callSites - left.callSites || left.id.localeCompare(right.id))
    .slice(0, 4)
    .map((node) => node.id);
  const entryNames = entries.map((entry) => entry.id).join(', ');
  const hubSentence =
    hubs.length > 0
      ? `${entryNames ? `${entryNames} is the entry point; ` : ''}most cross-module behaviour runs through ${hubs.join(', ')}.`
      : entryNames
        ? `${entryNames} is the entry point.`
        : '';
  const flowLines: string[] = [];
  const rankedCallEdges = edges
    .filter((edge) => (edge.kinds.calls ?? 0) > 0)
    .sort(
      (left, right) =>
        Number(entryIds.has(right.source)) - Number(entryIds.has(left.source)) ||
        (right.kinds.calls ?? 0) - (left.kinds.calls ?? 0) ||
        left.source.localeCompare(right.source) ||
        left.target.localeCompare(right.target)
    )
    .slice(0, 5);
  for (const edge of rankedCallEdges) {
    const types = dataFlow.get(`${edge.source}->${edge.target}`);
    const inputs = types
      ? Array.from(types.inputs)
          .sort((left, right) => usageOf(right) - usageOf(left) || left.localeCompare(right))
          .slice(0, 4)
      : [];
    const outputs = types
      ? Array.from(types.outputs)
          .sort((left, right) => usageOf(right) - usageOf(left) || left.localeCompare(right))
          .slice(0, 2)
      : [];
    if (inputs.length === 0 && outputs.length === 0) {
      continue;
    }
    flowLines.push(
      `${edge.source} → ${edge.target}: ${inputs.length > 0 ? inputs.join(', ') : '—'} → ${
        outputs.length > 0 ? outputs.join(', ') : '—'
      }`
    );
    if (flowLines.length >= 5) {
      break;
    }
  }
  const flow =
    flowLines.length > 0 ? `${flowLines.join('; ')}.` : 'No typed call edges are indexed.';

  const signals = inspectCode(sources, dependencies);
  const { http, llm, toolContract, records, replays, resume, server } = signals;
  const base = llm
    ? 'an HTTP client for a chat-completions style model API'
    : http
      ? 'an HTTP client'
      : server
        ? 'an HTTP service'
        : entries.length > 0
          ? 'a command-line program'
          : 'a library';
  const traits = [
    llm ? 'calls a chat-completions model API' : '',
    toolContract
      ? `dispatches tool calls${
          signals.toolImpls.length > 0 ? ` (${signals.toolImpls.slice(0, 4).join(', ')})` : ''
        }`
      : '',
    records ? 'records each run to a log' : '',
    resume ? 'resumes a paused run' : '',
    replays ? 'replays a recorded run' : ''
  ]
    .filter(Boolean)
    .slice(0, 4);
  const appearsTo = `It appears to be ${base}${traits.length > 0 ? `. The code ${traits.join(', ')}` : ''}.`;

  const archetype =
    llm && toolContract
      ? 'LLM agent harness'
      : llm
        ? 'LLM client'
        : toolContract
          ? 'tool runner'
          : server
            ? 'HTTP service'
            : records
              ? 'run recorder'
              : '';
  const kind = `${isAsync ? 'that uses async Rust' : 'written in Rust'}`;
  const shape = entries.length > 0 ? 'binary' : 'library';
  const firstWord = archetype.split(' ')[0] ?? '';
  const anArchetype =
    firstWord.length > 0 && firstWord === firstWord.toUpperCase()
      ? /^[AEFHILMNORSX]/.test(firstWord)
      : /^[aeiou]/i.test(archetype);
  const what =
    archetype.length > 0
      ? `${crate} appears to be ${anArchetype ? 'an' : 'a'} ${archetype}: a Rust ${shape} ${kind}. ${hubSentence}`.trim()
      : `${crate} is a Rust ${shape} with ${nodes.length} modules. ${
          isAsync ? 'It uses async Rust. ' : ''
        }${hubSentence}`.trim();

  const evidence = signals.evidence.slice(0, 8);

  const entryModule = modules.find((module) => entryIds.has(module.id));
  const loopId = hubs[0];
  const loopModule = loopId ? modules.find((module) => module.id === loopId) : undefined;
  const loopNode = loopId ? nodeById.get(loopId) : undefined;
  const loopNames = loopNode ? rankedFunctionNames(loopNode, 2) : [];
  const startParts = [
    entryModule ? `Start at ${entryModule.file} (entry point)` : '',
    loopModule
      ? `the loop appears to be ${loopModule.id} in ${loopModule.file}${
          loopNames.length > 0 ? ` (${loopNames.join(', ')})` : ''
        }`
      : ''
  ].filter(Boolean);
  const start = startParts.length > 0 ? `${startParts.join('; ')}.` : '';
  const identity = [
    what,
    traits.length > 0 ? `The code ${traits.join(', ')}.` : '',
    start
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+\./g, '.');

  const flows = new Map<string, Set<string>>();
  const rememberPath = (type: string, path: string): void => {
    const paths = flows.get(type) ?? new Set<string>();
    paths.add(path);
    flows.set(type, paths);
  };
  for (const edge of edges) {
    const types = dataFlow.get(`${edge.source}->${edge.target}`);
    if (!types) {
      continue;
    }
    for (const input of types.inputs) {
      rememberPath(input, `${edge.source} → ${edge.target}`);
    }
    for (const output of types.outputs) {
      rememberPath(output, `${edge.target} → ${edge.source}`);
    }
  }
  const dataLines = Array.from(flows.entries())
    .sort(
      (left, right) =>
        usageOf(right[0]) - usageOf(left[0]) ||
        right[1].size - left[1].size ||
        left[0].localeCompare(right[0])
    )
    .slice(0, 8)
    .map(([name, paths]) => `${name}: ${summarizePaths(paths)}`);
  const dataFlowText =
    dataLines.length > 0
      ? `${dataLines.join('; ')}.`
      : 'No carrier movement is inferable from the signatures.';

  const reachable = new Set<string>();
  const pending = Array.from(entryIds);
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (reachable.has(id)) {
      continue;
    }
    reachable.add(id);
    for (const next of callAdj.get(id) ?? []) {
      pending.push(next);
    }
  }
  const transformScore = (transform: ArchTransform): number => {
    const self = transform.inputs.includes(transform.output);
    const inputScore = transform.inputs.reduce((sum, name) => sum + usageOf(name), 0);
    const inputOwner = typeUsers.get(transform.inputs[0])?.owner;
    const outputOwner = typeUsers.get(transform.output)?.owner;
    const crossBoundary = Boolean(inputOwner && outputOwner && inputOwner !== outputOwner);
    return (
      (reachable.size === 0 || reachable.has(transform.component) ? 3 : 0) +
      Math.min(inputScore, 6) +
      Math.min(usageOf(transform.output) * 2, 8) +
      Math.min(transform.callCount, 4) +
      Math.min(transform.usage, 2) +
      (crossBoundary ? 2 : 0) -
      (transform.selfBuild ? 4 : 0) -
      (self ? 5 : 0)
    );
  };
  const orderedTransforms = transformations
    .filter((transform) => transform.callCount > 0)
    .sort(
      (left, right) =>
        transformScore(right) - transformScore(left) ||
        left.function.localeCompare(right.function)
    );
  const outputsTaken = new Set<string>();
  const selectedTransforms: ArchTransform[] = [];
  for (const transform of orderedTransforms) {
    if (outputsTaken.has(transform.output)) {
      continue;
    }
    outputsTaken.add(transform.output);
    selectedTransforms.push(transform);
    if (selectedTransforms.length >= 6) {
      break;
    }
  }
  const transformationsText = formatTransformations(selectedTransforms);

  const callLinks = edges.filter((edge) => (edge.kinds.calls ?? 0) > 0).length;
  const useLinks = edges.length - callLinks;
  const carrierOnly = nodes
    .filter((node) => linked.has(node.id) && !callLinked.has(node.id))
    .map((node) => node.id);
  const map = [
    `The diagram has ${nodes.length} components and ${edges.length} links: ${callLinks} carry calls, ${useLinks} only type uses.`,
    entries.length > 0
      ? `Entry ${entries.map((entry) => entry.id).join(', ')} sits at the left; its call arrows lead to its callees.`
      : '',
    carrierOnly.length > 0
      ? `${carrierOnly.join(', ')} appear only through type uses, so they have no call arrows.`
      : '',
    carriers.length > 0
      ? `${carriers.slice(0, 4).map((carrier) => carrier.name).join(', ')} are the types crossing component boundaries.`
      : ''
  ]
    .filter(Boolean)
    .join(' ');

  return {
    overview: { identity, start, what, appearsTo, evidence, flow, dataFlow: dataFlowText, transformations: transformationsText, technology, map },
    startHere,
    modules,
    carriers,
    notes
  };
}

/** Three size classes by 1-D clustering over code lines, so the steps fall
 * on natural gaps rather than at an arbitrary third. Deterministic: seeded
 * at the means of the sorted thirds, lower-index ties. */
export function sizeClasses(values: number[]): NodeSizeClass[] {
  const n = values.length;
  if (n === 0) {
    return [];
  }
  if (n <= 2) {
    return values.map((_, index) =>
      index === 0 ? 'small' : n === 1 ? 'small' : 'medium'
    );
  }
  const sorted = values.slice().sort((left, right) => left - right);
  const mean = (items: number[]): number =>
    items.reduce((sum, value) => sum + value, 0) / items.length;
  const firstCut = Math.ceil(n / 3);
  const secondCut = Math.ceil((n * 2) / 3);
  let centroids = [
    mean(sorted.slice(0, firstCut)),
    mean(sorted.slice(firstCut, secondCut)),
    mean(sorted.slice(secondCut))
  ];
  let assignment = values.map(() => 0);
  for (let guard = 0; guard < 20; guard += 1) {
    const next = values.map((value) => {
      let best = 0;
      let bestDistance = Infinity;
      centroids.forEach((centroid, index) => {
        const distance = Math.abs(value - centroid);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      });
      return best;
    });
    assignment = next;
    const sums = [0, 0, 0];
    const counts = [0, 0, 0];
    values.forEach((value, index) => {
      sums[assignment[index]] += value;
      counts[assignment[index]] += 1;
    });
    if (counts.some((count) => count === 0)) {
      break;
    }
    const updated = sums.map((sum, index) => sum / counts[index]);
    const stable =
      updated.every((centroid, index) => Math.abs(centroid - centroids[index]) < 1e-9) &&
      assignment.every((cluster, index) => cluster === next[index]);
    centroids = updated;
    if (stable) {
      break;
    }
  }
  const clusterCounts = [0, 0, 0];
  assignment.forEach((cluster) => {
    clusterCounts[cluster] += 1;
  });
  if (clusterCounts.some((count) => count === 0)) {
    const order = values
      .map((value, index) => ({ value, index }))
      .sort((left, right) => left.value - right.value || left.index - right.index);
    const classes: NodeSizeClass[] = new Array(n);
    order.forEach((item, rank) => {
      classes[item.index] =
        rank < n / 3 ? 'small' : rank < (n * 2) / 3 ? 'medium' : 'large';
    });
    return classes;
  }
  return assignment.map((cluster) =>
    cluster === 0 ? 'small' : cluster === 1 ? 'medium' : 'large'
  );
}

export function isTypeKind(kind: string): boolean {
  return kind === 'struct' || kind === 'enum' || kind === 'trait' || kind === 'type';
}

/** True when a function takes a type owned by another module as input.
 * Return types are ignored: constructing or returning foreign data does not
 * make a module behaviour-bearing. */
export function takesForeignType(
  symbol: { name: string; signature?: string },
  owner: string,
  typeOwner: Map<string, string>
): boolean {
  const params = parameterList(symbol.signature);
  if (!params) {
    return false;
  }
  const ownType = symbol.name.includes('::') ? symbol.name.split('::')[0] : undefined;
  const names = params.match(/\b[A-Z][A-Za-z0-9_]*\b/g) ?? [];
  for (const name of names) {
    if (name === 'Self' || name === ownType) {
      continue;
    }
    const target = typeOwner.get(name);
    if (target && target !== owner) {
      return true;
    }
  }
  return false;
}

function parameterBounds(signature: string | undefined): [number, number] | undefined {
  if (!signature) {
    return undefined;
  }
  const open = signature.indexOf('(');
  if (open === -1) {
    return undefined;
  }
  let depth = 0;
  for (let i = open; i < signature.length; i += 1) {
    if (signature[i] === '(') {
      depth += 1;
    } else if (signature[i] === ')') {
      depth -= 1;
      if (depth === 0) {
        return [open, i];
      }
    }
  }
  return [open, signature.length - 1];
}

function parameterList(signature: string | undefined): string | undefined {
  const bounds = parameterBounds(signature);
  return bounds && signature ? signature.slice(bounds[0] + 1, bounds[1]) : undefined;
}

/** The type a function constructs, when it returns a type owned by its own
 * module (directly or through `Self`, `Result` or `Option`). */
export function constructionTarget(
  symbol: { name: string; kind: string; signature?: string },
  owner: string,
  typeOwner: Map<string, string>
): string | undefined {
  if (symbol.kind !== 'fn' && symbol.kind !== 'method') {
    return undefined;
  }
  // A function that consumes another module's types is behaviour, not a
  // constructor, even when it returns a type of its own module.
  if (takesForeignType(symbol, owner, typeOwner)) {
    return undefined;
  }
  const bounds = parameterBounds(symbol.signature);
  if (!bounds || !symbol.signature) {
    return undefined;
  }
  const arrow = symbol.signature.indexOf('->', bounds[1]);
  if (arrow === -1) {
    return undefined;
  }
  const core = returnCore(symbol.signature.slice(arrow + 2));
  if (!core) {
    return undefined;
  }
  if (core === 'Self') {
    const own = symbol.name.includes('::') ? symbol.name.split('::')[0] : undefined;
    return own && typeOwner.get(own) === owner ? own : undefined;
  }
  return typeOwner.get(core) === owner ? core : undefined;
}

function returnCore(text: string): string | undefined {
  let value = text.trim();
  if (
    !value ||
    value.startsWith('&') ||
    value.startsWith('impl ') ||
    value.startsWith('dyn ')
  ) {
    return undefined;
  }
  value = value.replace(/\s+where\b[\s\S]*$/, '').trim();
  const wrapper = /^(Result|Option)\s*</.exec(value);
  if (wrapper) {
    const inner = value.slice(wrapper[0].length);
    let depth = 1;
    for (let i = 0; i < inner.length; i += 1) {
      const ch = inner[i];
      if (ch === '<') {
        depth += 1;
      } else if (ch === '>') {
        depth -= 1;
        if (depth === 0) {
          return returnCore(inner.slice(0, i));
        }
      } else if (ch === ',' && depth === 1) {
        return returnCore(inner.slice(0, i));
      }
    }
    return returnCore(inner);
  }
  return /^([A-Za-z_][A-Za-z0-9_]*)/.exec(value)?.[1];
}

export function stripComments(lines: string[]): string[] {
  let depth = 0;
  return lines.map((raw) => {
    let out = '';
    let i = 0;
    while (i < raw.length) {
      if (depth > 0) {
        const close = raw.indexOf('*/', i);
        const open = raw.indexOf('/*', i);
        if (close === -1 && open === -1) {
          i = raw.length;
          break;
        }
        if (open !== -1 && (close === -1 || open < close)) {
          depth += 1;
          i = open + 2;
          continue;
        }
        depth -= 1;
        i = close + 2;
        continue;
      }
      const lineComment = raw.indexOf('//', i);
      const blockOpen = raw.indexOf('/*', i);
      if (lineComment !== -1 && (blockOpen === -1 || lineComment < blockOpen)) {
        out += raw.slice(i, lineComment);
        i = raw.length;
        break;
      }
      if (blockOpen !== -1) {
        out += raw.slice(i, blockOpen);
        depth += 1;
        i = blockOpen + 2;
        continue;
      }
      out += raw.slice(i);
      i = raw.length;
    }
    return out;
  });
}

/** Lines that hold code: blanks and comments (including nested block
 * comments) are not counted. */
export function countCodeLines(lines: string[]): number {
  return stripComments(lines).filter((line) => line.trim().length > 0).length;
}

const WIRING_MODIFIER = String.raw`(?:pub(?:\s*\([^)]*\))?\s+)?`;
const MOD_DECL = new RegExp(`^${WIRING_MODIFIER}mod\\s+[A-Za-z_][A-Za-z0-9_]*\\s*;$`);
const USE_START = new RegExp(`^${WIRING_MODIFIER}use\\b`);
const EXTERN_CRATE = new RegExp(
  '^extern\\s+crate\\s+[A-Za-z_][A-Za-z0-9_]*(?:\\s+as\\s+[A-Za-z_][A-Za-z0-9_]*)?\\s*;$'
);

/** A module whose content only declares and re-exports other modules. */
export function isModuleWiring(lines: string[]): boolean {
  let inUse = false;
  let attributeDepth = 0;
  for (const raw of stripComments(lines)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    if (inUse) {
      if (line.endsWith(';')) {
        inUse = false;
      }
      continue;
    }
    if (attributeDepth > 0) {
      attributeDepth += occurrences(line, '[') - occurrences(line, ']');
      continue;
    }
    if (line.startsWith('#![') || line.startsWith('#[')) {
      const depth = occurrences(line, '[') - occurrences(line, ']');
      if (depth > 0) {
        attributeDepth = depth;
      }
      continue;
    }
    if (EXTERN_CRATE.test(line) || MOD_DECL.test(line)) {
      continue;
    }
    if (USE_START.test(line)) {
      if (!line.endsWith(';')) {
        inUse = true;
      }
      continue;
    }
    return false;
  }
  return !inUse && attributeDepth === 0;
}

function occurrences(text: string, char: string): number {
  return text.split(char).length - 1;
}

function snippetFor(
  sources: Record<string, string[]>,
  file: string,
  line: number
): ArchSnippetLine[] {
  const lines = sources[file];
  if (!lines || line < 1 || line > lines.length) {
    return [];
  }
  const start = Math.max(1, line - 1);
  const end = Math.min(lines.length, line + 1);
  const snippet: ArchSnippetLine[] = [];
  for (let n = start; n <= end; n += 1) {
    snippet.push({ line: n, text: lines[n - 1] });
  }
  return snippet;
}

function sortOccurrences(occurrences: ArchOccurrence[]): ArchOccurrence[] {
  return occurrences.sort(
    (left, right) =>
      Number(right.kind === 'call') - Number(left.kind === 'call') ||
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.label.localeCompare(right.label)
  );
}

function dedupeOccurrences(occurrences: ArchOccurrence[]): ArchOccurrence[] {
  const seen = new Set<string>();
  const result: ArchOccurrence[] = [];
  for (const occurrence of occurrences) {
    const key = `${occurrence.file}\0${occurrence.line}\0${occurrence.label}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(occurrence);
  }
  return result;
}

/** Deterministic layered placement: cycle-breaking ranks nodes by longest
 * path from the roots, and barycentre ordering keeps orthogonal edges short. */
export function layeredPositions(
  ids: string[],
  edges: Array<{ source: string; target: string }>
): Record<string, [number, number]> {
  const order = new Map(ids.map((id, i) => [id, i]));
  const succ = new Map<string, string[]>();
  const pred = new Map<string, string[]>();
  for (const id of ids) {
    succ.set(id, []);
    pred.set(id, []);
  }
  for (const edge of edges) {
    if (!succ.has(edge.source) || !succ.has(edge.target)) {
      continue;
    }
    succ.get(edge.source)!.push(edge.target);
    pred.get(edge.target)!.push(edge.source);
  }

  // Break cycles the way layered drawing does: a DFS marks the edges that
  // point back up the current path, and those are ignored for ranking.
  const indegreeAll = new Map<string, number>();
  for (const id of ids) {
    indegreeAll.set(id, 0);
  }
  for (const edge of edges) {
    if (indegreeAll.has(edge.target)) {
      indegreeAll.set(edge.target, indegreeAll.get(edge.target)! + 1);
    }
  }
  const rootWeight = (id: string): number => {
    if (id === 'main' || id === 'lib') {
      return 0;
    }
    return indegreeAll.get(id) === 0 ? 1 : 2;
  };
  const dfsOrder = ids
    .slice()
    .sort((left, right) => rootWeight(left) - rootWeight(right) || order.get(left)! - order.get(right)!);

  const visited = new Set<string>();
  const onPath = new Set<string>();
  const backEdges = new Set<string>();
  const dfs = (node: string): void => {
    visited.add(node);
    onPath.add(node);
    for (const next of succ.get(node) ?? []) {
      if (onPath.has(next)) {
        backEdges.add(`${node}\0${next}`);
        continue;
      }
      if (!visited.has(next)) {
        dfs(next);
      }
    }
    onPath.delete(node);
  };
  for (const id of dfsOrder) {
    if (!visited.has(id)) {
      dfs(id);
    }
  }

  const indegree = new Map<string, number>();
  for (const id of ids) {
    indegree.set(id, 0);
  }
  for (const edge of edges) {
    if (!succ.has(edge.source) || !succ.has(edge.target) || backEdges.has(`${edge.source}\0${edge.target}`)) {
      continue;
    }
    indegree.set(edge.target, indegree.get(edge.target)! + 1);
  }
  const rank = new Map<string, number>();
  for (const id of ids) {
    rank.set(id, 0);
  }
  const queue: string[] = [];
  for (const id of ids) {
    if (indegree.get(id) === 0) {
      queue.push(id);
    }
  }
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of succ.get(current) ?? []) {
      if (backEdges.has(`${current}\0${next}`)) {
        continue;
      }
      rank.set(next, Math.max(rank.get(next)!, rank.get(current)! + 1));
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) {
        queue.push(next);
      }
    }
  }

  const layers = new Map<number, string[]>();
  for (const id of ids) {
    const r = rank.get(id) ?? 0;
    if (!layers.has(r)) {
      layers.set(r, []);
    }
    layers.get(r)!.push(id);
  }
  for (const list of layers.values()) {
    list.sort((left, right) => order.get(left)! - order.get(right)!);
  }

  const snapshot = (r: number): Map<string, number> =>
    new Map(layers.get(r)!.map((id, i) => [id, i]));

  for (let pass = 0; pass < 4; pass += 1) {
    const ranks = Array.from(layers.keys()).sort((a, b) => a - b);
    for (const r of ranks) {
      if (!layers.has(r - 1)) {
        continue;
      }
      const here = snapshot(r);
      const prev = snapshot(r - 1);
      const upstream = (id: string): number => {
        const links = (pred.get(id) ?? [])
          .filter((name) => prev.has(name))
          .map((name) => prev.get(name)!);
        return links.length > 0 ? average(links) : here.get(id)!;
      };
      layers.get(r)!.sort((left, right) => upstream(left) - upstream(right) || order.get(left)! - order.get(right)!);
    }
    for (const r of ranks.slice().reverse()) {
      if (!layers.has(r + 1)) {
        continue;
      }
      const here = snapshot(r);
      const next = snapshot(r + 1);
      const downstream = (id: string): number => {
        const links = (succ.get(id) ?? [])
          .filter((name) => next.has(name))
          .map((name) => next.get(name)!);
        return links.length > 0 ? average(links) : here.get(id)!;
      };
      layers.get(r)!.sort((left, right) => downstream(left) - downstream(right) || order.get(left)! - order.get(right)!);
    }
  }

  const positions: Record<string, [number, number]> = {};
  for (const [r, list] of layers) {
    for (let i = 0; i < list.length; i += 1) {
      positions[list[i]] = [
        120 + r * 280,
        Math.round(350 + (i - (list.length - 1) / 2) * 160)
      ];
    }
  }
  return positions;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
