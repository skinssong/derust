/* global acquireVsCodeApi */

const vscode = acquireVsCodeApi();
const app = document.getElementById('app');
const SVG_NS = 'http://www.w3.org/2000/svg';
const shellViews = document.getElementById('views');
if (shellViews) {
  shellViews.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-view]');
    if (button && button.dataset.view === 'project') {
      vscode.postMessage({ type: 'switchView', view: 'project' });
    }
  });
}

const state = {
  file: '',
  overview: null,
  analysis: null,
  analysisFile: '',
  brief: null,
  briefStale: false,
  briefLoading: false,
  briefMeta: null,
  layout: 'cards',
  lens: 'overview',
  status: { state: 'empty', message: 'Open a Rust file to see its overview.' },
  meta: null,
  cursorLine: null
};

let ignoreScrollUntil = 0;
let scrollTimer = null;
const SCROLL_PREFIX = 'derust:file-scroll:';
let restoreScrollFor = null;
let scrollSaveTimer = null;

window.addEventListener('scroll', () => {
  if (!state.file || scrollSaveTimer) return;
  scrollSaveTimer = setTimeout(() => {
    scrollSaveTimer = null;
    try {
      localStorage.setItem(SCROLL_PREFIX + state.file, String(window.scrollY));
    } catch {}
  }, 150);
}, { passive: true });

window.addEventListener('pagehide', () => {
  if (!state.file) return;
  try {
    localStorage.setItem(SCROLL_PREFIX + state.file, String(window.scrollY));
  } catch {}
});

function scheduleRestore(file) {
  restoreScrollFor = file;
}

function applyRestore() {
  if (!restoreScrollFor || restoreScrollFor !== state.file) return;
  const file = restoreScrollFor;
  restoreScrollFor = null;
  let y = 0;
  try {
    y = Number(localStorage.getItem(SCROLL_PREFIX + file) || 0);
  } catch {}
  requestAnimationFrame(() => window.scrollTo(0, y || 0));
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || typeof message.type !== 'string') {
    return;
  }

  if (message.type === 'analysis') {
    const previousFile = state.file;
    state.file = message.payload.file;
    state.analysis = message.payload.analysis;
    state.analysisFile = message.payload.file;
    state.overview = message.payload.overview || (previousFile === state.file ? state.overview : null);
    state.layout = message.payload.layout === 'columns' ? 'columns' : 'cards';
    state.meta = message.payload.meta || null;
    if (previousFile !== state.file) {
      state.lens = 'overview';
      clearBriefState();
      scheduleRestore(state.file);
    }
    render();
    resetScroll();
    return;
  }

  if (message.type === 'overview') {
    const previousFile = state.file;
    const fileChanged = previousFile !== message.payload.file;
    state.file = message.payload.file;
    state.overview = message.payload.overview;
    if (fileChanged || state.analysisFile !== state.file) {
      state.analysis = null;
      state.analysisFile = '';
      state.meta = null;
      state.lens = 'overview';
    }
    if (fileChanged) {
      clearBriefState();
      scheduleRestore(state.file);
    }

    if (fileChanged || state.lens === 'overview') {
      const scrollY = window.scrollY;
      render();
      if (fileChanged) {
        resetScroll();
      } else {
        window.scrollTo(0, scrollY);
      }
    }
    return;
  }

  if (message.type === 'brief') {
    if (message.payload.file !== state.file) {
      return;
    }

    const wasLoading = state.briefLoading;
    if (message.payload.brief) {
      state.brief = message.payload.brief;
    } else if (!message.payload.loading && !wasLoading) {
      state.brief = null;
    }
    state.briefStale = Boolean(message.payload.stale);
    state.briefLoading = Boolean(message.payload.loading);
    if (message.payload.meta) {
      state.briefMeta = message.payload.meta;
    }

    if (state.lens === 'overview') {
      const scrollY = window.scrollY;
      render();
      window.scrollTo(0, scrollY);
    }
    return;
  }

  if (message.type === 'focusLens' && typeof message.lens === 'string') {
    if (['overview', 'spotlights', 'ownership'].includes(message.lens)) {
      state.lens = message.lens;
      render();
      resetScroll();
    }
    return;
  }

  if (message.type === 'scrollToLine' && typeof message.line === 'number') {
    if (state.lens === 'ownership' || state.lens === 'overview') {
      return;
    }
    ignoreScrollUntil = Date.now() + 300;
    scrollToNearestTarget(message.line);
    return;
  }

  if (message.type === 'cursor' && typeof message.line === 'number') {
    state.cursorLine = message.line;
    updateMemoryViews();
    applyCursor();
    return;
  }

  if (message.type === 'status' && typeof message.state === 'string') {
    state.status = { state: message.state, message: message.message || '' };
    const banner = document.querySelector('.status');
    if (banner) {
      banner.className = `status status-${state.status.state}`;
      banner.textContent = state.status.message;
    } else {
      render();
    }
  }
});

vscode.postMessage({ type: 'ready' });

function clearBriefState() {
  state.brief = null;
  state.briefStale = false;
  state.briefLoading = false;
  state.briefMeta = null;
}

function briefMetaLabel() {
  if (state.briefLoading) {
    return 'reading in progress';
  }
  if (state.brief) {
    return state.briefStale ? 'reading stale' : 'reading cached';
  }
  return null;
}

function render() {
  app.textContent = '';
  const shell = el('div', 'shell');
  shell.append(renderHeader());

  const status = el('div', `status status-${state.status.state}`);
  status.textContent = state.status.message || '';
  shell.append(status);

  if (!state.analysis && !state.overview) {
    const empty = el('div', 'empty');
    empty.append(el('p', null, 'No overview yet.'));
    const button = el('button', 'primary', 'Analyze current file');
    button.addEventListener('click', () => vscode.postMessage({ type: 'analyze', force: false }));
    empty.append(button);
    shell.append(empty);
    app.append(shell);
    applyRestore();
    return;
  }

  shell.append(renderTabs());
  const content = el('div', `content lens-${state.lens}`);
  if (state.lens === 'overview') {
    content.append(renderOverview());
  } else if (!state.analysis) {
    content.append(renderNeedsAnalysis());
  } else if (state.lens === 'spotlights') {
    content.append(renderSpotlights());
  } else if (state.lens === 'ownership') {
    content.append(renderOwnership());
  } else {
    content.append(renderSpotlights());
  }
  shell.append(content);
  app.append(shell);
  applyCursor();
  applyRestore();
}


