import * as vscode from 'vscode';
import { getConfig } from './config';
import {
  OverviewSymbol,
  OverviewSymbolKind,
  StructuralOverview
} from './contract';
import { buildStructuralOverview } from './overview';
import { crateRoot, modulePathFor, readCrateName } from './project';

export class OverviewService {
  async build(
    document: vscode.TextDocument,
    symbolTimeoutMs = 800
  ): Promise<StructuralOverview> {
    const text = document.getText();
    const symbols = await readDocumentSymbols(document, symbolTimeoutMs);
    const root = crateRoot(document.uri);

    return buildStructuralOverview({
      file: vscode.workspace.asRelativePath(document.uri, false),
      text,
      modulePath: modulePathFor(document.uri, root),
      crateName: await readCrateName(document.uri),
      symbols
    });
  }
}

export class OverviewLens implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly registration: vscode.Disposable;

  constructor() {
    this.registration = vscode.languages.registerCodeLensProvider(
      { language: 'rust', scheme: 'file' },
      {
        onDidChangeCodeLenses: this.emitter.event,
        provideCodeLenses: (document) => this.provide(document)
      }
    );
  }

  refresh(): void {
    this.emitter.fire();
  }

  dispose(): void {
    this.registration.dispose();
    this.emitter.dispose();
  }

  private provide(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!getConfig().overviewGlance) {
      return [];
    }

    const overview = buildStructuralOverview({
      file: vscode.workspace.asRelativePath(document.uri, false),
      text: document.getText()
    });

    return [
      new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
        title: glanceTitle(overview),
        command: 'derust.showOverview',
        arguments: [document.uri],
        tooltip: 'Open the Derust file overview'
      })
    ];
  }
}

function glanceTitle(overview: StructuralOverview): string {
  const bits = ['Overview'];
  if (overview.keyConstructs.length > 0) {
    bits.push(
      `${overview.keyConstructs.length} construct${overview.keyConstructs.length === 1 ? '' : 's'}`
    );
  }
  if (overview.imports.length > 0) {
    bits.push(`${overview.imports.length} import${overview.imports.length === 1 ? '' : 's'}`);
  }
  return `$(book) ${truncate(bits.join(' · '), 120)}`;
}

async function readDocumentSymbols(
  document: vscode.TextDocument,
  timeoutMs = 800
): Promise<OverviewSymbol[] | undefined> {
  try {
    const result = await Promise.race([
      vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
        'vscode.executeDocumentSymbolProvider',
        document.uri
      ),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs))
    ]);

    if (!Array.isArray(result) || result.length === 0) {
      return undefined;
    }

    const symbols: OverviewSymbol[] = [];
    for (const symbol of result) {
      const mapped = toOverviewSymbol(symbol, document);
      if (mapped) {
        symbols.push(mapped);
      }

      if (mapped?.kind === 'impl' && 'children' in symbol && Array.isArray(symbol.children)) {
        const parent = implTypeName(mapped.name);
        if (!parent) {
          continue;
        }
        for (const child of symbol.children) {
          const childMapped = toOverviewSymbol(child, document, parent);
          if (childMapped) {
            symbols.push(childMapped);
          }
        }
      }
    }

    return symbols.length > 0 ? symbols : undefined;
  } catch {
    return undefined;
  }
}

function toOverviewSymbol(
  symbol: vscode.DocumentSymbol | vscode.SymbolInformation,
  document: vscode.TextDocument,
  parent?: string
): OverviewSymbol | undefined {
  const range = 'location' in symbol ? symbol.location.range : symbol.range;
  const detail = 'detail' in symbol ? symbol.detail : '';
  const kind = mapKind(symbol.kind, symbol.name, detail || '');
  if (!kind) {
    return undefined;
  }

  const selection =
    'selectionRange' in symbol ? symbol.selectionRange.start : range.start;
  const startLine = selection.line;
  const endLine = range.end.line;
  const signature =
    kind === 'impl' ? undefined : signatureFromDocument(document, startLine);
  const doc = docAbove(document, startLine);
  const name = cleanName(symbol.name, kind);

  return {
    name: parent ? `${parent}::${name}` : name,
    kind,
    start: startLine + 1,
    end: Math.max(startLine + 1, endLine + 1),
    selectionCharacter: selection.character,
    visibility: visibilityFromDocument(document, startLine),
    test: hasTestAttribute(document, startLine),
    signature,
    doc
  };
}

