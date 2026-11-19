export type Scope = 'fn' | 'struct' | 'line';

export type TypeKind = 'struct' | 'enum' | 'trait' | 'type' | 'fn' | 'mod' | 'impl';

export type TypeItem = {
  name: string;
  kind: TypeKind;
  start: number;
  end: number;
};

export type Spotlight = {
  code: string;
  start: number;
  end: number;
  means: string;
  equivalent: string;
  trap?: string;
};

export type Point = {
  text: string;
  scope: Scope;
  start: number;
  end: number;
};

export type TraceKind = 'fn' | 'struct' | 'enum' | 'impl';

export type TraceGroup = {
  name: string;
  kind: TraceKind;
  start: number;
  end: number;
  points: Point[];
};

export type MemoryFrame = {
  id: string;
  name: string;
  start: number;
  end: number;
  parent?: string | null;
};

export type MemoryPointer = {
  heap: string;
  field?: string;
  kind?: 'owns' | 'borrow';
};

export type MemoryValue = {
  id: string;
  name: string;
  type: string;
  frame: string;
  kind: 'binding' | 'ref' | 'temp';
  mutable: boolean;
  start: number;
  end: number;
  borrowOf?: string;
  borrowMode?: 'shared' | 'mutable';
  external?: string;
  pointers?: MemoryPointer[];
  note?: string;
};

export type MemoryHeap = {
  id: string;
  type: string;
  label: string;
  start: number;
  end: number;
  cells?: string[];
  layout?: { ptr?: string; len?: number; cap?: number };
  note?: string;
};

export type MemoryEventKind = 'move' | 'copy' | 'clone' | 'drop' | 'assign';

export type MemoryEvent = {
  line: number;
  kind: MemoryEventKind;
  from: string;
  to?: string;
  toLabel?: string;
  detail?: string;
};

export type MemoryModel = {
  function: string;
  start: number;
  end: number;
  frames: MemoryFrame[];
  values: MemoryValue[];
  heap: MemoryHeap[];
  events: MemoryEvent[];
  returns?: string;
};

export type Usage = {
  input: number;
  output: number;
};

export type Analysis = {
  version: 1;
  file: string;
  model?: string;
  generatedAt?: string;
  usage?: Usage;
  typeInventory: TypeItem[];
  spotlights: Spotlight[];
  ownership: TraceGroup[];
  memory: MemoryModel[];
  warnings?: string[];
};

export type CachedAnalysis = {
  analysis: Analysis;
  textHash: string;
  sourceHash: string;
  promptVersion: string;
  model: string;
  generatedAt: string;
  usage?: Usage;
  issues: string[];
};

export type OverviewSymbolKind =
  | 'struct'
  | 'enum'
  | 'trait'
  | 'impl'
  | 'fn'
  | 'const'
  | 'static'
  | 'type'
  | 'mod'
  | 'macro';

export type OverviewSymbol = {
  name: string;
  kind: OverviewSymbolKind;
  start: number;
  end: number;
  selectionCharacter?: number;
  visibility?: 'public' | 'restricted' | 'private';
  test?: boolean;
  signature?: string;
  doc?: string;
};

export type OverviewImport = {
  path: string;
  external: boolean;
  symbols?: string[];
};

export type OverviewRelation = {
  path: string;
  symbols?: string[];
};

export type IndexRelation = {
  name: string;
  detail?: string;
  file: string;
  line: number;
  character?: number;
  source?: string;
  target?: string;
};

export type ModuleContext = {
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
  revision: string;
};

export type StructuralOverview = {
  file: string;
  modulePath?: string;
  crateName?: string;
  lineCount: number;
  moduleDoc?: string;
  summary: string;
  symbols: OverviewSymbol[];
  keyConstructs: OverviewSymbol[];
  functions: OverviewSymbol[];
  imports: OverviewImport[];
  usedBy?: OverviewRelation[];
};

export type BriefStep = {
  title: string;
  text: string;
  start: number;
  end: number;
};

export type FunctionStep = {
  text: string;
  start: number;
  end: number;
};

export type FunctionBrief = {
  name: string;
  start: number;
  end: number;
  signature?: string;
  summary: string;
  why?: string;
  steps: FunctionStep[];
  inputs?: string;
  returns?: string;
  errors?: string;
  sideEffects?: string;
};

export type ConstructBrief = {
  name: string;
  why: string;
};

export type FileBrief = {
  version: 1 | 2;
  file: string;
  sourceHash: string;
  model: string;
  generatedAt: string;
  role: string;
  purpose: string;
  boundaries?: string;
  operations?: ProfileOperation[];
  rules?: BriefStep[];
  functions: FunctionBrief[];
  outline?: BriefStep[];
  constructs?: ConstructBrief[];
  rustNotes?: string[];
};

export type CachedBrief = {
  brief: FileBrief;
  fileKey?: string;
  contextRevision?: string;
  sourceHash: string;
  promptVersion: string;
  model: string;
  generatedAt: string;
  usage?: Usage;
  issues: string[];
};

export type ProfileDelegate = {
  concern: string;
  to: string;
  symbols?: string[];
};

export type ProfileOperation = {
  name: string;
  purpose: string;
  entry: string;
  functions: string[];
  start: number;
  end: number;
};

export type ProfileFunction = {
  name: string;
  start: number;
  end: number;
  why: string;
};

export type ModuleProfile = {
  version: 1;
  file: string;
  revision: string;
  role: string;
  owns: string[];
  delegates: ProfileDelegate[];
  operations: ProfileOperation[];
  keyFunctions: ProfileFunction[];
};

export type CachedProfile = {
  profile: ModuleProfile;
  fileKey?: string;
  sourceHash: string;
  indexRevision: string;
  promptVersion: string;
  model: string;
  generatedAt: string;
  usage?: Usage;
  issues: string[];
};