function renderHeader() {
  const header = el('header', 'head');
  const title = el('div', 'title');
  title.append(el('h1', null, state.file || 'Derust'));

  const meta = el('p', 'meta');
  const briefLabel = briefMetaLabel();
  if (state.meta) {
    const bits = [`model ${state.meta.model}`];
    if (state.meta.usage) {
      bits.push(`${state.meta.usage.input} in / ${state.meta.usage.output} out`);
    }
    if (state.meta.issues && state.meta.issues.length > 0) {
      bits.push(`${state.meta.issues.length} dropped`);
    }
    if (briefLabel) {
      bits.push(briefLabel);
    }
    meta.textContent = bits.join('  ·  ');
  } else if (state.overview) {
    const bits = [`${state.overview.lineCount} lines`];
    if (state.overview.modulePath) {
      bits.push(state.overview.modulePath);
    }
    if (state.overview.keyConstructs.length > 0) {
      bits.push(`${state.overview.keyConstructs.length} constructs`);
    }
    if (briefLabel) {
      bits.push(briefLabel);
    }
    meta.textContent = bits.join('  ·  ');
  } else {
    meta.textContent = 'spotlights and ownership';
  }
  title.append(meta);

  const controls = el('div', 'controls');
  const reanalyze = el(
    'button',
    null,
    state.briefLoading ? 'Reading…' : state.analysis ? 'Re-analyze' : 'Read & Analyze'
  );
  reanalyze.disabled = state.briefLoading;
  reanalyze.addEventListener('click', () =>
    vscode.postMessage({ type: 'analyze', force: Boolean(state.analysis) })
  );
  controls.append(reanalyze);


  const layout = el('button', null, state.layout === 'columns' ? 'Cards' : 'Columns');
  layout.addEventListener('click', () => {
    state.layout = state.layout === 'columns' ? 'cards' : 'columns';
    render();
    resetScroll();
  });
  if (state.analysis && state.lens === 'spotlights') {
    controls.append(layout);
  }

  header.append(title, controls);
  return header;
}

function renderTabs() {
  const tabs = el('div', 'tabs');
  for (const [key, label] of [
    ['overview', 'Overview'],
    ['spotlights', 'Spotlights'],
    ['ownership', 'Ownership']
  ]) {
    const button = el('button', key === state.lens ? 'active' : null, label);
    button.setAttribute('role', 'tab');
    button.addEventListener('click', () => {
      state.lens = key;
      render();
      resetScroll();
    });
    tabs.append(button);
  }
  return tabs;
}

function renderOverview() {
  const overview = state.overview;
  if (!overview) {
    return el('p', 'empty', 'No overview yet.');
  }

  const wrap = el('div', 'overview');
  const brief = state.brief;

  const intro = el('section', 'overview-section overview-intro');
  intro.append(el('div', 'overview-kicker', overview.modulePath || overview.file));

  const summary = el('p', 'overview-summary');
  const summaryText =
    brief && brief.role
      ? brief.role
      : overview.keyConstructs.length > 0
        ? `${overview.keyConstructs.length} top-level constructs in ${overview.modulePath || overview.file}`
        : 'No top-level constructs found';
  summary.append(rich(summaryText));
  intro.append(summary);

  if (brief && brief.purpose) {
    const purpose = el('p', 'overview-purpose');
    purpose.append(rich(brief.purpose));
    intro.append(purpose);
  } else if (!state.briefLoading) {
    intro.append(
      el(
        'p',
        'overview-hint',
        'Use Read & Analyze above to build the module reading, spotlights and ownership.'
      )
    );
  }

  if (brief && brief.boundaries) {
    const boundaries = el('p', 'overview-boundaries');
    boundaries.append(rich(brief.boundaries));
    intro.append(boundaries);
  }

  wrap.append(intro);

  if (brief && brief.operations && brief.operations.length > 0) {
    wrap.append(renderBriefOperations(brief.operations));
  }

  if (brief && brief.functions && brief.functions.length > 0) {
    wrap.append(renderFunctionBriefs(brief.functions));
  }

  if (brief && brief.rules && brief.rules.length > 0) {
    wrap.append(renderBriefRules(brief.rules, 'Rules and edge cases'));
  }

  if (!brief || !brief.operations || brief.operations.length === 0) {
    const constructs = overview.keyConstructs || [];
    if (constructs.length > 0) {
      const section = el('section', 'overview-section');
      section.append(el('h2', null, 'Key constructs'));

      const list = el('div', 'overview-items');
      for (const item of constructs.slice(0, 10)) {
        list.append(renderOverviewItem(item));
      }
      section.append(list);

      if (constructs.length > 10) {
        section.append(el('p', 'overview-more', `+${constructs.length - 10} more`));
      }
      wrap.append(section);
    }

    const imports = overview.imports || [];
    if (imports.length > 0) {
      const section = el('section', 'overview-section');
      section.append(el('h2', null, 'Uses'));

      const local = imports.filter((item) => !item.external);
      const external = imports.filter((item) => item.external);
      if (local.length > 0) {
        section.append(renderImportGroup('local', local));
      }
      if (external.length > 0) {
        section.append(renderImportGroup('crates', external));
      }
      wrap.append(section);
    }
  }

  if (!state.briefLoading) {
    const next = el('section', 'overview-section overview-next');
    next.append(
      el(
        'p',
        null,
        state.analysis
          ? 'Spotlights and ownership are ready in the other tabs.'
          : 'Read & Analyze builds the module reading, spotlights and ownership. The source overview stays available while that runs.'
      )
    );
    wrap.append(next);
  }

  return wrap;
}

function renderBriefOutline(steps, assignedRules) {
  const section = el('section', 'overview-section');
  section.append(el('h2', null, 'How it works'));

  steps.forEach((step, index) => {
    const row = el('article', 'brief-step');
    row.dataset.start = step.start;
    row.dataset.end = step.end;
    row.dataset.target = '';
    row.tabIndex = 0;

    const head = el('div', 'brief-step-head');
    const title = el('span', 'brief-step-title');
    title.append(rich(step.title));
    head.append(title);
    head.append(el('span', 'brief-step-range', anchorLabel(step)));
    row.append(head);

    const text = el('p', 'brief-step-text');
    text.append(rich(step.text));
    row.append(text);

    const rules = assignedRules[index] || [];
    if (rules.length > 0) {
      row.append(renderStepRules(rules));
    }

    wireTarget(row);
    section.append(row);
  });

  return section;
}

