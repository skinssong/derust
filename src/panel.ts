import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { Analysis, FileBrief, StructuralOverview, Usage } from './contract';
import { PanelHost } from './panelHost';

export type PanelLens = 'overview' | 'spotlights' | 'ownership';

export type PanelCallbacks = {
  onReveal: (start: number, end: number) => void;
  onAnalyze: (force: boolean) => void;
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
  private readonly context: vscode.ExtensionContext;
  private readonly callbacks: PanelCallbacks;
  private readonly history = new Map<string, unknown>();
  private disposed = false;
  private ready = false;
  private pending: unknown[] = [];
  private sourceUri: vscode.Uri;

  static create(
    context: vscode.ExtensionContext,
    sourceUri: vscode.Uri,
    callbacks: PanelCallbacks
  ): ReaderPanel {
    return new ReaderPanel(PanelHost.ensure(context), context, sourceUri, callbacks);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    sourceUri: vscode.Uri,
    callbacks: PanelCallbacks
  ) {
    this.panel = panel;
    this.context = context;
    this.sourceUri = sourceUri;
    this.callbacks = callbacks;

    PanelHost.register('file', (message: unknown) => this.handleMessage(message));
    PanelHost.setView('file');
    this.renderPage();

    this.panel.onDidDispose(() => {
      this.disposed = true;
      this.pending = [];
      PanelHost.unregister('file');
    });
  }

  setSource(uri: vscode.Uri): void {
    this.sourceUri = uri;
  }

  /** Show the file view again, re-rendering the page and replaying the last
   * payloads (analysis, brief, status) that were sent to it. */
  activate(): void {
    if (this.disposed) {
      return;
    }
    this.renderPage();
    PanelHost.reveal(false);
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
    if (PanelHost.view !== 'file') {
      this.activate();
    }
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
    if (this.disposed) {
      return;
    }
    if (PanelHost.view !== 'file') {
      this.activate();
      return;
    }
    PanelHost.reveal(true);
  }

  dispose(): void {
    if (!this.disposed) {
      PanelHost.dispose();
    }
  }

  private renderPage(): void {
    PanelHost.setView('file');
    this.panel.webview.html = renderHtml(this.panel.webview, this.context.extensionUri);
    this.ready = false;
    this.pending = [...this.history.values()];
  }

  private send(message: unknown): void {
    if (this.disposed) {
      return;
    }
    if (isObject(message) && typeof message.type === 'string') {
      this.history.set(message.type, message);
      if (this.history.size > 20) {
        const oldest = this.history.keys().next().value;
        if (oldest) {
          this.history.delete(oldest);
        }
      }
    }
    if (PanelHost.view !== 'file') {
      this.renderPage();
      return;
    }
    if (PanelHost.view !== 'file') {
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
