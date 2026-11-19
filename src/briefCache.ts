import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CachedBrief } from './contract';
import { BRIEF_PROMPT_VERSION } from './brief';

export class BriefCache {
  constructor(private readonly context: vscode.ExtensionContext) {}

  key(
    fileLabel: string,
    sourceHash: string,
    model: string,
    contextRevision = ''
  ): string {
    return crypto
      .createHash('sha256')
      .update(`${BRIEF_PROMPT_VERSION}\0${model}\0${fileLabel}\0${sourceHash}\0${contextRevision}`)
      .digest('hex');
  }

  async read(key: string): Promise<CachedBrief | undefined> {
    try {
      const raw = await fs.promises.readFile(this.pathFor(key), 'utf8');
      const parsed = JSON.parse(raw) as CachedBrief;
      if (!parsed || typeof parsed !== 'object' || !parsed.brief) {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  async readLatestForFile(
    fileLabel: string,
    model: string,
    sourceHash?: string,
    fileKey?: string
  ): Promise<CachedBrief | undefined> {
    const directories = await this.cacheDirectories();
    let best: CachedBrief | undefined;

    for (const directory of directories) {
      let entries: string[];
      try {
        entries = await fs.promises.readdir(directory);
      } catch {
        continue;
      }

      for (const name of entries) {
        if (!name.endsWith('.json')) {
          continue;
        }

        try {
          const raw = await fs.promises.readFile(path.join(directory, name), 'utf8');
          const parsed = JSON.parse(raw) as CachedBrief;
          if (!parsed || !parsed.brief || parsed.model !== model) {
            continue;
          }

          const fileMatches =
            parsed.brief.file === fileLabel ||
            fileLabel.endsWith(`/${parsed.brief.file}`) ||
            parsed.brief.file.endsWith(`/${fileLabel}`);
          const hashMatches = Boolean(sourceHash) && parsed.sourceHash === sourceHash;
          const keyMatches = Boolean(fileKey) && parsed.fileKey === fileKey;
          const legacyMatches = !parsed.fileKey && (fileMatches || hashMatches);
          if (!keyMatches && !legacyMatches) {
            continue;
          }

          if (!best || parsed.generatedAt > best.generatedAt) {
            best = parsed;
          }
        } catch {
          // Skip unreadable or partially written cache entries.
        }
      }
    }

    return best;
  }

  async write(key: string, value: CachedBrief): Promise<void> {
    await fs.promises.mkdir(this.directory(), { recursive: true });
    await fs.promises.writeFile(this.pathFor(key), JSON.stringify(value, null, 2), 'utf8');
  }

  async clear(): Promise<void> {
    await fs.promises.rm(this.root(), { recursive: true, force: true });
  }

  private async cacheDirectories(): Promise<string[]> {
    const directories = new Set<string>([this.directory()]);
    try {
      const entries = await fs.promises.readdir(this.root(), { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          directories.add(path.join(this.root(), entry.name));
        }
      }
    } catch {
      // The cache may not exist yet.
    }
    return Array.from(directories);
  }

  private root(): string {
    return path.join(this.context.globalStorageUri.fsPath, 'derust-brief');
  }

  private directory(): string {
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'untitled';
    const hash = crypto.createHash('sha256').update(workspace).digest('hex').slice(0, 16);
    return path.join(this.root(), hash);
  }

  private pathFor(key: string): string {
    return path.join(this.directory(), `${key}.json`);
  }
}