function assignRules(steps, rules) {
  const assigned = steps.map(() => []);
  const loose = [];

  for (const rule of rules || []) {
    let bestIndex = -1;
    let bestOverlap = -1;

    steps.forEach((step, index) => {
      const overlap = Math.min(rule.end, step.end) - Math.max(rule.start, step.start);
      if (overlap >= 0 && overlap > bestOverlap) {
        bestOverlap = overlap;
        bestIndex = index;
      }
    });

    if (bestIndex >= 0) {
      assigned[bestIndex].push(rule);
    } else {
      loose.push(rule);
    }
  }

  return { assigned, loose };
}

function renderStepRules(rules) {
  const list = el('ul', 'brief-step-rules');

  for (const rule of rules) {
    const item = el('li', 'brief-step-rule');
    item.dataset.start = rule.start;
    item.dataset.end = rule.end;
    item.dataset.target = '';
    item.tabIndex = 0;

    const title = el('span', 'brief-step-rule-title');
    title.append(rich(rule.title));
    item.append(title);

    const text = el('span', 'brief-step-rule-text');
    text.append(rich(` ${rule.text}`));
    item.append(text);

    item.addEventListener('click', (event) => event.stopPropagation());
    item.addEventListener('keydown', (event) => event.stopPropagation());
    wireTarget(item);
    list.append(item);
  }

  return list;
}

function renderBriefRules(rules, heading) {
  const section = el('section', 'overview-section');
  section.append(el('h2', null, heading || 'Rules and edge cases'));

  const list = el('ul', 'brief-rules');
  for (const rule of rules) {
    const item = el('li', 'brief-rule');
    item.dataset.start = rule.start;
    item.dataset.end = rule.end;
    item.dataset.target = '';
    item.tabIndex = 0;

    const head = el('div', 'brief-rule-head');
    const title = el('span', 'brief-rule-title');
    title.append(rich(rule.title));
    head.append(title);
    head.append(el('span', 'brief-rule-range', anchorLabel(rule)));
    item.append(head);

    const text = el('p', 'brief-rule-text');
    text.append(rich(rule.text));
    item.append(text);

    wireTarget(item);
    list.append(item);
  }

  section.append(list);
  return section;
}

function renderBriefOperations(operations) {
  const section = el('section', 'overview-section');
  section.append(el('h2', null, 'Key operations'));

  const list = el('div', 'brief-operations');
  operations.forEach((operation, index) => {
    const row = el('article', 'brief-operation');
    row.dataset.start = operation.start;
    row.dataset.end = operation.end;
    row.dataset.target = '';
    row.tabIndex = 0;

    const head = el('div', 'brief-operation-head');
    head.append(el('span', 'brief-operation-index', String(index + 1).padStart(2, '0')));
    const name = el('span', 'brief-operation-name');
    name.append(rich(operation.name));
    head.append(name);
    head.append(el('span', 'brief-operation-range', anchorLabel(operation)));
    row.append(head);

    const purpose = el('p', 'brief-operation-text');
    purpose.append(rich(operation.purpose));
    row.append(purpose);

    const meta = el('div', 'brief-operation-meta');
    meta.append(el('span', null, 'entry '));
    meta.append(el('code', null, operation.entry));
    if (operation.functions && operation.functions.length > 0) {
      meta.append(el('span', null, ' · calls '));
      for (const fn of operation.functions.slice(0, 6)) {
        meta.append(el('code', null, fn));
      }
    }
    row.append(meta);

    wireTarget(row);
    list.append(row);
  });

  section.append(list);
  return section;
}

function renderFunctionBriefs(functions) {
  const section = el('section', 'overview-section');
  section.append(el('h2', null, 'How the key functions work'));

  for (const fn of functions) {
    const article = el('article', 'brief-function');

    const head = el('div', 'brief-function-head');
    head.dataset.start = fn.start;
    head.dataset.end = fn.end;
    head.dataset.target = '';
    head.tabIndex = 0;
    head.append(el('span', 'overview-kind', 'fn'));
    head.append(el('span', 'brief-function-name', fn.name));
    head.append(el('span', 'brief-function-range', anchorLabel(fn)));
    article.append(head);
    wireTarget(head);

    const summary = el('p', 'brief-function-summary');
    summary.append(rich(fn.summary));
    article.append(summary);

    if (fn.why) {
      const why = el('p', 'brief-function-why');
      why.append(el('span', 'brief-function-why-label', 'Why: '));
      why.append(rich(fn.why));
      article.append(why);
    }

    if (fn.steps && fn.steps.length > 0) {
      const list = el('ol', 'brief-function-steps');
      for (const step of fn.steps) {
        const item = el('li', 'brief-function-step');
        item.dataset.start = step.start;
        item.dataset.end = step.end;
        item.dataset.target = '';
        item.tabIndex = 0;
        const text = el('span', 'brief-function-step-text');
        text.append(rich(step.text));
        item.append(text);
        item.append(el('span', 'brief-step-range', anchorLabel(step)));
        wireTarget(item);
        list.append(item);
      }
      article.append(list);
    }

    const meta = el('dl', 'brief-function-meta');
    for (const [label, value] of [
      ['Inputs', fn.inputs],
      ['Returns', fn.returns],
      ['Errors', fn.errors],
      ['Side effects', fn.sideEffects]
    ]) {
      if (!value) {
        continue;
      }
      meta.append(el('dt', null, label));
      const description = el('dd');
      description.append(rich(value));
      meta.append(description);
    }
    if (meta.children.length > 0) {
      article.append(meta);
    }

    section.append(article);
  }

  return section;
}

function renderRustNotes(notes) {
  const section = el('section', 'overview-section');
  section.append(el('h2', null, 'Rust notes'));

  const list = el('ul', 'brief-notes');
  for (const note of notes) {
    const item = el('li');
    item.append(rich(note));
    list.append(item);
  }
  section.append(list);

  if (state.analysis) {
    const button = el('button', null, 'Open Spotlights');
    button.addEventListener('click', () => {
      state.lens = 'spotlights';
      render();
      resetScroll();
    });
    section.append(button);
  }

  return section;
}

