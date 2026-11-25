import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { NARRATIVE_PROMPT_VERSION } from './projectNarrative';

export type NarrativeRecord = {
  narrative: string;
  model: string;
  revision: string;
  generatedAt: string;
};

type StoredNarrative = NarrativeRecord & { key: string; version: number };

const CACHE_VERSION = 1;

/** One narrative per workspace, keyed by revision + model + prompt version. */
export class NarrativeCache {
  constructor(private readonly context: vscode.ExtensionContext) {}

  key(revision: string, model: string): string {
    return crypto
      .createHash('sha256')
      .update(`${NARRATIVE_PROMPT_VERSION}\0${model}\0${revision}`)
      .digest('hex');
  }

  read(root: string, key: string): NarrativeRecord | undefined {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.pathFor(root), 'utf8')
      ) as StoredNarrative;
      if (
        !parsed ||
        parsed.version !== CACHE_VERSION ||
        parsed.key !== key ||
        typeof parsed.narrative !== 'string'
      ) {
        return undefined;
      }
      return {
        narrative: parsed.narrative,
        model: parsed.model,
        revision: parsed.revision,
        generatedAt: parsed.generatedAt
      };
    } catch {
      return undefined;
    }
  }

  write(root: string, key: string, record: NarrativeRecord): void {
    try {
      const target = this.pathFor(root);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const payload: StoredNarrative = { ...record, key, version: CACHE_VERSION };
      const temporary = `${target}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(payload), 'utf8');
      fs.renameSync(temporary, target);
    } catch {
      // A missing narrative cache only costs one extra request.
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
      'narrative.json'
    );
  }
}
