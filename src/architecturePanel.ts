import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ArchitectureModel } from './architecture';
import { FlowSpec } from './flow';
import { ReadingSpec } from './reading';

export type ArchitectureHandlers = {
  onOpenModule: (uri: vscode.Uri) => void;
  onWriteFlow?: () => void;
  onWriteReading?: () => void;
};

export class ArchitecturePanel {
  private static current: vscode.WebviewPanel | undefined;
  private static handlers: ArchitectureHandlers | undefined;
  private static root: string | undefined;

  static show(
    context: vscode.ExtensionContext,
    model: ArchitectureModel,
    handlers?: ArchitectureHandlers,
    flow?: FlowSpec,
    reading?: ReadingSpec
  ): void {
    ArchitecturePanel.handlers = handlers;
    ArchitecturePanel.root = model.meta.root;
    if (!ArchitecturePanel.current) {
      ArchitecturePanel.current = vscode.window.createWebviewPanel(
        'derust.architecture',
        'Derust — architecture',
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [context.extensionUri]
        }
      );
      ArchitecturePanel.current.onDidDispose(() => {
        ArchitecturePanel.current = undefined;
      });
      ArchitecturePanel.current.webview.onDidReceiveMessage((message: unknown) => {
        ArchitecturePanel.handleMessage(message);
      });
    }

    const panel = ArchitecturePanel.current;
    panel.title = `Derust — project — ${model.meta.crate}`;
    panel.webview.html = render(context.extensionUri, panel.webview, model, flow, reading);
    panel.reveal(vscode.ViewColumn.Active, false);
  }

  static postFlowDrawing(): void {
    void ArchitecturePanel.current?.webview.postMessage({ type: 'flowDrawing' });
  }

  static postFlow(flow: FlowSpec): void {
    void ArchitecturePanel.current?.webview.postMessage({ type: 'flow', flow });
  }

  static postFlowError(message: string): void {
    void ArchitecturePanel.current?.webview.postMessage({ type: 'flowError', message });
  }

  static postReading(reading: ReadingSpec): void {
    void ArchitecturePanel.current?.webview.postMessage({ type: 'reading', reading });
  }

  static postReadingError(message: string): void {
    void ArchitecturePanel.current?.webview.postMessage({ type: 'readingError', message });
  }

  private static handleMessage(message: unknown): void {
    if (!message || typeof message !== 'object') {
      return;
    }
    const data = message as Record<string, unknown>;
    if (data.type === 'writeFlow') {
      ArchitecturePanel.handlers?.onWriteFlow?.();
      return;
    }
    if (data.type === 'writeReading') {
      ArchitecturePanel.handlers?.onWriteReading?.();
      return;
    }
    if (data.type === 'openModule' && typeof data.file === 'string' && ArchitecturePanel.root) {
      ArchitecturePanel.handlers?.onOpenModule(
        vscode.Uri.file(path.join(ArchitecturePanel.root, data.file))
      );
      return;
    }
    if (data.type !== 'reveal' || typeof data.file !== 'string' || typeof data.line !== 'number') {
      return;
    }
    const file = data.file;
    const lineNumber = data.line;
    const root = typeof data.root === 'string' ? data.root : undefined;
    if (!root) {
      return;
    }
    const target = vscode.Uri.file(path.join(root, file));
    void vscode.workspace.openTextDocument(target).then((document) => {
      const line = Math.max(0, Math.min(document.lineCount - 1, lineNumber - 1));
      const position = new vscode.Position(line, 0);
      void vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: false,
        selection: new vscode.Range(position, position)
      });
    });
  }
}

function render(
  extensionUri: vscode.Uri,
  webview: vscode.Webview,
  model: ArchitectureModel,
  flow?: FlowSpec,
  reading?: ReadingSpec
): string {
  const template = fs.readFileSync(
    path.join(extensionUri.fsPath, 'media', 'architecture.html'),
    'utf8'
  );
  const nonce = crypto.randomBytes(16).toString('base64');
  const data = JSON.stringify({
    meta: model.meta,
    identity: model.brief.overview.identity
  }).replace(/<\//g, '<\\/');
  const flowJson = JSON.stringify(flow ?? null).replace(/<\//g, '<\\/');
  const readingJson = JSON.stringify(reading ?? null).replace(/<\//g, '<\\/');
  return template
    .replace('__CSP__', () => `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';`)
    .replace(/__NONCE__/g, () => nonce)
    .replace('__DATA__', () => data)
    .replace('__FLOW__', () => flowJson)
    .replace('__READING__', () => readingJson);
}