function renderOverviewItem(item) {
  const row = el('article', 'overview-item');
  row.dataset.start = item.start;
  row.dataset.end = item.end;
  row.dataset.target = '';
  row.tabIndex = 0;

  const head = el('div', 'overview-item-head');
  head.append(el('span', 'overview-kind', item.kind));
  head.append(el('span', 'overview-name', item.name));
  head.append(
    el(
      'span',
      'overview-line',
      item.start === item.end ? `L${item.start}` : `L${item.start}–${item.end}`
    )
  );
  row.append(head);

  if (item.signature) {
    row.append(el('code', 'overview-signature', item.signature));
  }

  const why = state.brief
    ? (state.brief.constructs || []).find((entry) => entry.name === item.name)?.why
    : undefined;
  if (why) {
    const note = el('p', 'overview-why');
    note.append(rich(why));
    row.append(note);
  } else if (item.doc) {
    const doc = el('p', 'overview-doc');
    doc.append(rich(item.doc));
    row.append(doc);
  }

  wireTarget(row);
  return row;
}

function renderImportGroup(label, imports) {
  const group = el('div', 'overview-imports');
  group.append(el('span', 'overview-import-label', label));

  const chips = el('div', 'overview-chips');
  for (const item of imports.slice(0, 12)) {
    const chip = el('span', 'overview-chip');
    chip.append(el('code', null, item.path));
    if (item.symbols && item.symbols.length > 0) {
      const shown = item.symbols.slice(0, 4).join(', ');
      const more = item.symbols.length > 4 ? '…' : '';
      chip.append(el('span', 'overview-chip-symbols', ` ${shown}${more}`));
    }
    chips.append(chip);
  }
  if (imports.length > 12) {
    chips.append(el('span', 'overview-more', `+${imports.length - 12} more`));
  }

  group.append(chips);
  return group;
}

function renderNeedsAnalysis() {
  const empty = el('div', 'empty');
  empty.append(el('p', null, 'No analysis for this file yet.'));
  const button = el('button', 'primary', state.briefLoading ? 'Reading…' : 'Read & Analyze this file');
  button.disabled = state.briefLoading;
  button.addEventListener('click', () => vscode.postMessage({ type: 'analyze', force: false }));
  empty.append(button);
  return empty;
}

function renderSpotlights() {
  const wrap = el('div', `spotlights ${state.layout}`);
  const inventory = el('p', 'inventory');
  const types = state.analysis.typeInventory || [];
  inventory.textContent = types.length
    ? `Types: ${types.map((type) => `${type.name} (${type.start}–${type.end})`).join(' · ')}`
    : 'Types: none declared';
  wrap.append(inventory);

  if (state.layout === 'columns') {
    const head = el('div', 'row head');
    head.append(el('div', 'cell', 'construct'));
    const fields = el('div', 'fields');
    fields.append(el('div', 'cell', 'means'), el('div', 'cell', 'desugars to'), el('div', 'cell', 'trap'));
    head.append(fields);
    wrap.append(head);
  }

  for (const spotlight of state.analysis.spotlights || []) {
    wrap.append(renderSpotlight(spotlight));
  }

  if (!state.analysis.spotlights || state.analysis.spotlights.length === 0) {
    wrap.append(el('p', 'empty', 'No spotlights.'));
  }

  return wrap;
}

function renderSpotlight(spotlight) {
  const row = el('article', 'row');
  row.dataset.start = spotlight.start;
  row.dataset.end = spotlight.end;
  row.dataset.target = '';
  row.tabIndex = 0;

  const codeCell = el('div', 'cell codecell');
  codeCell.append(el('code', null, spotlight.code), el('span', 'anchor', anchorLabel(spotlight)));
  row.append(codeCell);

  const fields = el('div', 'fields');
  const means = el('div', 'cell means');
  means.append(el('span', 'label', 'means'));
  const meansText = el('p');
  meansText.append(rich(spotlight.means));
  means.append(meansText);

  const equivalent = el('div', 'cell equiv');
  equivalent.append(el('span', 'label', 'desugars to'), el('pre', null, spotlight.equivalent || '—'));

  const trap = el('div', 'cell trap');
  trap.append(el('span', 'label', 'trap'));
  const trapText = el('p');
  trapText.append(rich(spotlight.trap || ''));
  trap.append(trapText);
  if (!spotlight.trap) {
    trap.classList.add('muted');
  }

  fields.append(means, equivalent, trap);
  row.append(fields);
  wireTarget(row);
  return row;
}

function renderOwnership() {
  const wrap = el('div', 'trace');
  const records = state.analysis.memory || [];
  records.forEach((record, index) => {
    wrap.append(renderMemoryRecord(record, index));
  });
  if (records.length === 0) {
    wrap.append(el('p', 'empty', 'No memory model in this analysis. Re-run to request one.'));
  }
  wrap.append(renderGroups(state.analysis.ownership || [], 'ownership'));
  return wrap;
}

function renderMemoryRecord(record, index) {
  const section = el('section', 'memory-record');
  section.dataset.memoryIndex = String(index);

  const head = el('div', 'memory-head');
  const title = el('h3', null, 'Memory');
  title.append(el('span', null, `${record.function}, lines ${record.start}–${record.end}`));
  const chip = el('span', 'memory-line', '');
  head.append(title, chip);

  const body = el('div', 'memory-body');
  section.append(head, body);
  fillMemoryRecord(section, record);
  return section;
}

function fillMemoryRecord(section, record) {
  const body = section.querySelector('.memory-body');
  if (!body) {
    return;
  }

  const line = memoryActiveLine(record);
  const chip = section.querySelector('.memory-line');
  if (chip) {
    chip.textContent = `L${line}`;
  }

  body.textContent = '';
  body.append(renderMemoryTimeline(record, line));
  body.append(renderMemorySnapshot(record, line));

  const changes = memoryChanges(record, line);
  if (changes.length > 0) {
    const list = el('ul', 'memory-changes');
    for (const change of changes) {
      list.append(el('li', null, change));
    }
    body.append(list);
  }
}

function memoryActiveLine(record) {
  if (typeof state.cursorLine === 'number' && state.cursorLine >= record.start && state.cursorLine <= record.end) {
    return state.cursorLine;
  }
  return record.start;
}

