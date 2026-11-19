#!/usr/bin/env node
/**
 * Spike: build a structural Rust index with rust-analyzer LSP.
 *
 * This is intentionally a standalone script, not extension code. It answers:
 * can we get modules, symbols, callers/callees, public surface, tests and docs
 * cheaply enough to feed a per-file context packet?
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');

const RAW_ARGS = process.argv.slice(2);
const FORCE = RAW_ARGS.includes('--force');
const ARGS = RAW_ARGS.filter((arg) => arg !== '--force');
const WORKSPACE = path.resolve(ARGS[0] || path.join(__dirname, '..', '..', 'harness'));
const TARGET_FILE = ARGS[1] || 'src/agent.rs';
const OUT_DIR = process.env.INDEX_OUT_DIR
  ? path.resolve(process.env.INDEX_OUT_DIR)
  : path.resolve(__dirname, '..', 'out');
const INDEX_PATH = path.join(OUT_DIR, 'index-harness.json');
const PACKET_PATH = path.join(OUT_DIR, 'index-agent-packet.md');
const CACHE_VERSION = 1;
const WORKSPACE_HASH = crypto
  .createHash('sha256')
  .update(WORKSPACE)
  .digest('hex')
  .slice(0, 16);
const CACHE_PATH = path.join(OUT_DIR, 'index-cache', `${WORKSPACE_HASH}.json`);

const SYMBOL_KINDS = {
  1: 'file', 2: 'module', 3: 'namespace', 4: 'package', 5: 'class',
  6: 'method', 7: 'property', 8: 'field', 9: 'constructor', 10: 'enum',
  11: 'interface', 12: 'function', 13: 'variable', 14: 'constant', 15: 'string',
  16: 'number', 17: 'boolean', 18: 'array', 19: 'object', 20: 'key',
  21: 'null', 22: 'enum-member', 23: 'struct', 24: 'event', 25: 'operator',
  26: 'type-parameter'
};

function findRustAnalyzer() {
  if (process.env.RUST_ANALYZER_BIN) {
    return process.env.RUST_ANALYZER_BIN;
  }

  const roots = [
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.vscode-insiders', 'extensions')
  ];
  const candidates = [];

  for (const root of roots) {
    if (!fs.existsSync(root)) {
      continue;
    }
    for (const entry of fs.readdirSync(root)) {
      if (!entry.startsWith('rust-lang.rust-analyzer-')) {
        continue;
      }
      const binary = path.join(root, entry, 'server', 'rust-analyzer');
      if (fs.existsSync(binary)) {
        candidates.push(binary);
      }
    }
  }

  candidates.sort().reverse();
  return candidates[0];
}

function walkRustFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'target' || entry.name === '.git' || entry.name === 'node_modules') {
      continue;
    }
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkRustFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.rs')) {
      files.push(full);
    }
  }
  return files.sort();
}

function modulePathFor(workspace, file) {
  const relative = path.relative(workspace, file).split(path.sep).join('/');
  let cleaned = relative.replace(/\.rs$/, '');
  if (cleaned === 'src/lib' || cleaned === 'src/main') {
    return 'crate';
  }
  if (cleaned.startsWith('src/')) {
    cleaned = cleaned.slice(4);
  }
  cleaned = cleaned.replace(/\/mod$/, '');
  return cleaned ? `crate::${cleaned.split('/').join('::')}` : 'crate';
}

function lineText(lines, line, column, length = 160) {
  const value = lines[line] || '';
  return value.slice(column, column + length).trim();
}

function signatureAt(lines, startLine) {
  const parts = [];
  for (let line = startLine; line < lines.length && line - startLine < 8; line += 1) {
    const text = lines[line];
    const cut = text.search(/[;{]/);
    if (cut >= 0) {
      parts.push(text.slice(0, cut).trim());
      break;
    }
    parts.push(text.trim());
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function docAbove(lines, startLine) {
  let index = startLine - 1;
  while (index >= 0 && /^\s*#\[/.test(lines[index])) {
    index -= 1;
  }
  const doc = [];
  while (index >= 0) {
    const match = /^\s*\/\/\/\s?(.*)$/.exec(lines[index]);
    if (!match) {
      break;
    }
    doc.unshift(match[1]);
    index -= 1;
  }
  return doc.join(' ').replace(/\s+/g, ' ').trim();
}

function moduleDoc(lines) {
  const doc = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('//!')) {
      doc.push(line.slice(3).replace(/^\s?/, ''));
      continue;
    }
    if (doc.length > 0 && line === '') {
      doc.push('');
      continue;
    }
    if (doc.length > 0 || line.startsWith('#![') || line === '') {
      if (doc.length > 0) {
        break;
      }
      continue;
    }
    break;
  }
  return doc.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function visibilityAt(lines, line, column) {
  const text = lineText(lines, line, column, 80);
  if (/^pub\s*\(/.test(text)) {
    return 'restricted';
  }
  if (/^pub\b/.test(text)) {
    return 'public';
  }
  return 'private';
}

function isTest(lines, startLine) {
  let index = startLine - 1;
  while (index >= 0 && /^\s*#\[/.test(lines[index])) {
    if (/#\[(?:tokio::)?test\b/.test(lines[index])) {
      return true;
    }
    index -= 1;
  }
  return false;
}

function symbolName(symbol) {
  return String(symbol.name || '').trim();
}

function normalizeSymbol(symbol, lines, parentName) {
  const kind = SYMBOL_KINDS[symbol.kind] || `kind-${symbol.kind}`;
  const start = symbol.selectionRange.start;
  const end = symbol.range.end;
  const name = symbolName(symbol);
  const qualified = parentName && /^(?:impl|struct|enum|trait|class)\b/.test(parentName)
    ? `${cleanImplName(parentName)}::${name}`
    : name;

  return {
    name: qualified,
    rawName: name,
    kind,
    start: start.line + 1,
    end: Math.max(start.line + 1, end.line + 1),
    selection: {
      line: start.line + 1,
      character: start.character
    },
    visibility: visibilityAt(lines, start.line, 0),
    signature: kind === 'class'
      ? undefined
      : kind === 'field'
        ? lineText(lines, start.line, 0, 160)
        : signatureAt(lines, start.line),
    doc: docAbove(lines, start.line),
    test: isTest(lines, start.line)
  };
}

function cleanImplName(name) {
  return String(name)
    .replace(/^impl\s+/, '')
    .replace(/^<[^>]*>\s*/, '')
    .replace(/\s+for\s+.*$/, '')
    .replace(/\s*\{.*$/, '')
    .trim();
}

