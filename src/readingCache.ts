import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { StoredReading } from './reading';
import { READING_PROMPT_VERSION } from './reading';

type Stored = StoredReading & { key: string; version: number };

const CACHE_VERSION = 1;

/** One reading order per workspace, keyed by revision + model + prompt version. */
export class ReadingCache {
  constructor(private readonly context: vscode.ExtensionContext) {}

  key(revision: string, model: string): string {
    return crypto
      .createHash('sha256')
      .update(`${READING_PROMPT_VERSION}\0${model}\0${revision}`)
      .digest('hex');
  }

  read(root: string, key: string): StoredReading | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.pathFor(root), 'utf8')) as Stored;
      if (
        !parsed ||
        parsed.version !== CACHE_VERSION ||
        parsed.key !== key ||
        !Array.isArray(parsed.steps)
      ) {
        return undefined;
      }
      return {
        steps: parsed.steps,
        model: parsed.model,
        revision: parsed.revision,
        generatedAt: parsed.generatedAt
      };
    } catch {
      return undefined;
    }
  }

  write(root: string, key: string, reading: StoredReading): void {
    try {
      const target = this.pathFor(root);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const payload: Stored = { ...reading, key, version: CACHE_VERSION };
      const temporary = `${target}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(payload), 'utf8');
      fs.renameSync(temporary, target);
    } catch {
      // The reading order can be regenerated; a failed cache write is not fatal.
    }
  }

  private pathFor(root: string): string {
    const workspaceHash = crypto
      .createHash('sha256')
      .update(root)
      .digest('hex')
      .slice(0, 16);
    return path.join(
      this.context.globalStorageUri.fsPath,
      'derust-index',
      workspaceHash,
      'reading.json'
    );
  }
}
