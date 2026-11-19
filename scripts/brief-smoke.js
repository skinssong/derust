const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  BRIEF_SYSTEM_PROMPT,
  buildBriefUserPrompt,
  parseBriefJson,
  validateBrief
} = require('../out/src/brief');
const { buildStructuralOverview } = require('../out/src/overview');
const { completeJson } = require('../out/src/provider');

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

async function main() {
  const root = path.resolve(__dirname, '..');
  const env = parseEnv(path.join(root, '..', 'harness', '.env'));
  const target = process.argv[2] || 'agent.rs';
  const source = fs.readFileSync(path.join(root, '..', 'harness', 'src', target), 'utf8');
  const docs = [
    fs.readFileSync(path.join(root, '..', 'harness', 'DESIGN.md'), 'utf8'),
    fs.readFileSync(path.join(root, '..', 'harness', 'Cargo.toml'), 'utf8')
  ]
    .join('\n')
    .slice(0, 8000);

  const overview = buildStructuralOverview({
    file: `harness/src/${target}`,
    text: source,
    modulePath: `crate::${path.basename(target, '.rs')}`,
    crateName: 'harness'
  });

  const meta = {
    file: `harness/src/${target}`,
    crateName: 'harness',
    docs,
    model: env.LLM_MODEL || 'deepseek-v4.1-flash',
    sourceHash: crypto.createHash('sha256').update(source).digest('hex'),
    overview
  };

  const settings = {
    baseUrl: env.LLM_BASE_URL,
    model: meta.model,
    apiKey: env.LLM_API_KEY,
    jsonMode: true,
    timeoutMs: 420000,
    maxTokens: 12000,
    reasoningEffort: 'low'
  };

  console.log(`model=${settings.model} base=${settings.baseUrl}`);
  console.log(`source=${target} lines=${overview.lineCount} constructs=${overview.keyConstructs.length} imports=${overview.imports.length}`);
  const started = Date.now();
  const response = await completeJson(
    BRIEF_SYSTEM_PROMPT,
    buildBriefUserPrompt(source, meta),
    settings
  );
  const elapsed = ((Date.now() - started) / 1000).toFixed(0);
  const stem = path.basename(target, '.rs');
  fs.writeFileSync(path.join(root, 'out', `brief-${stem}.raw.txt`), response.text, 'utf8');

  const raw = parseBriefJson(response.text);
  const { brief, issues } = validateBrief(raw, source, meta);
  fs.writeFileSync(
    path.join(root, 'out', `brief-${stem}.json`),
    JSON.stringify({ brief, issues }, null, 2),
    'utf8'
  );

  console.log(`elapsed=${elapsed}s usage=${JSON.stringify(response.usage)} issues=${issues.length}`);
  console.log(`\nROLE\n${brief.role}`);
  console.log(`\nPURPOSE\n${brief.purpose}`);
  if (brief.boundaries) {
    console.log(`\nBOUNDARIES\n${brief.boundaries}`);
  }
  console.log('\nOPERATIONS');
  for (const operation of brief.operations || []) {
    console.log(
      `L${operation.start}-${operation.end} ${operation.name} [${operation.entry}]: ${operation.purpose}`
    );
  }
  if (brief.rules && brief.rules.length > 0) {
    console.log('\nRULES');
    for (const rule of brief.rules) {
      console.log(`L${rule.start}-${rule.end} ${rule.title}: ${rule.text}`);
    }
  }
  console.log('\nFUNCTIONS');
  for (const fn of brief.functions) {
    console.log(`\n${fn.name} L${fn.start}-${fn.end}: ${fn.summary}`);
    if (fn.why) console.log(`  why: ${fn.why}`);
    for (const step of fn.steps) {
      console.log(`  L${step.start}-${step.end} ${step.text}`);
    }
    if (fn.inputs) console.log(`  inputs: ${fn.inputs}`);
    if (fn.returns) console.log(`  returns: ${fn.returns}`);
    if (fn.errors) console.log(`  errors: ${fn.errors}`);
    if (fn.sideEffects) console.log(`  effects: ${fn.sideEffects}`);
  }
  if (issues.length) {
    console.log('\nISSUES');
    for (const issue of issues) {
      console.log(`- ${issue}`);
    }
  }
}

main().catch((error) => {
  console.error('BRIEF SMOKE FAILED:', error.message);
  process.exit(1);
});