function flattenSymbols(symbols, lines, parentName, result) {
  for (const symbol of symbols || []) {
    const normalized = normalizeSymbol(symbol, lines, parentName);
    result.push(normalized);

    const kind = SYMBOL_KINDS[symbol.kind] || '';
    if (Array.isArray(symbol.children) && symbol.children.length > 0) {
      const parent =
        kind === 'class' || /^impl\b/.test(symbolName(symbol))
          ? symbolName(symbol)
          : normalized.name;
      flattenSymbols(symbol.children, lines, parent, result);
    }
  }
  return result;
}

class LSPClient {
  constructor(binary, cwd) {
    this.binary = binary;
    this.cwd = cwd;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.stderr = '';
    this.child = spawn(binary, [], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        RUST_BACKTRACE: '0',
        RUST_ANALYZER_INTERNALS_DO_NOT_USE: '0'
      }
    });

    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString('utf8');
    });
    this.child.on('exit', (code) => {
      for (const [, pending] of this.pending) {
        pending.reject(new Error(`rust-analyzer exited (${code})\n${this.stderr.slice(-2000)}`));
      }
      this.pending.clear();
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        return;
      }
      const header = this.buffer.slice(0, headerEnd).toString('ascii');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) {
        return;
      }
      const body = this.buffer.slice(start, start + length).toString('utf8');
      this.buffer = this.buffer.slice(start + length);
      try {
        this.onMessage(JSON.parse(body));
      } catch (error) {
        // Ignore malformed server messages in the spike.
      }
    }
  }

  onMessage(message) {
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      // Server request: answer enough for rust-analyzer to proceed.
      if (message.method === 'workspace/configuration') {
        const items = message.params?.items || [];
        this.send({ jsonrpc: '2.0', id: message.id, result: items.map(() => null) });
        return;
      }
      if (message.method === 'workspace/workspaceFolders') {
        this.send({
          jsonrpc: '2.0',
          id: message.id,
          result: [{ uri: pathToFileURL(this.cwd).toString(), name: path.basename(this.cwd) }]
        });
        return;
      }
      this.send({ jsonrpc: '2.0', id: message.id, result: null });
    }
  }

  send(message) {
    const body = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`;
    this.child.stdin.write(header + body);
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  request(method, params, timeoutMs = 120000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  async stop() {
    try {
      await this.request('shutdown', null, 5000);
      this.notify('exit', null);
    } catch {
      // The server may already be gone.
    }
    setTimeout(() => this.child.kill('SIGTERM'), 1000).unref();
  }
}

async function cargoMetadata(workspace) {
  return new Promise((resolve) => {
    const child = spawn('cargo', ['metadata', '--format-version', '1', '--no-deps'], {
      cwd: workspace,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')));
    child.on('exit', (code) => {
      if (code !== 0) {
        resolve({ error: stderr.trim() });
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        resolve({ error: error.message });
      }
    });
  });
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function computeHashes(documents) {
  const hashes = {};
  for (const [file, text] of documents) {
    hashes[path.relative(WORKSPACE, file).split(path.sep).join('/')] = sha256(text);
  }
  return hashes;
}

function revisionFor(hashes) {
  return sha256(
    Object.entries(hashes)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([file, hash]) => `${file}:${hash}`)
      .join('\n')
  );
}

function loadCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (
      !parsed ||
      parsed.version !== CACHE_VERSION ||
      parsed.workspace !== WORKSPACE ||
      !Array.isArray(parsed.modules)
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function saveCache(index) {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  const temporary = `${CACHE_PATH}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(index), 'utf8');
  fs.renameSync(temporary, CACHE_PATH);
}

