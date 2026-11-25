import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ArchitectureModel } from './architecture';
import { FlowSpec } from './flow';
import { ReadingSpec } from './reading';

export type ArchitectureHandlers = {
  onOpenModule: (uri: vscode.Uri) => void;
  onWriteNarrative?: () => void;
  onWriteFlow?: () => void;
  onWriteReading?: () => void;
};

export type NarrativePayload = {
  text: string;
  generatedAt?: string;
};

export class ArchitecturePanel {
  private static current: vscode.WebviewPanel | undefined;
  private static handlers: ArchitectureHandlers | undefined;
  private static root: string | undefined;

  static show(
    context: vscode.ExtensionContext,
    model: ArchitectureModel,
    handlers?: ArchitectureHandlers,
    narrative?: NarrativePayload,
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
    panel.title = `Derust — architecture — ${model.meta.crate}`;
    panel.webview.html = render(context.extensionUri, panel.webview, model, narrative, flow, reading);
    panel.reveal(vscode.ViewColumn.Active, false);
  }

  static postNarrative(narrative: NarrativePayload): void {
    void ArchitecturePanel.current?.webview.postMessage({ type: 'narrative', ...narrative });
  }

  static postNarrativeError(message: string): void {
    void ArchitecturePanel.current?.webview.postMessage({ type: 'narrativeError', message });
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
    if (data.type === 'writeNarrative') {
      ArchitecturePanel.handlers?.onWriteNarrative?.();
      return;
    }
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
  narrative?: NarrativePayload,
  flow?: FlowSpec,
  reading?: ReadingSpec
): string {
  const template = fs.readFileSync(
    path.join(extensionUri.fsPath, 'media', 'architecture.html'),
    'utf8'
  );
  const cytoscape = fs.readFileSync(
    path.join(extensionUri.fsPath, 'media', 'cytoscape.min.js'),
    'utf8'
  );
  const nonce = crypto.randomBytes(16).toString('base64');
  const data = JSON.stringify(model).replace(/<\//g, '<\\/');
  const narrativeJson = JSON.stringify(narrative ?? null).replace(/<\//g, '<\\/');
  const flowJson = JSON.stringify(flow ?? null).replace(/<\//g, '<\\/');
  const readingJson = JSON.stringify(reading ?? null).replace(/<\//g, '<\\/');
  return template
    .replace('__CSP__', () => `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';`)
    .replace(/__NONCE__/g, () => nonce)
    .replace('__CYTOSCAPE__', () => cytoscape)
    .replace('__DATA__', () => data)
    .replace('__NARRATIVE__', () => narrativeJson)
    .replace('__FLOW__', () => flowJson)
    .replace('__READING__', () => readingJson);
}
