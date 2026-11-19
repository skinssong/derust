import {
  OverviewImport,
  OverviewSymbol,
  OverviewSymbolKind,
  StructuralOverview
} from './contract';

export type OverviewInput = {
  file: string;
  text: string;
  modulePath?: string;
  crateName?: string;
  symbols?: OverviewSymbol[];
};

/**
 * Build the deterministic half of the file overview. This function is pure so
 * it can be tested without a VS Code host; the caller supplies document symbols
 * when the language server is available.
 */
export function buildStructuralOverview(input: OverviewInput): StructuralOverview {
  const text = input.text ?? '';
  const lineCount = text.length === 0 ? 0 : text.split(/\r?\n/).length;
  const moduleDoc = parseModuleDoc(text);
  let symbols = normalizeSymbols(
    input.symbols && input.symbols.length > 0 ? input.symbols : parseAllSymbols(text)
  );
  let topLevel = symbols.filter((symbol) => !symbol.name.includes('::'));
  let keyConstructs = topLevel
    .filter((symbol) => symbol.kind !== 'impl' && symbol.kind !== 'mod')
    .slice(0, 12);

  if (keyConstructs.length === 0 && input.symbols && input.symbols.length > 0) {
    const fallback = normalizeSymbols(parseAllSymbols(text));
    if (fallback.length > 0) {
      symbols = fallback;
      topLevel = fallback.filter((symbol) => !symbol.name.includes('::'));
      keyConstructs = topLevel
        .filter((symbol) => symbol.kind !== 'impl' && symbol.kind !== 'mod')
        .slice(0, 12);
    }
  }

  return {
    file: input.file,
    modulePath: input.modulePath,
    crateName: input.crateName,
    lineCount,
    moduleDoc,
    summary: summarize(moduleDoc, topLevel, input.file),
    symbols,
    keyConstructs,
    functions: symbols.filter((symbol) => symbol.kind === 'fn'),
    imports: parseImports(text, input.crateName)
  };
}

export function parseModuleDoc(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const doc: string[] = [];
  let started = false;

  for (const raw of lines) {
    const line = raw.trim();

    if (line.startsWith('//!')) {
      started = true;
      doc.push(line.slice(3).replace(/^\s?/, ''));
      continue;
    }

    if (!started) {
      if (
        line === '' ||
        line.startsWith('#![') ||
        (line.startsWith('//') && !line.startsWith('//!'))
      ) {
        continue;
      }
      break;
    }

    if (line === '') {
      doc.push('');
      continue;
    }

    break;
  }

  const value = doc.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return value || undefined;
}

export function parseImports(text: string, crateName?: string): OverviewImport[] {
  const lines = text.split(/\r?\n/);
  const seen = new Map<string, OverviewImport>();

  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s/.test(lines[index])) {
      continue;
    }

    const match = /^(?:pub(?:\s*\([^)]*\))?\s+)?use\s+(.*)$/.exec(lines[index].trim());
    if (!match) {
      continue;
    }

    let body = match[1];
    let cursor = index;
    while (!body.trimEnd().endsWith(';') && cursor + 1 < lines.length && cursor - index < 12) {
      cursor += 1;
      body += ` ${lines[cursor].trim()}`;
    }
    index = cursor;
    body = body.replace(/;\s*$/, '').trim();

    for (const parsed of expandUseTree(body, '', crateName)) {
      const key = `${parsed.external ? 'external' : 'local'}:${parsed.path}`;
      const existing = seen.get(key);
      if (existing) {
        existing.symbols = mergeSymbols(existing.symbols, parsed.symbols);
      } else {
        seen.set(key, parsed);
      }
    }
  }

  return Array.from(seen.values()).sort((left, right) => left.path.localeCompare(right.path));
}