function uriToPath(uri) {
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

function referenceToRecord(reference, workspace, symbol) {
  const file = uriToPath(reference.uri);
  if (!file || !file.startsWith(workspace) || !file.endsWith('.rs')) {
    return undefined;
  }
  return {
    symbol: symbol.name,
    file: path.relative(workspace, file).split(path.sep).join('/'),
    line: reference.range.start.line + 1,
    character: reference.range.start.character + 1
  };
}

function callItemToRecord(item, workspace) {
  const file = uriToPath(item.uri);
  if (!file || !file.startsWith(workspace) || !file.endsWith('.rs')) {
    return undefined;
  }
  return {
    name: item.name,
    detail: item.detail || '',
    file: path.relative(workspace, file).split(path.sep).join('/'),
    line: item.selectionRange.start.line + 1,
    character: item.selectionRange.start.character + 1
  };
}

async function main() {
  if (!fs.existsSync(WORKSPACE)) {
    throw new Error(`workspace not found: ${WORKSPACE}`);
  }

  const started = Date.now();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const files = walkRustFiles(WORKSPACE);
  const documents = new Map();
  for (const file of files) {
    documents.set(file, fs.readFileSync(file, 'utf8'));
  }
  const fileHashes = computeHashes(documents);
  const revision = revisionFor(fileHashes);

  console.log(`workspace: ${WORKSPACE}`);
  console.log(`files: ${files.length}`);
  console.log(`revision: ${revision.slice(0, 16)}`);

  const cached = loadCache();
  if (!FORCE && cached && cached.revision === revision) {
    console.log(`cache hit: ${CACHE_PATH}`);
    writePacket(cached, TARGET_FILE, PACKET_PATH);
    console.log(indexStats(cached));
    return;
  }

  const previous = FORCE ? undefined : cached;
  const binary = findRustAnalyzer();
  if (!binary) {
    throw new Error('rust-analyzer not found; set RUST_ANALYZER_BIN or install the VS Code Rust extension.');
  }

  console.log(`rust-analyzer: ${binary}`);
  const metadata = await cargoMetadata(WORKSPACE);

  const client = new LSPClient(binary, WORKSPACE);
  const rootUri = pathToFileURL(WORKSPACE).toString();
  const init = await client.request('initialize', {
    processId: process.pid,
    rootUri,
    rootPath: WORKSPACE,
    workspaceFolders: [{ uri: rootUri, name: path.basename(WORKSPACE) }],
    capabilities: {
      workspace: { workspaceFolders: true, configuration: true },
      textDocument: {
        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        references: { dynamicRegistration: false },
        definition: { dynamicRegistration: false },
        implementation: { dynamicRegistration: false },
        callHierarchy: { dynamicRegistration: false },
        hover: { contentFormat: ['markdown', 'plaintext'] }
      }
    },
    initializationOptions: {}
  }, 180000);
  client.notify('initialized', {});
  console.log(`server: ${init?.serverInfo?.name || 'rust-analyzer'} ${init?.serverInfo?.version || ''}`);

  for (const file of files) {
    client.notify('textDocument/didOpen', {
      textDocument: {
        uri: pathToFileURL(file).toString(),
        languageId: 'rust',
        version: 1,
        text: documents.get(file)
      }
    });
  }

  console.log('waiting for semantic analysis...');
  await new Promise((resolve) => setTimeout(resolve, 8000));

  const modules = [];
  const allSymbols = [];
  const references = [];
  const calls = [];
  const previousModules = new Map((previous?.modules || []).map((module) => [module.path, module]));

  for (const file of files) {
    const relative = path.relative(WORKSPACE, file).split(path.sep).join('/');
    const previousModule = previousModules.get(relative);
    if (
      !FORCE &&
      previousModule &&
      previous?.fileHashes?.[relative] === fileHashes[relative]
    ) {
      modules.push(previousModule);
      allSymbols.push(...previousModule.symbols);
      console.log(`cached ${relative}: ${previousModule.symbols.length} symbols`);
      continue;
    }

    const uri = pathToFileURL(file).toString();
    let symbols = [];
    try {
      symbols = await client.request(
        'textDocument/documentSymbol',
        { textDocument: { uri } },
        180000
      );
    } catch (error) {
      console.warn(`documentSymbol ${path.relative(WORKSPACE, file)}: ${error.message}`);
    }

    const lines = documents.get(file).split(/\r?\n/);
    const flattened = flattenSymbols(symbols, lines, undefined, []).map((symbol) => ({
      ...symbol,
      file: path.relative(WORKSPACE, file).split(path.sep).join('/'),
      modulePath: modulePathFor(WORKSPACE, file)
    }));
    const module = {
      path: path.relative(WORKSPACE, file).split(path.sep).join('/'),
      modulePath: modulePathFor(WORKSPACE, file),
      moduleDoc: moduleDoc(lines),
      symbols: flattened,
      tests: flattened.filter((symbol) => symbol.test).map((symbol) => symbol.name)
    };
    modules.push(module);
    allSymbols.push(...flattened);
    console.log(`indexed ${module.path}: ${flattened.length} symbols, ${module.tests.length} tests`);
  }

  // References for public symbols, and call hierarchy for public functions.
  const candidates = allSymbols.filter(
    (symbol) =>
      symbol.visibility !== 'private' &&
      (symbol.kind === 'function' || symbol.kind === 'method' || symbol.kind === 'struct' ||
        symbol.kind === 'enum' || symbol.kind === 'class')
  );
  const functionCandidates = candidates.filter(
    (symbol) => symbol.kind === 'function' || symbol.kind === 'method'
  );
  console.log(`references/calls for ${candidates.length} public symbols`);

  for (const symbol of candidates) {
    const uri = pathToFileURL(path.join(WORKSPACE, symbol.file)).toString();
    try {
      const refs = await client.request(
        'textDocument/references',
        {
          textDocument: { uri },
          position: {
            line: symbol.selection.line - 1,
            character: symbol.selection.character
          },
          context: { includeDeclaration: false }
        },
        60000
      );
      for (const ref of refs || []) {
        const record = referenceToRecord(ref, WORKSPACE, symbol);
        if (record) {
          references.push(record);
        }
      }
    } catch (error) {
      console.warn(`references ${symbol.name}: ${error.message}`);
    }
  }

  for (const symbol of functionCandidates.slice(0, 30)) {
    const uri = pathToFileURL(path.join(WORKSPACE, symbol.file)).toString();
    try {
      const prepared = await client.request(
        'textDocument/prepareCallHierarchy',
        {
          textDocument: { uri },
          position: {
            line: symbol.selection.line - 1,
            character: symbol.selection.character
          }
        },
        60000
      );
      const item = (prepared || [])[0];
      if (!item) {
        continue;
      }

      const incoming = await client.request(
        'callHierarchy/incomingCalls',
        { item },
        60000
      );
      for (const call of incoming || []) {
        const from = callItemToRecord(call.from, WORKSPACE);
        if (from) {
          calls.push({
            direction: 'incoming',
            target: symbol.name,
            targetFile: symbol.file,
            targetLine: symbol.start,
            ...from
          });
        }
      }

      const outgoing = await client.request(
        'callHierarchy/outgoingCalls',
        { item },
        60000
      );
      for (const call of outgoing || []) {
        const to = callItemToRecord(call.to, WORKSPACE);
        if (to) {
          calls.push({
            direction: 'outgoing',
            source: symbol.name,
            sourceFile: symbol.file,
            sourceLine: symbol.start,
            ...to
          });
        }
      }
    } catch (error) {
      console.warn(`call hierarchy ${symbol.name}: ${error.message}`);
    }
  }

  await client.stop();

  const index = {
    version: CACHE_VERSION,
    revision,
    fileHashes,
    generatedAt: new Date().toISOString(),
    elapsedSeconds: ((Date.now() - started) / 1000).toFixed(1),
    workspace: WORKSPACE,
    rustAnalyzer: binary,
    metadata: metadata && metadata.error ? { error: metadata.error } : {
      packages: (metadata.packages || []).map((pkg) => ({
        name: pkg.name,
        version: pkg.version,
        id: pkg.id,
        targets: pkg.targets.map((target) => ({
          name: target.name,
          kind: target.kind,
          srcPath: target.src_path
        })),
        dependencies: pkg.dependencies.map((dep) => dep.name)
      }))
    },
    modules,
    references,
    calls
  };

  saveCache(index);
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), 'utf8');
  const packet = writePacket(index, TARGET_FILE, PACKET_PATH);

  console.log(`wrote ${INDEX_PATH}`);
  console.log(`wrote ${PACKET_PATH}`);
  console.log(`cache: ${CACHE_PATH}`);
  console.log(indexStats(index));
  console.log(`elapsed: ${index.elapsedSeconds}s`);
  console.log(`\n${packet}`);
}

