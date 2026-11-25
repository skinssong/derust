import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ArchitectureModel } from './architecture';
import { FlowSpec } from './flow';
import { ReadingSpec } from './reading';
import { PanelHost } from './panelHost';

export type ArchitectureHandlers = {
  onOpenModule: (uri: vscode.Uri) => void;
  onWriteFlow?: () => void;
  onWriteReading?: () => void;
};

export class ArchitecturePanel {
  private static handlers: ArchitectureHandlers | undefined;
  private static root: string | undefined;
  private static last:
    | {
        context: vscode.ExtensionContext;
        model: ArchitectureModel;
        flow?: FlowSpec;
        reading?: ReadingSpec;
        autoDraw: boolean;
      }
    | undefined;

  static show(
    context: vscode.ExtensionContext,
    model: ArchitectureModel,
    handlers?: ArchitectureHandlers,
    flow?: FlowSpec,
    reading?: ReadingSpec,
    autoDraw = false
  ): void {
    ArchitecturePanel.handlers = handlers;
    ArchitecturePanel.root = model.meta.root;
    ArchitecturePanel.last = { context, model, flow, reading, autoDraw };
    ArchitecturePanel.renderLast(autoDraw);
  }

  static hasContent(): boolean {
    return Boolean(ArchitecturePanel.last);
  }

  /** Bring the project view back without rebuilding the model. */
  static reactivate(): boolean {
    const last = ArchitecturePanel.last;
    if (!last) {
      return false;
    }
    ArchitecturePanel.renderLast(!last.flow && last.autoDraw);
    return true;
  }

  static postFlow(flow: FlowSpec): void {
    if (ArchitecturePanel.last) {
      ArchitecturePanel.last.flow = flow;
    }
    if (PanelHost.view === 'project') {
      PanelHost.post({ type: 'flow', flow });
    }
  }

  static postFlowError(message: string): void {
    if (ArchitecturePanel.last) {
      ArchitecturePanel.last.autoDraw = false;
    }
    if (PanelHost.view === 'project') {
      PanelHost.post({ type: 'flowError', message });
    }
  }

  static postReading(reading: ReadingSpec): void {
    if (ArchitecturePanel.last) {
      ArchitecturePanel.last.reading = reading;
    }
    if (PanelHost.view === 'project') {
      PanelHost.post({ type: 'reading', reading });
    }
  }

  static postReadingError(message: string): void {
    if (PanelHost.view === 'project') {
      PanelHost.post({ type: 'readingError', message });
    }
  }

  private static renderLast(autoDraw: boolean): void {
    const last = ArchitecturePanel.last;
    if (!last) {
      return;
    }
    const panel = PanelHost.ensure(last.context);
    PanelHost.register('project', (message: unknown) =>
      ArchitecturePanel.handleMessage(message)
    );
    PanelHost.setView('project');
    panel.webview.html = render(
      last.context.extensionUri,
      panel.webview,
      last.model,
      last.flow,
      last.reading,
      autoDraw
    );
    PanelHost.reveal(false);
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
  reading?: ReadingSpec,
  autoDraw = false
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
    .replace('__AUTODRAW__', () => (autoDraw ? 'true' : 'false'))
    .replace('__DATA__', () => data)
    .replace('__FLOW__', () => flowJson)
    .replace('__READING__', () => readingJson);
}
