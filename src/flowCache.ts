import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { StoredFlow } from './flow';
import { FLOW_PROMPT_VERSION } from './flow';

type Stored = StoredFlow & { key: string; version: number };

const CACHE_VERSION = 3;

/** One flow diagram per workspace, keyed by revision + model + prompt version. */
export class FlowCache {
  constructor(private readonly context: vscode.ExtensionContext) {}

  key(revision: string, model: string): string {
    return crypto
      .createHash('sha256')
      .update(`${FLOW_PROMPT_VERSION}\0${model}\0${revision}`)
      .digest('hex');
  }

  read(root: string, key: string): StoredFlow | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.pathFor(root), 'utf8')) as Stored;
      if (
        !parsed ||
        parsed.version !== CACHE_VERSION ||
        parsed.key !== key ||
        !Array.isArray(parsed.stages) ||
        !Array.isArray(parsed.edges)
      ) {
        return undefined;
      }
      return {
        title: parsed.title,
        stages: parsed.stages,
        edges: parsed.edges,
        brief: typeof parsed.brief === 'string' ? parsed.brief : undefined,
        model: parsed.model,
        revision: parsed.revision,
        generatedAt: parsed.generatedAt
      };
    } catch {
      return undefined;
    }
  }

  write(root: string, key: string, flow: StoredFlow): void {
    try {
      const target = this.pathFor(root);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const payload: Stored = { ...flow, key, version: CACHE_VERSION };
      const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(payload), 'utf8');
      fs.renameSync(temporary, target);
    } catch {
      // The flow can be regenerated; a failed cache write is not fatal.
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
      'flow.json'
    );
  }
}
