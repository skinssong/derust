import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { Analysis, FileBrief, StructuralOverview, Usage } from './contract';

export type PanelLens = 'overview' | 'spotlights' | 'ownership';

export type PanelCallbacks = {
  onReveal: (start: number, end: number) => void;
  onAnalyze: (force: boolean) => void;
  onImportEnv: () => void;
  onScrolled: (line: number) => void;
};

export type PanelPayload = {
  file: string;
  analysis: Analysis;
  overview?: StructuralOverview;
  layout: 'cards' | 'columns';
  meta: {
    model: string;
    generatedAt?: string;
    usage?: { input: number; output: number };
    issues?: string[];
  };
};

export type OverviewPayload = {
  file: string;
  overview: StructuralOverview;
};

export type BriefPayload = {
  file: string;
  brief?: FileBrief;
  stale?: boolean;
  loading?: boolean;
  meta?: {
    model: string;
    generatedAt?: string;
    usage?: Usage;
  };
};

export class ReaderPanel implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly callbacks: PanelCallbacks;
  private disposed = false;
  private ready = false;
  private pending: unknown[] = [];

  static create(
    context: vscode.ExtensionContext,
    sourceUri: vscode.Uri,
    callbacks: PanelCallbacks
  ): ReaderPanel {
    const panel = vscode.window.createWebviewPanel(
      'derust.panel',
      `Derust — ${path.basename(sourceUri.fsPath)}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [context.extensionUri]
      }
    );

    return new ReaderPanel(panel, context, sourceUri, callbacks);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    sourceUri: vscode.Uri,
    callbacks: PanelCallbacks
  ) {
    this.panel = panel;
    this.callbacks = callbacks;
    this.panel.webview.html = renderHtml(this.panel.webview, context.extensionUri);

    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => this.handleMessage(message),
      undefined,
      []
    );
    this.panel.onDidDispose(() => {
      this.disposed = true;
      this.pending = [];
    });

    this.panel.title = `Derust — ${path.basename(sourceUri.fsPath)}`;
  }

  setSource(uri: vscode.Uri): void {
    if (!this.disposed) {
      this.panel.title = `Derust — ${path.basename(uri.fsPath)}`;
    }
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  update(payload: PanelPayload): void {
    this.send({ type: 'analysis', payload });
  }

  updateOverview(payload: OverviewPayload): void {
    this.send({ type: 'overview', payload });
  }

  updateBrief(payload: BriefPayload): void {
    this.send({ type: 'brief', payload });
  }

  focusLens(lens: PanelLens): void {
    this.send({ type: 'focusLens', lens });
  }

  setCursor(line: number): void {
    this.send({ type: 'cursor', line });
  }

  setScrollLine(line: number): void {
    this.send({ type: 'scrollToLine', line });
  }

  setStatus(state: 'loading' | 'ready' | 'stale' | 'error' | 'empty', message: string): void {
    this.send({ type: 'status', state, message });
  }

  reveal(): void {
    if (!this.disposed) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
    }
  }

  dispose(): void {
    if (!this.disposed) {
      this.panel.dispose();
    }
  }

  private send(message: unknown): void {
    if (this.disposed) {
      return;
    }
    if (!this.ready) {
      this.pending.push(message);
      return;
    }
    void this.panel.webview.postMessage(message);
  }

  private handleMessage(message: unknown): void {
    if (!isObject(message) || typeof message.type !== 'string') {
      return;
    }

    switch (message.type) {
      case 'ready':
        this.ready = true;
        for (const pending of this.pending) {
          void this.panel.webview.postMessage(pending);
        }
        this.pending = [];
        break;
      case 'reveal':
        if (isNumber(message.start) && isNumber(message.end)) {
          this.callbacks.onReveal(message.start, message.end);
        }
        break;
      case 'analyze':
        this.callbacks.onAnalyze(Boolean(message.force));
        break;
      case 'reanalyze':
        this.callbacks.onAnalyze(true);
        break;
      case 'importEnv':
        this.callbacks.onImportEnv();
        break;
      case 'scrolled':
        if (isNumber(message.line)) {
          this.callbacks.onScrolled(message.line);
        }
        break;
    }
  }
}

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'panel.css'));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'panel.js'));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<link rel="stylesheet" href="${styleUri}">
<title>Derust</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
