import * as vscode from 'vscode';

export type PanelView = 'file' | 'project';

type Handler = (message: unknown) => void;

/**
 * One webview for the whole extension. The file view (module reading,
 * spotlights, ownership) and the project view (opening line, flow, reading
 * order) are modes of this panel; each registers the handler for its own
 * messages, and switching modes replaces the page.
 */
export class PanelHost {
  private static panel: vscode.WebviewPanel | undefined;
  private static mode: PanelView = 'file';
  private static handlers: Partial<Record<PanelView, Handler>> = {};
  private static switchHandler: ((view: PanelView) => void) | undefined;

  static ensure(context: vscode.ExtensionContext): vscode.WebviewPanel {
    if (PanelHost.panel) {
      return PanelHost.panel;
    }
    const panel = vscode.window.createWebviewPanel(
      'derust.panel',
      'Derust',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [context.extensionUri]
      }
    );
    panel.onDidDispose(() => {
      PanelHost.panel = undefined;
      PanelHost.handlers = {};
    });
    panel.webview.onDidReceiveMessage((message: unknown) => {
      if (
        isObject(message) &&
        message.type === 'switchView' &&
        (message.view === 'project' || message.view === 'file')
      ) {
        PanelHost.switchHandler?.(message.view);
        return;
      }
      PanelHost.handlers[PanelHost.mode]?.(message);
    });
    PanelHost.panel = panel;
    return panel;
  }

  static get current(): vscode.WebviewPanel | undefined {
    return PanelHost.panel;
  }

  static get view(): PanelView {
    return PanelHost.mode;
  }

  static onSwitch(handler: (view: PanelView) => void): void {
    PanelHost.switchHandler = handler;
  }

  static register(view: PanelView, handler: Handler): void {
    PanelHost.handlers[view] = handler;
  }

  static unregister(view: PanelView): void {
    delete PanelHost.handlers[view];
  }

  static setView(view: PanelView): void {
    PanelHost.mode = view;
  }

  static post(message: unknown): void {
    void PanelHost.panel?.webview.postMessage(message);
  }

  static reveal(preserveFocus = false): void {
    PanelHost.panel?.reveal(vscode.ViewColumn.Beside, preserveFocus);
  }

  static dispose(): void {
    PanelHost.panel?.dispose();
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
