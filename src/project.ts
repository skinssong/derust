import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const crateNameCache = new Map<string, Promise<string | undefined>>();

export function crateRoot(uri: vscode.Uri): vscode.Uri | undefined {
  const stop = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
  let directory = path.dirname(uri.fsPath);

  for (let depth = 0; depth < 12; depth += 1) {
    if (fs.existsSync(path.join(directory, 'Cargo.toml'))) {
      return vscode.Uri.file(directory);
    }

    if (stop && directory === stop) {
      break;
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }

  return undefined;
}

export async function readCrateName(uri: vscode.Uri): Promise<string | undefined> {
  const base =
    crateRoot(uri) ??
    vscode.workspace.getWorkspaceFolder(uri)?.uri ??
    vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!base) {
    return undefined;
  }

  const cargoPath = path.join(base.fsPath, 'Cargo.toml');
  const existing = crateNameCache.get(cargoPath);
  if (existing) {
    return existing;
  }

  const read = (async (): Promise<string | undefined> => {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(cargoPath));
      const text = new TextDecoder().decode(bytes);
      const match = /^\s*name\s*=\s*"([^"]+)"/m.exec(text);
      return match?.[1];
    } catch {
      return undefined;
    }
  })();

  crateNameCache.set(cargoPath, read);
  return read;
}

export function modulePathFor(
  uri: vscode.Uri,
  root: vscode.Uri | undefined
): string | undefined {
  if (!root) {
    return undefined;
  }

  const relative = path.relative(root.fsPath, uri.fsPath).split(path.sep).join('/');
  if (!relative || relative.startsWith('..')) {
    return undefined;
  }

  let cleaned = relative.replace(/\.rs$/, '');
  if (cleaned === 'src/lib' || cleaned === 'src/main' || cleaned === 'lib' || cleaned === 'main') {
    return 'crate';
  }

  if (cleaned.startsWith('src/')) {
    cleaned = cleaned.slice(4);
  }

  cleaned = cleaned.replace(/\/mod$/, '');
  if (!cleaned) {
    return 'crate';
  }

  return `crate::${cleaned.split('/').join('::')}`;
}