function indexStats(index) {
  const symbols = (index.modules || []).reduce(
    (count, module) => count + (module.symbols?.length || 0),
    0
  );
  return [
    `stats: modules=${(index.modules || []).length} symbols=${symbols} references=${(index.references || []).length} calls=${(index.calls || []).length}`,
    `revision: ${String(index.revision || '').slice(0, 16)}`
  ].join('\n');
}

function writePacket(index, targetFile, outputPath) {
  const target = (index.modules || []).find((module) => module.path === targetFile);
  const targetSymbols = target ? target.symbols : [];
  const targetNames = new Set(targetSymbols.map((symbol) => symbol.name));
  const targetSource = fs.readFileSync(path.join(index.workspace, targetFile), 'utf8');
  const targetLines = targetSource.split(/\r?\n/);
  const imports = targetLines
    .filter((line) => /^\s*use\s+/.test(line))
    .map((line) => line.trim());
  const calls = index.calls || [];
  const references = index.references || [];
  const callsOut = calls
    .filter((call) => call.direction === 'outgoing' && call.sourceFile === targetFile)
    .map((call) => `${call.source} → ${call.name} (${call.file}:${call.line})`);
  const callsIn = calls
    .filter(
      (call) =>
        call.direction === 'incoming' &&
        call.targetFile === targetFile &&
        !(call.name === call.target && call.file === call.targetFile && call.line === call.targetLine)
    )
    .map((call) => `${call.name} → ${call.target} (${call.file}:${call.line})`);
  const testsTouching = calls
    .filter(
      (call) =>
        call.direction === 'incoming' &&
        call.targetFile === targetFile &&
        call.file.startsWith('tests/')
    )
    .map((call) => `${call.name} → ${call.target} (${call.file}:${call.line})`);
  const targetReferences = references
    .filter((reference) => targetNames.has(reference.symbol))
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
  const packageInfo = index.metadata?.packages?.[0];
  const packet = [
    `# Index packet: ${targetFile}`,
    '',
    `Crate: ${packageInfo ? `${packageInfo.name} ${packageInfo.version}` : 'unknown'}`,
    `Module: ${target?.modulePath || 'unknown'}`,
    '',
    '## Module docs',
    '',
    target?.moduleDoc || '(none)',
    '',
    '## Public surface',
    '',
    ...targetSymbols
      .filter((symbol) => symbol.visibility !== 'private' && symbol.kind !== 'field')
      .map((symbol) => `- ${symbol.kind} ${symbol.name} L${symbol.start}-${symbol.end} — ${symbol.signature || ''}`),
    '',
    '## Imports',
    '',
    ...imports.map((item) => `- ${item}`),
    '',
    '## Calls out',
    '',
    ...dedupe(callsOut).map((call) => `- ${call}`),
    '',
    '## Calls in',
    '',
    ...dedupe(callsIn).map((call) => `- ${call}`),
    '',
    '## Tests touching this file',
    '',
    ...dedupe(testsTouching).map((test) => `- ${test}`),
    '',
    '## References to public symbols',
    '',
    ...dedupe(targetReferences.map((ref) => `${ref.symbol} → ${ref.file}:${ref.line}`))
      .slice(0, 40)
      .map((ref) => `- ${ref}`),
    '',
    '## Crate dependencies',
    '',
    ...dedupe(packageInfo?.dependencies || []).map((dependency) => `- ${dependency}`),
    '',
    '## Index stats',
    '',
    `- modules: ${(index.modules || []).length}`,
    `- symbols: ${targetSymbols.length} in this file; ${(index.modules || []).reduce((count, module) => count + (module.symbols?.length || 0), 0)} total`,
    `- references: ${(index.references || []).length}`,
    `- calls: ${(index.calls || []).length}`,
    `- revision: ${String(index.revision || '').slice(0, 16)}`,
    `- metadata: ${index.metadata?.error ? `error: ${index.metadata.error}` : 'ok'}`,
    ''
  ].join('\n');

  fs.writeFileSync(outputPath, packet, 'utf8');
  return packet;
}

function dedupe(values) {
  return Array.from(new Set(values));
}

main().catch((error) => {
  console.error('INDEX SPIKE FAILED:', error.message);
  process.exit(1);
});