function implTypeName(name: string): string | undefined {
  const body = name
    .replace(/^(?:unsafe\s+)?impl\b/, '')
    .replace(/\{.*$/, '')
    .trim();

  const forMatch = /\bfor\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(body);
  if (forMatch) {
    return forMatch[1];
  }

  const generic = /^(?:<[^>]*>\s*)?([A-Za-z_][A-Za-z0-9_]*)/.exec(body);
  return generic?.[1];
}

function mapKind(
  kind: vscode.SymbolKind,
  name: string,
  detail: string
): OverviewSymbolKind | undefined {
  if (/^impl\b/.test(name.trim()) || /^impl\b/.test(detail.trim())) {
    return 'impl';
  }
  if (/^macro_rules!/.test(name.trim())) {
    return 'macro';
  }

  switch (kind) {
    case vscode.SymbolKind.Struct:
      return 'struct';
    case vscode.SymbolKind.Enum:
      return 'enum';
    case vscode.SymbolKind.Interface:
      return 'trait';
    case vscode.SymbolKind.Function:
    case vscode.SymbolKind.Method:
      return 'fn';
    case vscode.SymbolKind.Constant:
      return 'const';
    case vscode.SymbolKind.Variable:
      return 'static';
    case vscode.SymbolKind.Module:
      return 'mod';
    case vscode.SymbolKind.Class:
      return 'impl';
    case vscode.SymbolKind.TypeParameter:
      return 'type';
    default:
      return undefined;
  }
}

function cleanName(name: string, kind: OverviewSymbolKind): string {
  const value = name.trim();
  if (kind === 'macro') {
    return value.replace(/^macro_rules!\s*/, '');
  }
  return value;
}

function signatureFromDocument(
  document: vscode.TextDocument,
  startLine: number
): string | undefined {
  const parts: string[] = [];

  for (let line = startLine; line < document.lineCount && line - startLine < 10; line += 1) {
    const text = document.lineAt(line).text;
    const cut = signatureCut(text);
    if (cut >= 0) {
      parts.push(text.slice(0, cut).trim());
      break;
    }
    parts.push(text.trim());
  }

  const value = parts.join(' ').replace(/\s+/g, ' ').trim();
  return value ? truncate(value, 220) : undefined;
}

function signatureCut(text: string): number {
  const brace = text.indexOf('{');
  const semicolon = text.indexOf(';');
  if (brace === -1) {
    return semicolon;
  }
  if (semicolon === -1) {
    return brace;
  }
  return Math.min(brace, semicolon);
}

function docAbove(document: vscode.TextDocument, startLine: number): string | undefined {
  let index = startLine - 1;

  while (index >= 0 && document.lineAt(index).text.trim().startsWith('#[')) {
    index -= 1;
  }

  const doc: string[] = [];
  while (index >= 0) {
    const match = /^\s*\/\/\/\s?(.*)$/.exec(document.lineAt(index).text);
    if (!match) {
      break;
    }
    doc.unshift(match[1]);
    index -= 1;
  }

  const value = doc.join(' ').replace(/\s+/g, ' ').trim();
  return value ? truncate(value, 220) : undefined;
}

function visibilityFromDocument(
  document: vscode.TextDocument,
  line: number
): 'public' | 'restricted' | 'private' {
  const text = document.lineAt(line).text.trimStart();
  if (/^pub\s*\(/.test(text)) {
    return 'restricted';
  }
  if (/^pub\b/.test(text)) {
    return 'public';
  }
  return 'private';
}

function hasTestAttribute(document: vscode.TextDocument, line: number): boolean {
  let index = line - 1;
  while (index >= 0) {
    const text = document.lineAt(index).text;
    if (!/^\s*#\[/.test(text)) {
      break;
    }
    if (/#\[(?:tokio::)?test\b/.test(text)) {
      return true;
    }
    index -= 1;
  }
  return false;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;
}
