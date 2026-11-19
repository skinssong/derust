import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export const API_KEY_SECRET = 'derust.apiKey';

export type ReaderConfig = {
  baseUrl: string;
  model: string;
  jsonMode: boolean;
  timeoutSeconds: number;
  maxOutputTokens: number;
  reasoningEffort: 'none' | 'low' | 'medium' | 'high';
  maxFileLines: number;
  includeDocs: boolean;
  concurrency: number;
  maxFiles: number;
  defaultLayout: 'cards' | 'columns';
  restoreLastAnalysis: boolean;
  colorCode: boolean;
  overviewGlance: boolean;
  briefOnOverview: boolean;
};

export function getConfig(): ReaderConfig {
  const config = vscode.workspace.getConfiguration('derust');
  const effort = config.get<string>('reasoningEffort', 'low');
  return {
    baseUrl: config.get<string>('baseUrl', '').trim(),
    model: config.get<string>('model', '').trim(),
    jsonMode: config.get<boolean>('jsonMode', true),
    timeoutSeconds: config.get<number>('timeoutSeconds', 300),
    maxOutputTokens: config.get<number>('maxOutputTokens', 32768),
    reasoningEffort:
      effort === 'none' || effort === 'medium' || effort === 'high' ? effort : 'low',
    maxFileLines: config.get<number>('maxFileLines', 1200),
    includeDocs: config.get<boolean>('includeDocs', true),
    concurrency: Math.max(1, Math.min(4, config.get<number>('concurrency', 2))),
    maxFiles: Math.max(1, config.get<number>('maxFiles', 20)),
    defaultLayout: config.get<string>('defaultLayout', 'cards') === 'columns' ? 'columns' : 'cards',
    restoreLastAnalysis: config.get<boolean>('restoreLastAnalysis', true),
    colorCode: config.get<boolean>('colorCode', true),
    overviewGlance: config.get<boolean>('overviewGlance', true),
    briefOnOverview: config.get<boolean>('briefOnOverview', true)
  };
}

export async function resolveApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  const stored = await context.secrets.get(API_KEY_SECRET);
  if (stored?.trim()) {
    return stored.trim();
  }

  return process.env.LLM_API_KEY?.trim() || undefined;
}

export async function importProviderSettings(context: vscode.ExtensionContext): Promise<boolean> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const candidates = [
    workspaceRoot ? path.join(workspaceRoot, 'harness', '.env') : undefined,
    workspaceRoot ? path.join(workspaceRoot, '.env') : undefined,
    path.join(context.extensionUri.fsPath, '.env')
  ].filter((value): value is string => Boolean(value));

  const existing = candidates.find((candidate) => fs.existsSync(candidate));
  const value = await vscode.window.showInputBox({
    title: 'Import provider settings',
    prompt: 'Path to a .env file containing LLM_BASE_URL, LLM_API_KEY and LLM_MODEL',
    value: existing ?? candidates[1] ?? '.env',
    ignoreFocusOut: true
  });

  if (!value) {
    return false;
  }

  try {
    const parsed = parseEnvFile(value.trim());
    const baseUrl = (parsed.LLM_BASE_URL ?? '').trim();
    const apiKey = (parsed.LLM_API_KEY ?? '').trim();
    const model = (parsed.LLM_MODEL ?? '').trim();

    if (!baseUrl || !apiKey || !model) {
      throw new Error('LLM_BASE_URL, LLM_API_KEY and LLM_MODEL are all required.');
    }

    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('LLM_BASE_URL must be http(s).');
    }

    await context.secrets.store(API_KEY_SECRET, apiKey);
    const config = vscode.workspace.getConfiguration('derust');
    await config.update('baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
    await config.update('model', model, vscode.ConfigurationTarget.Global);

    vscode.window.showInformationMessage(
      `Derust: imported provider settings for ${model}. The API key is stored in SecretStorage.`
    );
    return true;
  } catch (error) {
    vscode.window.showErrorMessage(`Derust: could not import settings. ${messageOf(error)}`);
    return false;
  }
}

export function parseEnvFile(filePath: string): Record<string, string> {
  const content = fs.readFileSync(filePath, 'utf8');
  const result: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }

    result[match[1]] = stripQuotes(match[2].trim());
  }

  return result;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
