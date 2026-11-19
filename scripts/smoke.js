const fs = require('fs');
const path = require('path');
const { SYSTEM_PROMPT, buildUserPrompt, parseAnalysisJson, validateAnalysis } = require('../out/src/analyzer');
const { completeJson } = require('../out/src/provider');

function parseEnv(filePath) {
  const result = {};
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) {
      continue;
    }
    const index = line.indexOf('=');
    result[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return result;
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const env = parseEnv(path.join(root, '..', 'harness', '.env'));
  const target = process.argv[2] || 'reply.rs';
  const source = fs.readFileSync(path.join(root, '..', 'harness', 'src', target), 'utf8');
  const docs = [
    fs.readFileSync(path.join(root, '..', 'harness', 'DESIGN.md'), 'utf8'),
    fs.readFileSync(path.join(root, '..', 'harness', 'Cargo.toml'), 'utf8')
  ].join('\n').slice(0, 8000);

  const meta = {
    file: `harness/src/${target}`,
    crateName: 'harness',
    docs,
    model: env.LLM_MODEL || 'deepseek-v4.1-flash'
  };

  const settings = {
    baseUrl: env.LLM_BASE_URL,
    model: meta.model,
    apiKey: env.LLM_API_KEY,
    jsonMode: true,
    timeoutMs: 300000,
    maxTokens: 32768,
    reasoningEffort: 'low'
  };

  console.log(`model=${settings.model} base=${settings.baseUrl}`);
  const started = Date.now();
  const response = await completeJson(SYSTEM_PROMPT, buildUserPrompt(source, meta), settings);
  const elapsed = ((Date.now() - started) / 1000).toFixed(0);
  const stem = path.basename(target, '.rs');
  fs.writeFileSync(path.join(root, 'out', `smoke-${stem}.raw.txt`), response.text, 'utf8');

  const raw = parseAnalysisJson(response.text);
  const { analysis, issues } = validateAnalysis(raw, source, meta);
  fs.writeFileSync(path.join(root, 'out', `smoke-${stem}.json`), JSON.stringify({ analysis, issues }, null, 2), 'utf8');

  console.log(`elapsed=${elapsed}s usage=${JSON.stringify(response.usage)}`);
  console.log(`types=${analysis.typeInventory.length} spotlights=${analysis.spotlights.length} ownership=${analysis.ownership.length} memory=${analysis.memory.length}`);
  for (const record of analysis.memory) console.log(`  memory ${record.function} ${record.start}-${record.end}: ${record.values.length} values, ${record.heap.length} heap, ${record.events.length} events`);
  console.log(`issues=${issues.length}`);
  if (issues.length) {
    console.log(issues.slice(0, 6).join('\n'));
  }
  for (const spotlight of analysis.spotlights.slice(0, 8)) {
    console.log(`L${spotlight.start}-${spotlight.end} ${spotlight.code}`);
  }
}

main().catch((error) => {
  console.error('SMOKE FAILED:', error.message);
  process.exit(1);
});
