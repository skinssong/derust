import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  IndexRelation,
  ModuleContext,
  OverviewSymbol,
  StructuralOverview
} from './contract';
import { OverviewService } from './overviewLens';
import { crateRoot, modulePathFor } from './project';

const INDEX_VERSION = 1;
const MAX_RELATIONS = 120;

type IndexedModule = {
  overview: StructuralOverview;
};

type CachedRelations = {
  callers: IndexRelation[];
  callees: IndexRelation[];
  tests: IndexRelation[];
};

type IndexCache = {
  version: number;
  workspace: string;
  revision: string;
  fileHashes: Record<string, string>;
  modules: Record<string, IndexedModule>;
  relations: Record<string, CachedRelations>;
};

export class IndexService {
  private readonly relationRefreshes = new Map<string, Promise<void>>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly overviewService: OverviewService,
    private readonly output: vscode.OutputChannel
  ) {}

  async getPacket(uri: vscode.Uri): Promise<ModuleContext | undefined> {
    const root = this.rootFor(uri);
    if (!root) {
      return undefined;
    }

    const started = Date.now();
    this.output.appendLine(`[index] scanning ${root.fsPath}`);
    const snapshot = await this.snapshot(root);
    const { files, fileHashes, revision } = snapshot;
    if (files.length === 0) {
      return undefined;
    }
    this.output.appendLine(
      `[index] ${files.length} Rust files hashed in ${Date.now() - started}ms`
    );
    const relFor = (file: vscode.Uri): string =>
      path.relative(root.fsPath, file.fsPath).split(path.sep).join('/');

    const cached = this.loadCache(root);
    const cacheHit = cached?.revision === revision;
    const modules: Record<string, IndexedModule> =
      cacheHit && cached ? { ...cached.modules } : {};
    const relations: Record<string, CachedRelations> =
      cacheHit && cached ? { ...cached.relations } : {};

    const targetRelative = relFor(uri);
    let target = modules[targetRelative];
    if (!target || cached?.fileHashes[targetRelative] !== fileHashes[targetRelative]) {
      const document = await vscode.workspace.openTextDocument(uri);
      const buildStarted = Date.now();
      const overview = await this.overviewService.build(document, 5000);
      this.output.appendLine(
        `[index] ${targetRelative}: overview built in ${Date.now() - buildStarted}ms`
      );
      overview.file = targetRelative;
      overview.modulePath = modulePathFor(uri, root) ?? overview.modulePath;
      target = { overview };
      modules[targetRelative] = target;
      delete relations[targetRelative];
    }

    const targetRelations = relations[targetRelative] ?? emptyRelations();
    const cache: IndexCache = {
      version: INDEX_VERSION,
      workspace: root.fsPath,
      revision,
      fileHashes,
      modules,
      relations
    };
    this.saveCache(root, cache);
    this.output.appendLine(
      `[index] ${targetRelative}: ${cacheHit ? 'cache hit' : 'structural update'}; ` +
        `${Object.keys(modules).length} modules cached; ` +
        `${targetRelations.callers.length} callers, ` +
        `${targetRelations.callees.length} callees; ` +
        `${Date.now() - started}ms`
    );

    return this.toModuleContext(
      targetRelative,
      target.overview,
      targetRelations,
      revision,
      root
    );
  }

  async refreshRelations(uri: vscode.Uri, revision: string): Promise<void> {
    const root = this.rootFor(uri);
    if (!root) {
      return;
    }
    const targetRelative = path.relative(root.fsPath, uri.fsPath).split(path.sep).join('/');
    const key = `${root.fsPath}\0${targetRelative}\0${revision}`;
    const existing = this.relationRefreshes.get(key);
    if (existing) {
      return existing;
    }

    const task = this.refreshRelationsNow(uri, root, targetRelative, revision).finally(() => {
      this.relationRefreshes.delete(key);
    });
    this.relationRefreshes.set(key, task);
    return task;
  }

  private async refreshRelationsNow(
    uri: vscode.Uri,
    root: vscode.Uri,
    targetRelative: string,
    revision: string
  ): Promise<void> {
    const cached = this.loadCache(root);
    if (!cached || cached.revision !== revision || !cached.modules[targetRelative]) {
      return;
    }
    if (cached.relations[targetRelative]) {
      return;
    }

    const started = Date.now();
    const relations = await this.buildRelations(uri, cached.modules[targetRelative].overview, root);
    const latest = this.loadCache(root);
    if (!latest || latest.revision !== revision || !latest.modules[targetRelative]) {
      return;
    }
    latest.relations[targetRelative] = relations;
    this.saveCache(root, latest);
    this.output.appendLine(
      `[index] ${targetRelative}: relations refreshed; ` +
        `${relations.callers.length} callers, ${relations.callees.length} callees; ` +
        `${Date.now() - started}ms`
    );
  }

  cachePathFor(uri: vscode.Uri): string | undefined {
    const root = this.rootFor(uri);
    return root ? this.cachePath(root) : undefined;
  }

  async currentRevision(uri: vscode.Uri): Promise<string | undefined> {
    const root = this.rootFor(uri);
    if (!root) {
      return undefined;
    }
    const snapshot = await this.snapshot(root);
    return snapshot.files.length > 0 ? snapshot.revision : undefined;
  }

  /** Hashes the crate's files without opening a document for each one:
   * open documents keep their unsaved text, everything else is read from
   * disk. Opening every file used to dominate the index wait. */
  private async snapshot(root: vscode.Uri): Promise<{
    files: vscode.Uri[];
    fileHashes: Record<string, string>;
    revision: string;
  }> {
    const files = await this.findRustFiles(root);
    const open = new Map<string, vscode.TextDocument>();
    for (const document of vscode.workspace.textDocuments) {
      open.set(document.uri.toString(), document);
    }
    const fileHashes: Record<string, string> = {};
    const decoder = new TextDecoder();

    for (const file of files) {
      const relative = path.relative(root.fsPath, file.fsPath).split(path.sep).join('/');
      const document = open.get(file.toString());
      if (document) {
        fileHashes[relative] = sha256(document.getText());
        continue;
      }
      try {
        fileHashes[relative] = sha256(decoder.decode(await vscode.workspace.fs.readFile(file)));
      } catch {
        // Unreadable files do not contribute to the revision.
      }
    }

    return { files, fileHashes, revision: revisionFor(fileHashes) };
  }

  async rebuild(uri: vscode.Uri): Promise<void> {
    const root = this.rootFor(uri);
    if (!root) {
      throw new Error('Open a Rust workspace first.');
    }
    await fs.promises.rm(this.cachePath(root), { force: true });
    const packet = await this.getPacket(uri);
    if (packet) {
      await this.refreshRelations(uri, packet.revision);
    }
  }

  private rootFor(uri: vscode.Uri): vscode.Uri | undefined {
    return crateRoot(uri) ?? vscode.workspace.getWorkspaceFolder(uri)?.uri;
  }

  private async findRustFiles(root: vscode.Uri): Promise<vscode.Uri[]> {
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(root, '**/*.rs'),
      '**/{target,.git,node_modules}/**'
    );
    return files
      .filter((file) => file.scheme === 'file')
      .sort((left, right) => left.fsPath.localeCompare(right.fsPath));
  }

  private async buildRelations(
    uri: vscode.Uri,
    overview: StructuralOverview,
    root: vscode.Uri
  ): Promise<CachedRelations> {
    const document = await vscode.workspace.openTextDocument(uri);
    const callers: IndexRelation[] = [];
    const callees: IndexRelation[] = [];
    const functions = overview.symbols.filter(
      (symbol) => symbol.kind === 'fn' && symbol.visibility !== 'private'
    );

    for (const symbol of functions) {
      const position = new vscode.Position(
        Math.max(0, symbol.start - 1),
        symbol.selectionCharacter ?? nameColumn(document, symbol.start, symbol.name)
      );

      const prepared = await withTimeout(
        vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
          'vscode.prepareCallHierarchy',
          uri,
          position
        ),
        8000
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
        8000
      );
      for (const call of incoming ?? []) {
        const relation = toRelation(call.from, root);
        if (relation) {
          callers.push({
            ...relation,
            source: call.from.name,
            target: symbol.name
          });
        }
      }

      const outgoing = await withTimeout(
        vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
          'vscode.provideOutgoingCalls',
          item
        ),
        8000
      );
      for (const call of outgoing ?? []) {
        const relation = toRelation(call.to, root);
        if (relation) {
          callees.push({
            ...relation,
            source: symbol.name,
            target: call.to.name
          });
        }
      }
    }

    const ownTests = overview.symbols
      .filter((symbol) => symbol.test)
      .map((symbol) => ({
        name: symbol.name,
        file: overview.file,
        line: symbol.start
      }));

    const tests = dedupeRelations([
      ...callers.filter((relation) => relation.file.startsWith('tests/')),
      ...ownTests
    ]);

    return {
      callers: dedupeRelations(callers),
      callees: dedupeRelations(callees),
      tests
    };
  }

  private toModuleContext(
    file: string,
    overview: StructuralOverview,
    relations: CachedRelations,
    revision: string,
    root: vscode.Uri
  ): ModuleContext {
    const publicSurface = overview.symbols.filter(
      (symbol) =>
        symbol.visibility !== 'private' &&
        symbol.kind !== 'impl' &&
        symbol.kind !== 'mod'
    );

    return {
      file,
      modulePath: overview.modulePath,
      crateName: overview.crateName,
      moduleDoc: overview.moduleDoc,
      publicSurface,
      imports: overview.imports.map((item) =>
        item.symbols && item.symbols.length > 0
          ? `${item.path} (${item.symbols.join(', ')})`
          : item.path
      ),
      callers: relations.callers,
      callees: relations.callees,
      tests: relations.tests,
      dependencies: readCargoDependencies(root),
      revision
    };
  }

  private cachePath(root: vscode.Uri): string {
    const workspaceHash = sha256(root.fsPath).slice(0, 16);
    return path.join(
      this.context.globalStorageUri.fsPath,
      'derust-index',
      workspaceHash,
      'index.json'
    );
  }

  private loadCache(root: vscode.Uri): IndexCache | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cachePath(root), 'utf8')) as IndexCache;
      if (
        !parsed ||
        parsed.version !== INDEX_VERSION ||
        parsed.workspace !== root.fsPath ||
        !parsed.modules ||
        !parsed.fileHashes
      ) {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  private saveCache(root: vscode.Uri, cache: IndexCache): void {
    const cachePath = this.cachePath(root);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const temporary = `${cachePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(cache), 'utf8');
    fs.renameSync(temporary, cachePath);
  }
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function revisionFor(fileHashes: Record<string, string>): string {
  return sha256(
    Object.entries(fileHashes)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([file, hash]) => `${file}:${hash}`)
      .join('\n')
  );
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

function toRelation(
  item: vscode.CallHierarchyItem,
  root: vscode.Uri
): IndexRelation | undefined {
  if (item.uri.scheme !== 'file') {
    return undefined;
  }
  const relative = path.relative(root.fsPath, item.uri.fsPath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return undefined;
  }
  return {
    name: item.name,
    detail: item.detail,
    file: relative.split(path.sep).join('/'),
    line: item.selectionRange.start.line + 1,
    character: item.selectionRange.start.character
  };
}

function dedupeRelations(relations: IndexRelation[]): IndexRelation[] {
  const seen = new Set<string>();
  const result: IndexRelation[] = [];
  for (const relation of relations) {
    const key = `${relation.source ?? ''}\0${relation.target ?? ''}\0${relation.name}\0${relation.file}\0${relation.line}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(relation);
    if (result.length >= MAX_RELATIONS) {
      break;
    }
  }
  return result.sort(
    (left, right) =>
      left.file.localeCompare(right.file) || left.line - right.line
  );
}

function withTimeout<T>(promise: Thenable<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    Promise.resolve(promise).catch(() => undefined),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))
  ]);
}

function readCargoDependencies(root: vscode.Uri | undefined): string[] {
  if (!root) {
    return [];
  }

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


function emptyRelations(): CachedRelations {
  return { callers: [], callees: [], tests: [] };
}
