import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CachedAnalysis } from './contract';
import { PROMPT_VERSION } from './schema';

export class AnalysisCache {
  constructor(private readonly context: vscode.ExtensionContext) {}

  key(sourceText: string, model: string, docs: string): string {
    const content = crypto.createHash('sha256').update(sourceText).digest('hex');
    const context = crypto
      .createHash('sha256')
      .update(`${PROMPT_VERSION}\0${model}\0${docs}`)
      .digest('hex')
      .slice(0, 16);
    return `${content}-${context}`;
  }

  sourceHash(sourceText: string): string {
    return crypto.createHash('sha256').update(sourceText).digest('hex');
  }

  async read(key: string): Promise<CachedAnalysis | undefined> {
    try {
      const raw = await fs.promises.readFile(this.pathFor(key), 'utf8');
      const parsed = JSON.parse(raw) as CachedAnalysis;
      if (!parsed || typeof parsed !== 'object' || !parsed.analysis) {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  async readLatestForFile(
    fileLabel: string,
    sourceHash: string,
    model: string
  ): Promise<CachedAnalysis | undefined> {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(this.directory());
    } catch {
      return undefined;
    }

    let best: CachedAnalysis | undefined;

    for (const name of entries) {
      if (!name.endsWith('.json')) {
        continue;
      }

      try {
        const raw = await fs.promises.readFile(path.join(this.directory(), name), 'utf8');
        const parsed = JSON.parse(raw) as CachedAnalysis;
        if (
          !parsed ||
          !parsed.analysis ||
          parsed.sourceHash !== sourceHash ||
          parsed.model !== model ||
          parsed.analysis.file !== fileLabel ||
          !Array.isArray(parsed.analysis.memory) ||
          (parsed.promptVersion !== undefined && parsed.promptVersion !== PROMPT_VERSION)
        ) {
          continue;
        }

        if (!best || parsed.generatedAt > best.generatedAt) {
          best = parsed;
        }
      } catch {
        // Skip unreadable or partially written cache entries.
      }
    }

    return best;
  }

  async write(key: string, value: CachedAnalysis, rawResponse: string): Promise<void> {
    await fs.promises.mkdir(this.directory(), { recursive: true });
    await fs.promises.writeFile(this.pathFor(key), JSON.stringify(value, null, 2), 'utf8');
    await fs.promises.writeFile(this.rawPathFor(key), rawResponse, 'utf8');
  }

  async clear(): Promise<void> {
    await fs.promises.rm(this.directory(), { recursive: true, force: true });
  }

  private directory(): string {
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'untitled';
    const hash = crypto.createHash('sha256').update(workspace).digest('hex').slice(0, 16);
    return path.join(this.context.globalStorageUri.fsPath, 'derust', hash);
  }

  private pathFor(key: string): string {
    return path.join(this.directory(), `${key}.json`);
  }

  private rawPathFor(key: string): string {
    return path.join(this.directory(), `${key}.raw.txt`);
  }
}