function renderGroups(groups, label) {
  const wrap = el('div', 'groups');
  if (groups.length === 0) {
    wrap.append(el('p', 'empty', `No ${label} recorded.`));
    return wrap;
  }

  for (const group of groups) {
    const section = el('section', 'group');
    const head = el('h3', 'trace-head');
    head.append(document.createTextNode(group.name));
    head.append(el('span', null, `${group.start}–${group.end}`));
    head.dataset.start = group.start;
    head.dataset.end = group.end;
    head.tabIndex = 0;
    wireTarget(head);

    const list = el('ul', 'points');
    for (const point of group.points || []) {
      const item = el('li', 'point');
      item.dataset.start = point.start;
      item.dataset.end = point.end;
      item.dataset.target = '';
      item.tabIndex = 0;
      item.append(el('span', 'scope', scopeLabel(point, group)));
      item.append(rich(point.text));
      wireTarget(item);
      list.append(item);
    }

    section.append(head, list);
    wrap.append(section);
  }

  return wrap;
}

function scopeLabel(point, group) {
  if (point.scope === 'fn') {
    return 'fn';
  }
  if (point.scope === 'struct') {
    return 'struct';
  }
  if (point.start === group.start && point.end === group.end) {
    return 'fn';
  }
  return point.start === point.end ? `L${point.start}` : `L${point.start}–${point.end}`;
}

function updateMemoryViews() {
  if (state.lens !== 'ownership' || !state.analysis) {
    return;
  }

  for (const section of document.querySelectorAll('.memory-record')) {
    const index = Number(section.dataset.memoryIndex);
    const record = (state.analysis.memory || [])[index];
    if (record) {
      fillMemoryRecord(section, record);
    }
  }
}

function memoryChanges(record, line) {
  const exact = (record.events || []).filter((event) => event.line === line);
  const relevant = exact.length > 0 ? exact : (record.events || []).filter((event) => event.line <= line).slice(-2);

  return relevant.map((event) => {
    const destination = event.to ? ` → ${event.to}` : event.toLabel ? ` → ${event.toLabel}` : '';
    const detail = event.detail ? ` — ${event.detail}` : '';
    return `L${event.line}: ${event.kind} ${event.from}${destination}${detail}`;
  });
}

/* ---------- timeline ---------- */

let memorySvgSeq = 0;

function renderMemoryTimeline(record, activeLine) {
  const host = el('div', 'memory-timeline');
  const units = buildLaneUnits(record);

  if (units.length === 0) {
    return host;
  }

  const width = 720;
  const left = 170;
  const right = 704;
  const span = Math.max(1, record.end - record.start);
  const laneHeight = 32;
  const top = 40;
  const height = top + units.length * laneHeight + 18;
  const xFor = (line) => left + ((line - record.start) * (right - left)) / span;
  const yFor = (index) => top + index * laneHeight + laneHeight / 2;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': `Lifetimes for ${record.function}`
  });

  const seq = ++memorySvgSeq;
  const defs = svgEl('defs');
  defs.append(memoryArrow(`mem-arrow-${seq}`, 'var(--muted)'));
  defs.append(memoryArrow(`mem-arrow-accent-${seq}`, 'var(--accent)'));
  svg.append(defs);

  const tickStep = Math.max(1, Math.ceil(span / 8));
  const ticks = new Set([record.start, record.end, activeLine]);
  for (let line = record.start; line <= record.end; line += tickStep) {
    ticks.add(line);
  }

  for (const line of Array.from(ticks).sort((a, b) => a - b)) {
    const x = xFor(line);
    svg.append(svgEl('line', { x1: x, y1: 30, x2: x, y2: height - 8, class: 'tick' }));
    const label = svgText(x, 20, `L${line}`, 'axis');
    label.setAttribute('text-anchor', 'middle');
    svg.append(label);
  }

  const faceY = new Map();
  const valueY = new Map();

  units.forEach((unit, index) => {
    const center = yFor(index);
    const color = colorForValue(unit.value.id);

    const label = svgText(8, center + 4, unitLabel(unit), 'lane-label');
    label.style.fill = color;
    svg.append(label);

    unit.faces.forEach((face, faceIndex) => {
      const y = unit.faces.length > 1 ? center - 5 + faceIndex * 10 : center;
      faceY.set(face.id, y);
      if (!face.synthetic) {
        valueY.set(face.id, y);
      }

      const x1 = xFor(face.start);
      const x2 = Math.max(x1 + 2, xFor(face.end));
      const barHeight = face.synthetic ? 5 : 7;
      svg.append(svgEl('rect', {
        x: x1,
        y: y - barHeight / 2,
        width: x2 - x1,
        height: barHeight,
        rx: barHeight / 2,
        fill: color,
        opacity: face.synthetic ? 0.14 : 0.3
      }));

      const lineAttrs = {
        x1,
        y1: y,
        x2,
        y2: y,
        stroke: color,
        'stroke-width': face.synthetic ? 1.2 : 2
      };
      if (face.synthetic) {
        lineAttrs['stroke-dasharray'] = '2 2';
      }
      svg.append(svgEl('line', lineAttrs));

      const hit = svgEl('rect', {
        x: x1,
        y: y - 7,
        width: Math.max(6, x2 - x1),
        height: 14,
        fill: 'transparent',
        class: 'lane-hit'
      });
      addSvgTitle(
        hit,
        face.synthetic
          ? `*${refBaseName(unit.value.name)} — the referent view of ${unit.value.name}`
          : `${face.name}: L${face.start}–${face.end}`
      );
      hit.addEventListener('click', () => {
        if (face.synthetic) {
          const target = (record.values || []).find((entry) => entry.id === unit.value.borrowOf);
          if (target) {
            revealRange(target.start, target.end);
          } else {
            revealRange(unit.value.start, unit.value.end);
          }
        } else {
          revealRange(face.start, face.end);
        }
      });
      svg.append(hit);
    });

    if (unit.value.kind === 'ref' && unit.value.borrowOf) {
      const derefY = faceY.get(`${unit.value.id}::deref`);
      const targetY = valueY.get(unit.value.borrowOf);
      if (derefY !== undefined && targetY !== undefined) {
        const x = xFor(unit.value.start);
        const path = svgEl('path', {
          d: `M ${x} ${derefY} L ${x} ${targetY}`,
          class: 'borrow-link',
          'marker-end': `url(#mem-arrow-${seq})`
        });
        addSvgTitle(path, `${unit.value.name} borrows ${unit.value.borrowOf}`);
        svg.append(path);
      }
    }
  });

  for (const event of record.events || []) {
    const sourceY = faceY.get(event.from);
    if (sourceY === undefined) {
      continue;
    }

    const x = xFor(event.line);
    const dot = svgEl('circle', { cx: x, cy: sourceY, r: 4.5, fill: colorForValue(event.from), class: 'event-dot' });
    addSvgTitle(dot, `${event.kind} at L${event.line}${event.detail ? ` — ${event.detail}` : ''}`);
    dot.addEventListener('click', () => revealRange(event.line, event.line));
    svg.append(dot);

    if (event.to) {
      const targetY = faceY.get(event.to);
      if (targetY !== undefined) {
        const marker = event.kind === 'move' ? `mem-arrow-accent-${seq}` : `mem-arrow-${seq}`;
        const path = svgEl('path', {
          d: `M ${x} ${sourceY} C ${x + 22} ${sourceY} ${x + 22} ${targetY} ${x} ${targetY}`,
          class: `lane-arrow ${event.kind}`,
          'marker-end': `url(#${marker})`
        });
        addSvgTitle(path, `${event.kind} at L${event.line}`);
        svg.append(path);
      }
    }
  }

  const activeX = xFor(activeLine);
  svg.append(svgEl('line', { x1: activeX, y1: 30, x2: activeX, y2: height - 8, class: 'active-line' }));
  const active = svgText(activeX, height - 2, `L${activeLine}`, 'active-label');
  active.setAttribute('text-anchor', 'middle');
  svg.append(active);

  host.append(svg);
  return host;
}