export function parseTopLevelSymbols(text: string): OverviewSymbol[] {
  const lines = text.split(/\r?\n/);
  const symbols: OverviewSymbol[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw || /^\s/.test(raw)) {
      continue;
    }

    const declaration = matchDeclaration(raw);
    if (!declaration) {
      continue;
    }

    const structural = findFirstStructural(lines, index);
    const end = structural
      ? structural.character === ';'
        ? structural.line
        : findBlockEnd(lines, structural.line, structural.column)
      : index;
    const signature = signatureFor(lines, index, structural);
    const doc = docFor(lines, index + 1);

    symbols.push({
      name: declaration.name,
      kind: declaration.kind,
      start: index + 1,
      end: Math.max(index + 1, end + 1),
      signature,
      doc
    });
  }

  return normalizeSymbols(symbols);
}

export function summarize(
  moduleDoc: string | undefined,
  symbols: OverviewSymbol[],
  file: string
): string {
  if (moduleDoc) {
    const first = firstSentence(moduleDoc);
    if (first) {
      return truncate(first, 140);
    }
  }

  const types = symbols.filter(
    (symbol) =>
      symbol.kind === 'struct' ||
      symbol.kind === 'enum' ||
      symbol.kind === 'trait' ||
      symbol.kind === 'type'
  ).length;
  const functions = symbols.filter((symbol) => symbol.kind === 'fn').length;
  const modules = symbols.filter((symbol) => symbol.kind === 'mod').length;
  const bits: string[] = [];

  if (types > 0) {
    bits.push(`${types} type${types === 1 ? '' : 's'}`);
  }
  if (functions > 0) {
    bits.push(`${functions} function${functions === 1 ? '' : 's'}`);
  }
  if (modules > 0) {
    bits.push(`${modules} module${modules === 1 ? '' : 's'}`);
  }
  if (bits.length === 0 && symbols.length > 0) {
    bits.push(`${symbols.length} item${symbols.length === 1 ? '' : 's'}`);
  }

  const base = file.split(/[\\/]/).pop() || file;
  return bits.length > 0 ? `${base}: ${bits.join(', ')}` : `${base}: no top-level items`;
}

export function firstSentence(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  const match = /^(.+?[.!?])(?:\s|$)/.exec(normalized);
  return match ? match[1] : normalized;
}

function matchDeclaration(
  raw: string
): { kind: OverviewSymbolKind; name: string } | undefined {
  const line = raw.trim();
  if (!line || line.startsWith('//') || line.startsWith('#') || line.startsWith('/*')) {
    return undefined;
  }

  const withoutVisibility = line.replace(/^pub(?:\s*\([^)]*\))?\s+/, '');

  if (/^(?:unsafe\s+)?impl\b/.test(withoutVisibility)) {
    return { kind: 'impl', name: line };
  }

  const macro = /^(?:unsafe\s+)?macro_rules!\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(withoutVisibility);
  if (macro) {
    return { kind: 'macro', name: macro[1] };
  }

  const constFn = /^(?:(?:async|unsafe|extern)\s+)*const\s+fn\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(
    withoutVisibility
  );
  if (constFn) {
    return { kind: 'fn', name: constFn[1] };
  }

  const item =
    /^(?:(?:async|unsafe|extern)\s+)*(struct|enum|trait|fn|type|mod|static|const)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(
      withoutVisibility
    );
  if (item) {
    return { kind: item[1] as OverviewSymbolKind, name: item[2] };
  }

  return undefined;
}

type StructuralChar = { line: number; column: number; character: '{' | ';' };

function findFirstStructural(lines: string[], startLine: number): StructuralChar | undefined {
  for (let line = startLine; line < lines.length && line - startLine < 16; line += 1) {
    const scanner = new LineScanner();
    for (let column = 0; column < lines[line].length; column += 1) {
      const character = scanner.feed(lines[line], column);
      if (character === '{' || character === ';') {
        return { line, column, character };
      }
    }
  }
  return undefined;
}

function findBlockEnd(lines: string[], openLine: number, openColumn: number): number {
  let depth = 0;

  for (let line = openLine; line < lines.length; line += 1) {
    const scanner = new LineScanner();
    for (let column = line === openLine ? openColumn : 0; column < lines[line].length; column += 1) {
      const character = scanner.feed(lines[line], column);
      if (character === '{') {
        depth += 1;
      } else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          return line;
        }
      }
    }
  }

  return Math.max(openLine, lines.length - 1);
}

