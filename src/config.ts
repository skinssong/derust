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
  autoAnalyze: boolean;
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
    autoAnalyze: config.get<boolean>('autoAnalyze', true),
    colorCode: config.get<boolean>('colorCode', true),
    overviewGlance: config.get<boolean>('overviewGlance', true),
    briefOnOverview: config.get<boolean>('briefOnOverview', true)
  };
}

export async function resolveApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  const stored = await context.secrets.get(API_KEY_SECRET);
  return stored?.trim() || undefined;
}

export type ProviderSetup = { config: ReaderConfig; apiKey: string };

function validateBaseUrl(value: string): string | undefined {
  const text = value.trim();
  if (!text) {
    return 'A base URL is required.';
  }
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return 'The URL must start with http:// or https://.';
    }
  } catch {
    return 'Enter a valid URL.';
  }
  return undefined;
}

let providerSetup: Promise<ProviderSetup | undefined> | undefined;

/**
 * Return a usable provider configuration, asking for what is missing. The base
 * URL and model are written to the user's VS Code settings; the key goes to
 * SecretStorage. With `force`, every field is asked again and an empty key
 * keeps the stored one. Concurrent callers share one setup prompt.
 */
export async function ensureProvider(
  context: vscode.ExtensionContext,
  options: { force?: boolean } = {}
): Promise<ProviderSetup | undefined> {
  if (options.force) {
    return ensureProviderInner(context, options);
  }
  if (providerSetup) {
    return providerSetup;
  }
  providerSetup = ensureProviderInner(context, options);
  try {
    return await providerSetup;
  } finally {
    providerSetup = undefined;
  }
}

async function ensureProviderInner(
  context: vscode.ExtensionContext,
  options: { force?: boolean } = {}
): Promise<ProviderSetup | undefined> {
  let config = getConfig();
  let apiKey = await resolveApiKey(context);
  const askConnection = Boolean(options.force) || !config.baseUrl || !config.model;
  const askKey = Boolean(options.force) || !apiKey;

  if (!askConnection && !askKey) {
    return { config, apiKey: apiKey! };
  }

  let baseUrl = config.baseUrl;
  let model = config.model;
  if (options.force || !baseUrl) {
    const answer = await vscode.window.showInputBox({
      title: 'Derust: provider base URL',
      prompt: 'Base URL of an OpenAI-compatible endpoint, for example https://api.openai.com/v1',
      value: baseUrl,
      placeHolder: 'https://api.example.com/v1',
      ignoreFocusOut: true,
      validateInput: validateBaseUrl
    });
    if (answer === undefined) {
      return undefined;
    }
    baseUrl = answer.trim();
  }
  if (options.force || !model) {
    const answer = await vscode.window.showInputBox({
      title: 'Derust: model',
      prompt: 'Model id sent to the provider (stored in derust.model).',
      value: model,
      placeHolder: 'gpt-4.1-mini',
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : 'A model id is required.')
    });
    if (answer === undefined) {
      return undefined;
    }
    model = answer.trim();
  }
  const settings = vscode.workspace.getConfiguration('derust');
  await settings.update('baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
  await settings.update('model', model, vscode.ConfigurationTarget.Global);

  if (askKey) {
    const answer = await vscode.window.showInputBox({
      title: 'Derust: API key',
      prompt: apiKey
        ? 'Stored in VS Code SecretStorage, never in settings.json. Leave empty to keep the current key.'
        : 'Stored in VS Code SecretStorage, never in settings.json.',
      password: true,
      ignoreFocusOut: true
    });
    if (answer === undefined) {
      return undefined;
    }
    if (answer.trim()) {
      apiKey = answer.trim();
    }
  }
  if (!apiKey) {
    void vscode.window.showWarningMessage('Derust: an API key is required.');
    return undefined;
  }

  await context.secrets.store(API_KEY_SECRET, apiKey);
  config = { ...getConfig(), baseUrl, model };
  return { config, apiKey };
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
