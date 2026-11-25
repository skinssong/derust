import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  ArchitectureModel,
  RawOccurrence,
  RawSymbol,
  buildArchitecture,
  classifyOccurrence,
  isDefinitionLine,
  useLineSet
} from './architecture';
import { OverviewSymbol } from './contract';
import { OverviewService } from './overviewLens';
import { crateRoot, readCrateName } from './project';

const CACHE_VERSION = 26;
const CALL_TIMEOUT_MS = 4000;
const MAX_CALLER_LOOKUPS = 300;
const REFERENCE_TIMEOUT_MS = 5000;
const MAX_SYMBOLS = 900;
const MAX_REFERENCES = 200;
const SYMBOL_KINDS = new Set(['struct', 'enum', 'trait', 'fn', 'type', 'const', 'macro', 'method']);

type ArchitectureCache = {
  version: number;
  workspace: string;
  revision: string;
  model: ArchitectureModel;
};

type Candidate = {
  file: string;
  document: vscode.TextDocument;
  symbol: OverviewSymbol;
};

export class ArchitectureService {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly overviewService: OverviewService,
    private readonly output: vscode.OutputChannel
  ) {}

  async build(
    uri: vscode.Uri,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken
  ): Promise<ArchitectureModel | undefined> {
    const root = crateRoot(uri) ?? vscode.workspace.getWorkspaceFolder(uri)?.uri;
    if (!root) {
      throw new Error('Open a Rust workspace first.');
    }

    const started = Date.now();
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(root, 'src/**/*.rs'),
      '**/{target,.git,node_modules}/**'
    );
    const sorted = files
      .filter((file) => file.scheme === 'file')
      .sort((left, right) => left.fsPath.localeCompare(right.fsPath));
    if (sorted.length === 0) {
      return undefined;
    }

    const sources: Record<string, string[]> = {};
    const hashes: Record<string, string> = {};
    const documents = new Map<string, vscode.TextDocument>();
    for (const file of sorted) {
      if (token.isCancellationRequested) {
        return undefined;
      }
      const document = await vscode.workspace.openTextDocument(file);
      const relative = relativePath(root, file);
      const text = document.getText();
      sources[relative] = text.split(/\r?\n/);
      hashes[relative] = sha256(text);
      documents.set(relative, document);
    }
    const revision = revisionFor(hashes);
    const useLines = new Map<string, Set<number>>();
    for (const [file, lines] of Object.entries(sources)) {
      useLines.set(file, useLineSet(lines));
    }

    const cached = this.loadCache(root);
    if (cached && cached.revision === revision) {
      this.output.appendLine(`[architecture] cache hit; ${Date.now() - started}ms`);
      return cached.model;
    }

    const candidates: Candidate[] = [];
    let read = 0;
    for (const [file, document] of documents) {
      if (token.isCancellationRequested) {
        return undefined;
      }
      progress.report({
        message: `reading modules ${read + 1}/${documents.size}`,
        increment: documents.size > 0 ? 35 / documents.size : 0
      });
      read += 1;
      try {
        const overview = await this.overviewService.build(document, 4000);
        for (const symbol of overview.symbols) {
          if (
            symbol.visibility === 'private' ||
            symbol.test ||
            !SYMBOL_KINDS.has(symbol.kind) ||
            symbol.kind === 'impl' ||
            symbol.kind === 'mod'
          ) {
            continue;
          }
          candidates.push({ file, document, symbol });
        }
      } catch (error) {
        this.output.appendLine(`[architecture] ${file}: ${messageOf(error)}`);
      }
    }

    const limited = candidates.slice(0, MAX_SYMBOLS);
    const records: Array<Candidate & { occurrences: RawOccurrence[] }> = [];
    let done = 0;
    for (const candidate of limited) {
      if (token.isCancellationRequested) {
        return undefined;
      }
      progress.report({
        message: `indexing symbols ${done + 1}/${limited.length}`,
        increment: limited.length > 0 ? 40 / limited.length : 0
      });
      done += 1;

      const symbol = candidate.symbol;
      const position = new vscode.Position(
        Math.max(0, symbol.start - 1),
        symbol.selectionCharacter ?? nameColumn(candidate.document, symbol.start, symbol.name)
      );
      const locations = await withTimeout(
        vscode.commands.executeCommand<unknown>(
          'vscode.executeReferenceProvider',
          candidate.document.uri,
          position
        ),
        REFERENCE_TIMEOUT_MS
      );
      records.push({
        ...candidate,
        occurrences: collectOccurrences(locations, root, sources, useLines, symbol.kind, symbol.name)
      });
    }

    const callers = await this.resolveCallers(root, records, sources, progress, token);
    if (token.isCancellationRequested) {
      return undefined;
    }
    const symbols: RawSymbol[] = records.map((record) => ({
      file: record.file,
      name: record.symbol.name,
      kind: record.symbol.kind,
      start: record.symbol.start,
      end: record.symbol.end,
      signature: record.symbol.signature,
      occurrences: record.occurrences.map((occurrence) =>
        occurrence.kind === 'call'
          ? {
              ...occurrence,
              caller: callers.get(
                `${occurrence.file}\0${occurrence.line}\0${simpleName(record.symbol.name)}`
              )
            }
          : occurrence
      )
    }));

    const crate = (await readCrateName(uri)) ?? path.basename(root.fsPath);
    const model = buildArchitecture({
      revision,
      crate,
      root: root.fsPath,
      symbols,
      sources,
      dependencies: readDependencies(root)
    });
    this.saveCache(root, revision, model);
    this.output.appendLine(
      `[architecture] ${model.meta.components} components, ${model.meta.edges} edges, ` +
        `${model.meta.indexedReferences} occurrences; ` +
        `${seconds(started)}s`
    );
    return model;
  }

  private async resolveCallers(
    root: vscode.Uri,
    records: Array<Candidate & { occurrences: RawOccurrence[] }>,
    sources: Record<string, string[]>,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken
  ): Promise<Map<string, string>> {
    const callers = new Map<string, string>();
    const functions = records
      .filter(
        (record) =>
          record.symbol.kind === 'fn' && record.occurrences.some((item) => item.kind === 'call')
      )
      .slice(0, MAX_CALLER_LOOKUPS);
    let done = 0;
    for (const record of functions) {
      if (token.isCancellationRequested) {
        break;
      }
      progress.report({
        message: `resolving callers ${done + 1}/${functions.length}`,
        increment: functions.length > 0 ? 20 / functions.length : 0
      });
      done += 1;

      const symbol = record.symbol;
      const position = new vscode.Position(
        Math.max(0, symbol.start - 1),
        symbol.selectionCharacter ?? nameColumn(record.document, symbol.start, symbol.name)
      );
      const prepared = await withTimeout(
        vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
          'vscode.prepareCallHierarchy',
          record.document.uri,
          position
        ),
        CALL_TIMEOUT_MS
      );
      const item = prepared?.[0];
      if (!item) {
        continue;
      }
      const incoming = await withTimeout(
        vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
          'vscode.provideIncomingCalls',
          item
        ),
        CALL_TIMEOUT_MS
      );
      for (const call of incoming ?? []) {
        if (call.from.uri.scheme !== 'file') {
          continue;
        }
        const file = relativePath(root, call.from.uri);
        if (!sources[file]) {
          continue;
        }
        const caller = simpleName(call.from.name);
        for (const range of call.fromRanges ?? []) {
          callers.set(
            `${file}\0${range.start.line + 1}\0${simpleName(symbol.name)}`,
            caller
          );
        }
      }
    }
    return callers;
  }

  private loadCache(root: vscode.Uri): ArchitectureCache | undefined {
    const cachePath = this.cachePath(root);
    try {
      const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as ArchitectureCache;
      if (
        !parsed ||
        parsed.version !== CACHE_VERSION ||
        parsed.workspace !== root.fsPath ||
        !parsed.model
      ) {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  private saveCache(root: vscode.Uri, revision: string, model: ArchitectureModel): void {
    const cachePath = this.cachePath(root);
    const payload: ArchitectureCache = {
      version: CACHE_VERSION,
      workspace: root.fsPath,
      revision,
      model
    };
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      const temporary = `${cachePath}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(payload), 'utf8');
      fs.renameSync(temporary, cachePath);
    } catch (error) {
      this.output.appendLine(`[architecture] cache write failed: ${messageOf(error)}`);
    }
  }

  private cachePath(root: vscode.Uri): string {
    return path.join(
      this.context.globalStorageUri.fsPath,
      'derust-index',
      sha256(root.fsPath).slice(0, 16),
      'architecture.json'
    );
  }
}

function collectOccurrences(
  locations: unknown,
  root: vscode.Uri,
  sources: Record<string, string[]>,
  useLines: Map<string, Set<number>>,
  symbolKind: string,
  symbolName: string
): RawOccurrence[] {
  const occurrences: RawOccurrence[] = [];
  const seen = new Set<string>();
  for (const location of asLocations(locations).slice(0, MAX_REFERENCES)) {
    const file = relativePath(root, location.uri);
    const lines = sources[file];
    if (!lines) {
      continue;
    }
    const line = location.range.start.line + 1;
    if (line < 1 || line > lines.length) {
      continue;
    }
    const text = lines[line - 1];
    if (useLines.get(file)?.has(line) || isDefinitionLine(symbolKind, text, symbolName)) {
      continue;
    }
    const key = `${file}\0${line}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    occurrences.push({
      file,
      line,
      kind: classifyOccurrence(symbolKind, text, symbolName)
    });
  }
  return occurrences;
}

function asLocations(value: unknown): vscode.Location[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: vscode.Location[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (record.uri instanceof vscode.Uri && record.range) {
      result.push(item as vscode.Location);
    } else if (record.targetUri instanceof vscode.Uri && record.targetRange) {
      result.push(
        new vscode.Location(
          record.targetUri as vscode.Uri,
          record.targetSelectionRange as vscode.Range ?? (record.targetRange as vscode.Range)
        )
      );
    }
  }
  return result;
}

function simpleName(name: string): string {
  return name.split('::').pop() ?? name;
}

function readDependencies(root: vscode.Uri): string[] {
  try {
    const text = fs.readFileSync(path.join(root.fsPath, 'Cargo.toml'), 'utf8');
    const dependencies = new Set<string>();
    let section = '';
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('[')) {
        section = line;
        continue;
      }
      if (!section.includes('dependencies')) {
        continue;
      }
      const match = /^([A-Za-z0-9_-]+)\s*=/.exec(line);
      if (match) {
        dependencies.add(match[1]);
      }
    }
    return Array.from(dependencies);
  } catch {
    return [];
  }
}

function relativePath(root: vscode.Uri, file: vscode.Uri): string {
  return path.relative(root.fsPath, file.fsPath).split(path.sep).join('/');
}

function nameColumn(
  document: vscode.TextDocument,
  startLine: number,
  name: string
): number {
  const line = document.lineAt(Math.max(0, startLine - 1)).text;
  const bare = name.split('::').pop() ?? name;
  return Math.max(0, line.indexOf(bare));
}

function withTimeout<T>(promise: Thenable<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    Promise.resolve(promise).catch(() => undefined),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))
  ]);
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function revisionFor(hashes: Record<string, string>): string {
  return sha256(
    Object.entries(hashes)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([file, hash]) => `${file}:${hash}`)
      .join('\n')
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function seconds(started: number): number {
  return Math.round((Date.now() - started) / 100) / 10;
}
