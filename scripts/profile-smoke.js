const fs = require('fs');
const path = require('path');
const { completeJson } = require('../out/src/provider');
const {
  PROFILE_SYSTEM_PROMPT,
  buildProfileCandidates,
  buildProfileUserPrompt,
  formatModuleProfile,
  parseProfileJson,
  validateProfile
} = require('../out/src/profile');

function parseEnv(filePath) {
  const result = {};
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) {
      continue;
    }
    const index = line.indexOf('=');
    result[line.slice(0, index).trim()] = line
      .slice(index + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
  }
  return result;
}

function relationFromCall(call, direction) {
  if (direction === 'incoming') {
    return {
      name: call.name,
      detail: call.detail,
      file: call.file,
      line: call.line,
      character: call.character,
      source: call.name,
      target: call.target
    };
  }
  return {
    name: call.name,
    detail: call.detail,
    file: call.file,
    line: call.line,
    character: call.character,
    source: call.source,
    target: call.name
  };
}

function overviewKind(kind) {
  const map = {
    function: 'fn',
    method: 'fn',
    struct: 'struct',
    enum: 'enum',
    interface: 'trait',
    constant: 'const',
    variable: 'static',
    module: 'mod',
    'type-parameter': 'type',
    macro: 'macro',
    class: 'impl'
  };
  return map[kind] || kind;
}

function contextFromIndex(index, file, source) {
  const module = index.modules.find((candidate) => candidate.path === file);
  if (!module) {
    throw new Error(`module ${file} is not in the index`);
  }

  const calls = index.calls || [];
  const callers = calls
    .filter((call) => call.direction === 'incoming' && call.targetFile === file)
    .map((call) => relationFromCall(call, 'incoming'));
  const callees = calls
    .filter((call) => call.direction === 'outgoing' && call.sourceFile === file)
    .map((call) => relationFromCall(call, 'outgoing'));
  const tests = callers.filter((call) => call.file.startsWith('tests/'));
  const packageInfo = index.metadata?.packages?.[0];

  return {
    file,
    modulePath: module.modulePath,
    crateName: packageInfo?.name,
    moduleDoc: module.moduleDoc,
    publicSurface: (module.symbols || [])
      .map((symbol) => ({ ...symbol, kind: overviewKind(symbol.kind) }))
      .filter(
        (symbol) =>
          symbol.visibility !== 'private' &&
          symbol.kind !== 'impl' &&
          symbol.kind !== 'mod' &&
          symbol.kind !== 'field'
      ),
    imports: source
      .split(/\r?\n/)
      .filter((line) => /^\s*use\s+/.test(line))
      .map((line) => line.trim()),
    callers,
    callees,
    tests,
    dependencies: Array.from(new Set(packageInfo?.dependencies || [])),
    revision: index.revision
  };
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const target = process.argv[2] || 'agent.rs';
  const stem = path.basename(target, '.rs');
  const file = `src/${target}`;
  const source = fs.readFileSync(path.join(root, '..', 'harness', file), 'utf8');
  const index = JSON.parse(
    fs.readFileSync(path.join(root, 'out', 'index-harness.json'), 'utf8')
  );
  const context = contextFromIndex(index, file, source);
  const candidates = buildProfileCandidates(context, source);
  const env = parseEnv(path.join(root, '..', 'harness', '.env'));

  const settings = {
    baseUrl: env.LLM_BASE_URL,
    model: env.LLM_MODEL || 'deepseek-v4.1-flash',
    apiKey: env.LLM_API_KEY,
    jsonMode: true,
    timeoutMs: 420000,
    maxTokens: 12000,
    reasoningEffort: 'low'
  };

  console.log(`model=${settings.model}`);
  console.log(
    `candidates: public=${candidates.publicSurface.length} delegates=${candidates.delegates.length} ` +
      `callGroups=${candidates.callGroups.length} keyFunctions=${candidates.keyFunctions.length}`
  );

  const started = Date.now();
  const response = await completeJson(
    PROFILE_SYSTEM_PROMPT,
    buildProfileUserPrompt(source, candidates),
    settings
  );
  const elapsed = ((Date.now() - started) / 1000).toFixed(0);
  fs.writeFileSync(path.join(root, 'out', `profile-${stem}.raw.txt`), response.text, 'utf8');

  const raw = parseProfileJson(response.text);
  const { profile, issues } = validateProfile(raw, source, candidates, {
    revision: context.revision
  });
  fs.writeFileSync(
    path.join(root, 'out', `profile-${stem}.json`),
    JSON.stringify({ profile, issues }, null, 2),
    'utf8'
  );
  const markdown = formatModuleProfile(profile);
  fs.writeFileSync(path.join(root, 'out', `profile-${stem}.md`), markdown, 'utf8');

  console.log(`elapsed=${elapsed}s usage=${JSON.stringify(response.usage)} issues=${issues.length}`);
  console.log(`\n${markdown}`);
  if (issues.length > 0) {
    console.log('ISSUES');
    for (const issue of issues) {
      console.log(`- ${issue}`);
    }
  }
}

main().catch((error) => {
  console.error('PROFILE SMOKE FAILED:', error.message);
  process.exit(1);
});