function signatureFor(
  lines: string[],
  startLine: number,
  structural: StructuralChar | undefined
): string | undefined {
  if (!structural) {
    return undefined;
  }

  const parts: string[] = [];
  for (let line = startLine; line <= structural.line; line += 1) {
    const raw = lines[line];
    const text =
      line === structural.line ? raw.slice(0, structural.column) : raw;
    parts.push(text.trim());
  }

  const value = parts.join(' ').replace(/\s+/g, ' ').trim();
  return value ? truncate(value, 220) : undefined;
}

function docFor(lines: string[], startLine: number): string | undefined {
  let index = startLine - 2;

  while (index >= 0 && /^\s*#\[/.test(lines[index])) {
    index -= 1;
  }

  const doc: string[] = [];
  while (index >= 0) {
    const match = /^\s*\/\/\/\s?(.*)$/.exec(lines[index]);
    if (!match) {
      break;
    }
    doc.unshift(match[1]);
    index -= 1;
  }

  const value = doc.join(' ').replace(/\s+/g, ' ').trim();
  return value ? truncate(value, 220) : undefined;
}

export function parseAllSymbols(text: string): OverviewSymbol[] {
  return normalizeSymbols([...parseTopLevelSymbols(text), ...parseMethodSymbols(text)]);
}

export function parseMethodSymbols(text: string): OverviewSymbol[] {
  const lines = text.split(/\r?\n/);
  const methods: OverviewSymbol[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s/.test(lines[index])) {
      continue;
    }

    const declaration = matchDeclaration(lines[index]);
    if (!declaration || declaration.kind !== 'impl') {
      continue;
    }

    const typeName = implTypeName(lines[index]);
    if (!typeName) {
      continue;
    }

    const structural = findFirstStructural(lines, index);
    if (!structural || structural.character !== '{') {
      continue;
    }

    const end = findBlockEnd(lines, structural.line, structural.column);

    for (let inner = index + 1; inner < end; inner += 1) {
      const method = matchDeclaration(lines[inner]);
      if (!method || method.kind !== 'fn') {
        continue;
      }

      const methodStructural = findFirstStructural(lines, inner);
      if (!methodStructural) {
        continue;
      }

      const methodEnd =
        methodStructural.character === ';'
          ? methodStructural.line
          : findBlockEnd(lines, methodStructural.line, methodStructural.column);

      if (methodEnd > end) {
        continue;
      }

      methods.push({
        name: `${typeName}::${method.name}`,
        kind: 'fn',
        start: inner + 1,
        end: Math.max(inner + 1, methodEnd + 1),
        signature: signatureFor(lines, inner, methodStructural),
        doc: docFor(lines, inner + 1)
      });
    }

    index = end;
  }

  return normalizeSymbols(methods);
}