function buildLaneUnits(record) {
  const units = (record.values || []).map((value) => {
    const faces = [
      { id: value.id, name: value.name, start: value.start, end: value.end, synthetic: false }
    ];

    if (value.kind === 'ref') {
      faces.push({
        id: `${value.id}::deref`,
        name: `*${refBaseName(value.name)}`,
        start: value.start,
        end: value.end,
        synthetic: true
      });
    }

    return { value, faces };
  });

  units.sort((a, b) => a.value.start - b.value.start || a.value.name.localeCompare(b.value.name));
  return units;
}

function unitLabel(unit) {
  const name = truncateLabel(unit.value.name, 10);
  if (unit.faces.length < 2) {
    return name;
  }
  return `${name} | *${truncateLabel(refBaseName(unit.value.name), 7)}`;
}

function refBaseName(name) {
  const stripped = name
    .replace(/^[&*]\s*/, '')
    .replace(/^mut\s+/, '')
    .split(/[^A-Za-z0-9_]+/)
    .filter(Boolean)
    .pop();
  return stripped || name;
}

function truncateLabel(value, max) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function valueEndLine(record, value) {
  const terminal = (record.events || [])
    .filter((event) => event.from === value.id && (event.kind === 'move' || event.kind === 'drop'))
    .sort((a, b) => a.line - b.line)[0];

  return terminal && terminal.line < value.end ? terminal.line : value.end;
}

/* ---------- snapshot ---------- */

function renderMemorySnapshot(record, activeLine) {
  const host = el('div', 'memory-snapshot');
  const frame = activeFrame(record, activeLine);
  let values = (record.values || []).filter(
    (value) =>
      value.start <= activeLine &&
      (!frame || value.frame === frame.id) &&
      (value.kind === 'binding' || (value.start <= activeLine && activeLine <= value.end))
  );
  if (values.length === 0) {
    values = (record.values || []).filter(
      (value) => value.start <= activeLine && (!frame || value.frame === frame.id)
    );
  }
  values.sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));

  const heapById = new Map((record.heap || []).map((box) => [box.id, box]));
  const heapIds = new Set();
  for (const value of values) {
    for (const pointer of value.pointers || []) {
      const box = heapById.get(pointer.heap);
      if (box && box.start <= activeLine) {
        heapIds.add(pointer.heap);
      }
    }
    if (value.kind === 'ref' && value.borrowOf && heapById.has(value.borrowOf)) {
      const box = heapById.get(value.borrowOf);
      if (box && box.start <= activeLine) {
        heapIds.add(value.borrowOf);
      }
    }
  }
  const heaps = (record.heap || []).filter((box) => heapIds.has(box.id));

  if (values.length === 0) {
    host.append(el('p', 'empty', 'No values at this line.'));
    return host;
  }

  const cellHeight = 38;
  const cellGap = 4;
  const top = 64;
  const stackHeight = values.length * (cellHeight + cellGap);
  const heapHeight = 64;
  const heapGap = 12;
  const heapTotal = heaps.length * (heapHeight + heapGap);
  const height = Math.max(top + stackHeight, top + heapTotal, 240) + 54;

  const svg = svgEl('svg', {
    viewBox: `0 0 720 ${height}`,
    role: 'img',
    'aria-label': `Memory at L${activeLine}`
  });

  const seq = ++memorySvgSeq;
  const defs = svgEl('defs');
  defs.append(memoryArrow(`mem-s-arrow-${seq}`, 'var(--muted)'));
  defs.append(memoryArrow(`mem-s-ref-${seq}`, 'var(--accent)'));
  svg.append(defs);

  svg.append(svgEl('rect', { x: 8, y: 30, width: 340, height: stackHeight + 22, rx: 3, class: 'frame' }));
  svg.append(svgText(22, 48, `${frame ? frame.name : 'frame'} · stack frame`, 'frame-title'));
  svg.append(svgText(420, 48, 'heap', 'frame-title'));

  const cellY = new Map();
  values.forEach((value, index) => {
    const y = top + index * (cellHeight + cellGap);
    cellY.set(value.id, y + cellHeight / 2);
    svg.append(renderMemoryCell(record, value, activeLine, y, cellHeight));
  });

  const boxY = new Map();
  heaps.forEach((box, index) => {
    const y = top + index * (heapHeight + heapGap);
    boxY.set(box.id, y + heapHeight / 2);
    svg.append(renderHeapBox(record, box, activeLine, y, heapHeight));
  });

  for (const value of values) {
    if (memoryDead(record, value, activeLine)) {
      continue;
    }

    for (const pointer of value.pointers || []) {
      const y2 = boxY.get(pointer.heap);
      const y1 = cellY.get(value.id);
      if (y1 === undefined || y2 === undefined) {
        continue;
      }
      const path = svgEl('path', {
        d: `M 340 ${y1} C 375 ${y1} 375 ${y2} 410 ${y2}`,
        class: 'link',
        'marker-end': `url(#mem-s-arrow-${seq})`
      });
      addSvgTitle(path, `${value.name}${pointer.field ? `.${pointer.field}` : ''} owns ${pointer.heap}`);
      svg.append(path);
    }
  }

  for (const value of values) {
    if (value.kind !== 'ref' || !value.borrowOf || memoryDead(record, value, activeLine)) {
      continue;
    }

    const y1 = cellY.get(value.id);
    if (y1 === undefined) {
      continue;
    }

    if (cellY.has(value.borrowOf)) {
      const y2 = cellY.get(value.borrowOf);
      const path = svgEl('path', {
        d: `M 18 ${y1} C 2 ${y1} 2 ${y2} 18 ${y2}`,
        class: 'ref-link',
        'marker-end': `url(#mem-s-ref-${seq})`
      });
      addSvgTitle(path, `${value.name} borrows ${value.borrowOf}`);
      svg.append(path);
    } else if (boxY.has(value.borrowOf)) {
      const y2 = boxY.get(value.borrowOf);
      const path = svgEl('path', {
        d: `M 340 ${y1} C 375 ${y1} 375 ${y2} 410 ${y2}`,
        class: 'link borrow',
        'marker-end': `url(#mem-s-ref-${seq})`
      });
      addSvgTitle(path, `${value.name} borrows ${value.borrowOf}`);
      svg.append(path);
    } else if (value.external) {
      const path = svgEl('path', {
        d: `M 340 ${y1} L 366 ${y1}`,
        class: 'link borrow',
        'marker-end': `url(#mem-s-ref-${seq})`
      });
      addSvgTitle(path, `borrows ${value.external}`);
      svg.append(path);
      svg.append(svgText(370, y1 + 3, 'caller', 'heap-sub'));
    }
  }

  host.append(svg);
  host.append(el('p', 'memory-legend', 'O own, R read, W write, B borrowed. Solid pointer = owns; dashed = borrow.'));
  return host;
}

