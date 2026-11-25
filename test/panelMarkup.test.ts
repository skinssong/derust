import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import test from 'node:test';

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'media', 'architecture.html'),
  'utf8'
);

test('the flow message repaints the opening line', () => {
  const start = html.indexOf("message.type === 'flow'");
  const end = html.indexOf("message.type === 'flowError'");
  assert.ok(start !== -1 && end > start);
  const handler = html.slice(start, end);
  assert.match(handler, /renderLede\(\)/);
  assert.match(handler, /flowDrawing = false/);
});

test('the page has no cytoscape placeholder and renders its drawing state', () => {
  assert.ok(html.includes('__AUTODRAW__'));
  assert.ok(!html.includes('__CYTOSCAPE__'));
});

test('both views expose the project and file switch', () => {
  const panelJs = fs.readFileSync(
    path.join(__dirname, '..', '..', 'media', 'panel.js'),
    'utf8'
  );
  assert.match(html, /type: 'switchView', view: 'file'/);
  assert.match(panelJs, /type: 'switchView', view: 'project'/);
  assert.match(html, /<nav class="views"/);
  assert.ok(html.includes('__FILEAVAILABLE__'));
  const panelTs = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'panel.ts'),
    'utf8'
  );
  assert.match(panelTs, /<nav class="views"/);
  assert.ok(!panelJs.includes("'Import .env'"));
  assert.ok(!panelJs.includes("type: 'importEnv'"));
});