function implTypeName(line: string): string | undefined {
  const body = line
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

function normalizeSymbols(symbols: OverviewSymbol[]): OverviewSymbol[] {
  const seen = new Set<string>();
  const result: OverviewSymbol[] = [];

  for (const symbol of symbols) {
    const name = symbol.name.trim();
    if (!name) {
      continue;
    }

    const start = Math.max(1, Math.floor(symbol.start));
    const end = Math.max(start, Math.floor(symbol.end));
    const key = `${symbol.kind}:${name}:${start}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push({ ...symbol, name, start, end });
  }

  return result.sort((left, right) => left.start - right.start || left.name.localeCompare(right.name));
}

class LineScanner {
  private inBlockComment = false;
  private inLineComment = false;
  private inString = false;
  private inChar = false;
  private escaped = false;

  feed(line: string, column: number): string {
    const character = line[column];
    const next = line[column + 1];

    if (this.inLineComment) {
      return '';
    }

    if (this.inBlockComment) {
      if (character === '*' && next === '/') {
        this.inBlockComment = false;
        return '/';
      }
      return '';
    }

    if (this.inString) {
      if (this.escaped) {
        this.escaped = false;
      } else if (character === '\\') {
        this.escaped = true;
      } else if (character === '"') {
        this.inString = false;
      }
      return '';
    }

    if (this.inChar) {
      if (this.escaped) {
        this.escaped = false;
      } else if (character === '\\') {
        this.escaped = true;
      } else if (character === "'") {
        this.inChar = false;
      }
      return '';
    }

    if (character === '/' && next === '/') {
      this.inLineComment = true;
      return '';
    }
    if (character === '/' && next === '*') {
      this.inBlockComment = true;
      return '';
    }
    if (character === '"') {
      this.inString = true;
      return '';
    }
    if (character === "'") {
      const closing = line.indexOf("'", column + 1);
      if (closing !== -1 && closing - column <= 4) {
        this.inChar = true;
        return '';
      }
      return character;
    }

    return character;
  }
}

function expandUseTree(
  body: string,
  prefix: string,
  crateName: string | undefined
): OverviewImport[] {
  const value = body.trim();
  if (!value) {
    return [];
  }

  const brace = value.indexOf('{');
  if (brace === -1) {
    const cleaned = value.replace(/\s+as\s+.*$/, '').trim();
    const segments = cleaned.split('::');
    const last = segments[segments.length - 1] || '';

    if (segments.length > 1 && /^[A-Z]/.test(last)) {
      const path = joinPath(prefix, segments.slice(0, -1).join('::'));
      return path
        ? [{ path, external: isExternal(path, crateName), symbols: [last] }]
        : [];
    }

    const path = joinPath(prefix, cleaned);
    return path ? [{ path, external: isExternal(path, crateName) }] : [];
  }

  const head = value.slice(0, brace).replace(/::$/, '').trim();
  const close = matchingBrace(value, brace);
  if (close === -1) {
    return [];
  }

  const inner = value.slice(brace + 1, close);
  const base = joinPath(prefix, head);
  const result: OverviewImport[] = [];

  for (const rawPart of splitTopLevel(inner, ',')) {
    const part = rawPart.trim();
    if (!part) {
      continue;
    }

    if (part.includes('{')) {
      result.push(...expandUseTree(part, base, crateName));
      continue;
    }

    if (part === 'self') {
      result.push({ path: base, external: isExternal(base, crateName) });
      continue;
    }

    const alias = part.replace(/\s+as\s+.*$/, '').trim();
    if (!alias) {
      continue;
    }

    if (
      head === '' ||
      head === 'crate' ||
      head === 'self' ||
      head === 'super' ||
      head === 'std' ||
      head === 'core' ||
      head === 'alloc'
    ) {
      const path = joinPath(base, alias);
      if (path) {
        result.push({ path, external: isExternal(path, crateName) });
      }
    } else {
      result.push({ path: base, external: isExternal(base, crateName), symbols: [part] });
    }
  }

  return result;
}

function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth = Math.max(0, depth - 1);
    } else if (character === separator && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }

  parts.push(value.slice(start));
  return parts;
}

function matchingBrace(value: string, open: number): number {
  let depth = 0;

  for (let index = open; index < value.length; index += 1) {
    if (value[index] === '{') {
      depth += 1;
    } else if (value[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function joinPath(prefix: string, suffix: string): string {
  const left = prefix.replace(/^::+/, '').replace(/:+$/, '');
  const right = suffix.replace(/^::+/, '').replace(/:+$/, '');
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return `${left}::${right}`;
}

function isExternal(path: string, crateName: string | undefined): boolean {
  const root = path.split('::')[0];
  if (root === 'crate' || root === 'self' || root === 'super') {
    return false;
  }
  if (crateName && root === crateName) {
    return false;
  }
  return true;
}

function mergeSymbols(
  left: string[] | undefined,
  right: string[] | undefined
): string[] | undefined {
  if (!left && !right) {
    return undefined;
  }

  const values = [...(left || []), ...(right || [])];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result.length > 0 ? result : undefined;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;
}