function renderMemoryCell(record, value, line, y, height) {
  const valueState = memoryState(record, value, line);
  const perms = memoryPermissions(record, value, line);
  const group = svgEl('g', { class: `mem-cell state-${valueState}${value.kind === 'ref' ? ' ref' : ''}` });

  group.append(svgEl('rect', { x: 18, y, width: 320, height, rx: 2, class: 'cell-box' }));

  const name = svgText(30, y + 16, value.name, 'cell-name');
  if (valueState === 'moved' || valueState === 'dropped') {
    name.setAttribute('text-decoration', 'line-through');
  }
  group.append(name);
  group.append(svgText(30, y + 30, value.type, 'cell-type'));

  const badges = [['O', 'own'], ['R', 'read'], ['W', 'write'], ['B', 'borrow']];
  badges.forEach(([letter, key], index) => {
    group.append(svgText(246 + index * 16, y + 22, letter, perms[key] ? 'badge on' : 'badge off'));
  });

  if (valueState === 'moved' || valueState === 'dropped') {
    group.append(svgText(246, y + 22, valueState === 'moved' ? '✕ moved' : '✕ dropped', 'moved-tag'));
  }

  if ((value.pointers || []).length > 0) {
    group.append(svgEl('circle', { cx: 330, cy: y + height / 2, r: 3.5, class: 'ptr' }));
  }

  addSvgTitle(group, value.note || `${value.name}: ${value.type}`);
  group.addEventListener('click', () => revealRange(value.start, value.end));
  return group;
}

function renderHeapBox(record, box, line, y, height) {
  const status = heapStatus(record, box, line);
  const group = svgEl('g', { class: `heap-box state-${status.state}` });

  group.append(svgEl('rect', { x: 410, y, width: 300, height, rx: 2, class: 'heap-rect' }));
  group.append(svgText(424, y + 18, box.label, 'heap-label'));

  const layout = box.layout
    ? ` · len ${box.layout.len ?? '?'} cap ${box.layout.cap ?? '?'}`
    : '';
  group.append(svgText(424, y + 32, `${box.type}${layout}`, 'heap-sub'));

  const badges = [['O', 'own'], ['R', 'read'], ['W', 'write'], ['B', 'borrow']];
  badges.forEach(([letter, key], index) => {
    group.append(svgText(636 + index * 15, y + 18, letter, status.perms[key] ? 'badge on' : 'badge off'));
  });

  (box.cells || []).slice(0, 3).forEach((cell, index) => {
    const x = 420 + index * 92;
    group.append(svgEl('rect', { x, y: y + 38, width: 88, height: 18, rx: 1, class: 'heap-cell' }));
    group.append(svgText(x + 7, y + 51, cell, 'heap-cell-label'));
  });

  addSvgTitle(group, box.note || box.label);
  group.addEventListener('click', () => revealRange(box.start, box.end));
  return group;
}

/* ---------- state computation ---------- */

function memoryState(record, value, line) {
  if (line < value.start) {
    return 'future';
  }

  const terminal = (record.events || []).find(
    (event) =>
      event.from === value.id &&
      (event.kind === 'move' || event.kind === 'drop' || event.kind === 'assign') &&
      event.line <= line
  );

  if (terminal) {
    return terminal.kind === 'drop' ? 'dropped' : 'moved';
  }

  if (line > value.end) {
    return 'dropped';
  }

  if (line === value.end) {
    return 'ending';
  }

  return 'owned';
}

function memoryDead(record, value, line) {
  const valueState = memoryState(record, value, line);
  return valueState === 'moved' || valueState === 'dropped' || valueState === 'future';
}

function memoryPermissions(record, value, line) {
  const valueState = memoryState(record, value, line);
  if (valueState === 'moved' || valueState === 'dropped' || valueState === 'future') {
    return { own: false, read: false, write: false, borrow: false };
  }

  const borrows = (record.values || []).filter(
    (ref) => ref.kind === 'ref' && ref.borrowOf === value.id && ref.start <= line && line <= ref.end
  );

  const mutableBorrow = borrows.some((ref) => ref.borrowMode === 'mutable');
  const anyBorrow = borrows.length > 0;
  const writeThrough = value.kind === 'ref' && value.borrowMode === 'mutable';

  return {
    own: true,
    read: !mutableBorrow,
    write: (value.mutable || writeThrough) && !anyBorrow,
    borrow: anyBorrow
  };
}

function heapStatus(record, box, line) {
  const owners = (record.values || []).filter(
    (value) =>
      value.kind !== 'ref' &&
      value.start <= line &&
      line <= value.end &&
      memoryState(record, value, line) === 'owned' &&
      (value.pointers || []).some((pointer) => pointer.heap === box.id)
  );

  const borrows = (record.values || []).filter(
    (value) =>
      value.kind === 'ref' &&
      value.start <= line &&
      line <= value.end &&
      (value.borrowOf === box.id || (value.borrowOf && owners.some((owner) => owner.id === value.borrowOf)))
  );

  const live = owners.length > 0 || borrows.length > 0;
  const mutableBorrow = borrows.some((value) => value.borrowMode === 'mutable');
  const state = live ? (borrows.length > 0 ? 'borrowed' : 'owned') : line > box.end ? 'dropped' : 'ending';

  return {
    state,
    perms: {
      own: owners.length > 0,
      read: live,
      write: owners.some((value) => value.mutable) && !mutableBorrow,
      borrow: borrows.length > 0
    }
  };
}

function activeFrame(record, line) {
  const containing = (record.frames || [])
    .filter((frame) => frame.start <= line && line <= frame.end)
    .sort((a, b) => b.start - a.start);
  return containing[0] || (record.frames || [])[0];
}

/* ---------- shared helpers ---------- */

function revealRange(start, end) {
  vscode.postMessage({ type: 'reveal', start, end });
}

const MEMORY_COLORS = [
  '#3f7f9f',
  '#b4652f',
  '#6c7d3d',
  '#7a5aa0',
  '#a34c4c',
  '#3f7f6f',
  '#8a6a2f',
  '#5a6a7a',
  '#8a5a7a',
  '#2f6a6a'
];

function colorForValue(id) {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return MEMORY_COLORS[hash % MEMORY_COLORS.length];
}

function memoryArrow(id, color) {
  const marker = svgEl('marker', {
    id,
    viewBox: '0 0 8 8',
    refX: 7,
    refY: 4,
    markerWidth: 6,
    markerHeight: 6,
    orient: 'auto-start-reverse'
  });
  marker.append(svgEl('path', { d: 'M0,0 L8,4 L0,8 z', fill: color }));
  return marker;
}

function addSvgTitle(node, value) {
  const title = svgEl('title');
  title.textContent = value;
  node.append(title);
}

function wireTarget(element) {
  element.addEventListener('click', () => {
    const start = Number(element.dataset.start);
    const end = Number(element.dataset.end);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      vscode.postMessage({ type: 'reveal', start, end });
    }
  });
  element.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      element.click();
    }
  });
}

function applyCursor() {
  const targets = Array.from(document.querySelectorAll('[data-target]'));
  for (const target of targets) {
    target.classList.remove('remote', 'pinned');
  }

  if (state.cursorLine === null) {
    return;
  }

  const hits = targets.filter((target) => {
    const start = Number(target.dataset.start);
    const end = Number(target.dataset.end);
    return start <= state.cursorLine && state.cursorLine <= end;
  });

  if (hits.length === 0) {
    return;
  }

  const span = (target) => Number(target.dataset.end) - Number(target.dataset.start);
  const min = Math.min(...hits.map(span));
  const shouldScroll = state.lens !== 'ownership' && state.lens !== 'overview';
  for (const target of hits.filter((hit) => span(hit) === min)) {
    target.classList.add('remote');
    if (shouldScroll) {
      ignoreScrollUntil = Date.now() + 250;
      target.scrollIntoView({ block: 'nearest' });
    }
  }
}

function resetScroll() {
  ignoreScrollUntil = Date.now() + 300;
  window.scrollTo(0, 0);
}

function scrollToNearestTarget(line) {
  const targets = Array.from(document.querySelectorAll('[data-target]'));
  if (targets.length === 0) {
    return;
  }

  const containing = targets.filter(
    (target) => Number(target.dataset.start) <= line && line <= Number(target.dataset.end)
  );

  let chosen;
  if (containing.length > 0) {
    const spanOf = (target) => Number(target.dataset.end) - Number(target.dataset.start);
    const min = Math.min(...containing.map(spanOf));
    chosen = containing.find((target) => spanOf(target) === min);
  } else {
    let best = Number.POSITIVE_INFINITY;
    for (const target of targets) {
      const start = Number(target.dataset.start);
      const end = Number(target.dataset.end);
      const distance = line < start ? start - line : line > end ? line - end : 0;
      if (distance < best) {
        best = distance;
        chosen = target;
      }
    }
  }

  if (chosen) {
    const header = document.querySelector('.head');
    const offset = (header ? header.offsetHeight : 0) + 8;
    const top = chosen.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo(0, Math.max(0, top));
  }
}

function topVisibleTargetLine() {
  const targets = Array.from(document.querySelectorAll('[data-target]'));
  for (const target of targets) {
    if (target.getBoundingClientRect().bottom >= 0) {
      return Number(target.dataset.start);
    }
  }
  return null;
}

window.addEventListener(
  'scroll',
  () => {
    if (scrollTimer) {
      clearTimeout(scrollTimer);
    }
    scrollTimer = setTimeout(() => {
      if (state.lens === 'ownership') {
        return;
      }
      if (Date.now() < ignoreScrollUntil) {
        return;
      }
      const line = topVisibleTargetLine();
      if (line !== null) {
        vscode.postMessage({ type: 'scrolled', line });
      }
    }, 90);
  },
  { passive: true }
);

function anchorLabel(item) {
  return item.start === item.end ? `L${item.start}` : `L${item.start}–${item.end}`;
}

function scopeLabel(point, group) {
  if (point.scope === 'fn') {
    return 'fn';
  }
  if (point.scope === 'struct') {
    return 'struct';
  }
  if (point.start === group.start && point.end === group.end) {
    return 'fn';
  }
  return point.start === point.end ? `L${point.start}` : `L${point.start}–${point.end}`;
}

function rich(text) {
  const fragment = document.createDocumentFragment();
  const parts = String(text).split('`');
  parts.forEach((part, index) => {
    if (!part) {
      return;
    }
    if (index % 2 === 1) {
      fragment.append(el('code', null, part));
    } else {
      fragment.append(document.createTextNode(part));
    }
  });
  return fragment;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined && text !== null) {
    node.textContent = text;
  }
  return node;
}

function svgEl(tag, attributes) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes || {})) {
    node.setAttribute(key, value);
  }
  return node;
}

function svgText(x, y, text, className) {
  const node = svgEl('text', { x: String(x), y: String(y), class: className });
  node.textContent = text;
  return node;
}
