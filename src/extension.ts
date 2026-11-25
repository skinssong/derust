import * as path from 'path';
import * as vscode from 'vscode';
import { analyzeSource, SourceMeta } from './analyzer';
import { ArchitectureModel } from './architecture';
import { ArchitecturePanel } from './architecturePanel';
import { ArchitectureService } from './architectureService';
import {
  BRIEF_PROMPT_VERSION,
  BRIEF_SYSTEM_PROMPT,
  BriefSourceMeta,
  buildBriefUserPrompt,
  formatModuleContext,
  parseBriefJson,
  validateBrief
} from './brief';
import { BriefCache } from './briefCache';
import { AnalysisCache } from './cache';
import { Analysis, CachedAnalysis, CachedBrief } from './contract';
import { ensureProvider, getConfig, importProviderSettings, messageOf } from './config';
import { FlowCache } from './flowCache';
import { IndexService } from './indexService';
import { ReadingCache } from './readingCache';
import { OverviewLens, OverviewService } from './overviewLens';
import { buildProfileCandidates } from './profile';
import { ReaderPanel } from './panel';
import { PanelHost, PanelView } from './panelHost';
import { crateRoot, readCrateName } from './project';
import { completeJson, completeJsonRepair, ProviderSettings } from './provider';
import { buildFlowInput, extractJsonObject, FLOW_SYSTEM_PROMPT, linkFlowSources, parseFlowText } from './flow';
import { buildFlowBriefInput, FLOW_BRIEF_SYSTEM_PROMPT, parseFlowBrief } from './flowBrief';
import { buildReadingInput, parseReading, READING_SYSTEM_PROMPT } from './reading';
import { PROMPT_VERSION } from './schema';

type Current = {
  uri: vscode.Uri;
  analysis: Analysis;
  sourceHash: string;
  model: string;
};

type AnalyzeOptions = {
  force: boolean;
  showPanel: boolean;
  progress?: boolean;
  signal?: AbortSignal;
};

let contextRef: vscode.ExtensionContext;
let cache: AnalysisCache;
let briefCache: BriefCache;
let panel: ReaderPanel | undefined;
let panelUri: vscode.Uri | undefined;
let current: Current | undefined;
let overviewLens: OverviewLens | undefined;
let indexService: IndexService;
let architectureService: ArchitectureService;
let flowCache: FlowCache;
let readingCache: ReadingCache;
let architectureModel: ArchitectureModel | undefined;
let flowRunning = false;
let briefController: AbortController | undefined;
let briefTarget: string | undefined;
const overviewService = new OverviewService();
let activeDecoration: vscode.TextEditorDecorationType;
let pinnedDecoration: vscode.TextEditorDecorationType;
let selectionTimer: NodeJS.Timeout | undefined;
let changeTimer: NodeJS.Timeout | undefined;
let visibleRangesTimer: NodeJS.Timeout | undefined;
let restoreTimer: NodeJS.Timeout | undefined;
let ignoreEditorScrollUntil = 0;
let output: vscode.OutputChannel;
const LAST_FILE_KEY = 'derust.lastFile';
// Keep in sync with MEMORY_COLORS in media/panel.js.
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
let valueDecorations: vscode.TextEditorDecorationType[] = [];

export function activate(context: vscode.ExtensionContext): void {
  contextRef = context;
  cache = new AnalysisCache(context);
  briefCache = new BriefCache(context);
  output = vscode.window.createOutputChannel('Derust');
  overviewLens = new OverviewLens();
  indexService = new IndexService(context, overviewService, output);
  architectureService = new ArchitectureService(context, overviewService, output);
  flowCache = new FlowCache(context);
  readingCache = new ReadingCache(context);

  activeDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    borderColor: new vscode.ThemeColor('editor.findMatchBorder'),
    borderWidth: '1px',
    borderStyle: 'solid'
  });
  pinnedDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.selectionHighlightBackground')
  });
  valueDecorations = MEMORY_COLORS.map((color) =>
    vscode.window.createTextEditorDecorationType({ color })
  );

  context.subscriptions.push(
    output,
    activeDecoration,
    pinnedDecoration,
    ...valueDecorations,
    overviewLens,
    vscode.commands.registerCommand('derust.analyzeFile', (uri?: vscode.Uri) => analyzeFile(uri)),
    vscode.commands.registerCommand('derust.analyzePath', (uri?: vscode.Uri) => analyzePath(uri)),
    vscode.commands.registerCommand('derust.analyzeWorkspace', () => analyzeWorkspace()),
    vscode.commands.registerCommand('derust.analyzeArchitecture', () => analyzeArchitecture()),
    vscode.commands.registerCommand('derust.openPanel', () => openPanel()),
    vscode.commands.registerCommand('derust.showOverview', (uri?: vscode.Uri) => showOverview(uri)),
    vscode.commands.registerCommand('derust.rebuildIndex', () => rebuildIndex()),
    vscode.commands.registerCommand('derust.showIndexPacket', () => showIndexPacket()),
    vscode.commands.registerCommand('derust.configureProvider', async () => {
      const provider = await ensureProvider(context, { force: true });
      if (provider) {
        void vscode.window.showInformationMessage(
          `Derust: provider configured for ${provider.config.model}.`
        );
      }
    }),
    vscode.commands.registerCommand('derust.importEnv', () => importProviderSettings(context)),
    vscode.commands.registerCommand('derust.clearCache', () => clearCache()),
    vscode.window.onDidChangeTextEditorSelection((event) => handleSelection(event)),
    vscode.window.onDidChangeTextEditorVisibleRanges((event) => handleVisibleRanges(event)),
    vscode.workspace.onDidChangeTextDocument((event) => handleDocumentChanged(event)),
    vscode.window.onDidChangeActiveTextEditor((editor) => handleActiveEditor(editor)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('derust.overviewGlance')) {
        overviewLens?.refresh();
      }
    })
  );

  PanelHost.onSwitch((view) => switchPanelView(view));
  void restoreLastAnalysis(context, false);
  restoreTimer = setTimeout(() => {
    if (!panel && !current) {
      void restoreLastAnalysis(context, false);
    }
  }, 2000);
}

export function deactivate(): void {
  briefController?.abort();
  if (selectionTimer) {
    clearTimeout(selectionTimer);
  }
  if (changeTimer) {
    clearTimeout(changeTimer);
  }
  if (visibleRangesTimer) {
    clearTimeout(visibleRangesTimer);
  }
  if (restoreTimer) {
    clearTimeout(restoreTimer);
  }
  panel?.dispose();
}

async function analyzeFile(uri?: vscode.Uri): Promise<void> {
  if (!uri) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'rust') {
      vscode.window.showInformationMessage('Derust: open a Rust file first.');
      return;
    }
    uri = editor.document.uri;
  }

  if (!uri.path.endsWith('.rs')) {
    vscode.window.showInformationMessage('Derust: only .rs files are supported.');
    return;
  }

  await readAndAnalyzeFile(uri, false);
}

async function analyzePath(initial?: vscode.Uri): Promise<void> {
  let target = initial;

  if (!target) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    const value = await vscode.window.showInputBox({
      title: 'Analyze a Rust file or folder',
      prompt: 'Workspace-relative path, or an absolute path',
      value: '',
      ignoreFocusOut: true
    });

    if (!value?.trim()) {
      return;
    }

    target = path.isAbsolute(value.trim())
      ? vscode.Uri.file(value.trim())
      : root
        ? vscode.Uri.joinPath(root, value.trim())
        : vscode.Uri.file(value.trim());
  }

  const targetUri = target;

  let stat: vscode.FileStat;
  try {
    stat = await vscode.workspace.fs.stat(targetUri);
  } catch {
    vscode.window.showErrorMessage(`Derust: ${vscode.workspace.asRelativePath(targetUri, false)} was not found.`);
    return;
  }

  if ((stat.type & vscode.FileType.Directory) !== 0) {
    const uris = await findRustFiles(targetUri);
    await chooseAndAnalyze(uris);
    return;
  }

  if (!targetUri.path.endsWith('.rs')) {
    vscode.window.showInformationMessage('Derust: only .rs files are supported.');
    return;
  }

  await readAndAnalyzeFile(targetUri, false);
}

async function analyzeWorkspace(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    vscode.window.showInformationMessage('Derust: open a workspace first.');
    return;
  }

  const uris = await findRustFiles(root);
  await chooseAndAnalyze(uris);
}

function responseSnippet(text: string): string {
  const value = text.replace(/\s+/g, ' ').trim();
  return value.length > 160 ? `${value.slice(0, 160)}…` : value;
}

function parseReadingResponse(text: string, files: Set<string>): ReturnType<typeof parseReading> {
  const value = extractJsonObject(text);
  if (value === undefined) {
    return undefined;
  }
  return parseReading(Array.isArray(value) ? { steps: value } : value, files);
}

async function writeReading(): Promise<void> {
  const model = architectureModel;
  if (!model) {
    ArchitecturePanel.postReadingError('Run Derust: Analyze Architecture first.');
    return;
  }
  const provider = await ensureProvider(contextRef);
  if (!provider) {
    ArchitecturePanel.postReadingError('Provider setup was cancelled.');
    return;
  }
  const { config, apiKey } = provider;

  const settings: ProviderSettings = {
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey,
    jsonMode: config.jsonMode,
    timeoutMs: config.timeoutSeconds * 1000,
    maxTokens: Math.min(config.maxOutputTokens, 4000),
    reasoningEffort: config.reasoningEffort === 'none' ? 'none' : 'low',
    userAgent: `derust/${contextRef.extension.packageJSON.version}`
  };
  const files = new Set(model.nodes.flatMap((node) => node.modules));

  try {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Derust — ${model.meta.crate} reading order`,
        cancellable: true
      },
      async (progress, token) => {
        progress.report({ message: 'Planning a reading order…' });
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        return completeJson(READING_SYSTEM_PROMPT, buildReadingInput(model), settings, controller.signal);
      }
    );
    let reading = parseReadingResponse(result.text, files);
    let last = result;
    if (!reading) {
      output.appendLine(
        `[architecture] reading raw (finish=${result.finishReason ?? '?'}, usage=${JSON.stringify(result.usage ?? null)}): ${result.text.replace(/\s+/g, ' ').slice(0, 4000)}`
      );
      last = await completeJsonRepair(READING_SYSTEM_PROMPT, buildReadingInput(model), result.text, settings);
      reading = parseReadingResponse(last.text, files);
      if (!reading) {
        output.appendLine(
          `[architecture] reading retry raw (finish=${last.finishReason ?? '?'}, usage=${JSON.stringify(last.usage ?? null)}): ${last.text.replace(/\s+/g, ' ').slice(0, 4000)}`
        );
      }
    }
    if (!reading) {
      throw new Error(
        `The provider returned no usable reading order. Response began: “${responseSnippet(last.text)}”`
      );
    }
    const generatedAt = new Date().toISOString();
    readingCache.write(
      model.meta.root,
      readingCache.key(model.meta.revision, config.model),
      { ...reading, model: config.model, revision: model.meta.revision, generatedAt }
    );
    ArchitecturePanel.postReading(reading);
  } catch (error) {
    output.appendLine(`[architecture] reading: ${messageOf(error)}`);
    ArchitecturePanel.postReadingError(messageOf(error));
  }
}

async function writeFlow(): Promise<void> {
  if (flowRunning) {
    return;
  }
  const model = architectureModel;
  if (!model) {
    ArchitecturePanel.postFlowError('Run Derust: Analyze Architecture first.');
    return;
  }
  const provider = await ensureProvider(contextRef);
  if (!provider) {
    ArchitecturePanel.postFlowError('Provider setup was cancelled.');
    return;
  }
  const { config, apiKey } = provider;

  flowRunning = true;
  const settings: ProviderSettings = {
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey,
    jsonMode: config.jsonMode,
    timeoutMs: config.timeoutSeconds * 1000,
    maxTokens: Math.min(config.maxOutputTokens, 8000),
    reasoningEffort: config.reasoningEffort === 'none' ? 'none' : 'low',
    userAgent: `derust/${contextRef.extension.packageJSON.version}`
  };

  try {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Derust — ${model.meta.crate} flow`,
        cancellable: true
      },
      async (progress, token) => {
        progress.report({ message: 'Tracing one run…' });
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        return completeJson(FLOW_SYSTEM_PROMPT, buildFlowInput(model), settings, controller.signal);
      }
    );
    let parsed = parseFlowText(result.text);
    let last = result;
    if (!parsed.spec) {
      output.appendLine(
        `[architecture] flow raw (finish=${result.finishReason ?? '?'}, usage=${JSON.stringify(result.usage ?? null)}): ${result.text.replace(/\s+/g, ' ').slice(0, 4000)}`
      );
      last = await completeJsonRepair(FLOW_SYSTEM_PROMPT, buildFlowInput(model), result.text, settings);
      parsed = parseFlowText(last.text);
      if (!parsed.spec) {
        output.appendLine(
          `[architecture] flow retry raw (finish=${last.finishReason ?? '?'}, usage=${JSON.stringify(last.usage ?? null)}): ${last.text.replace(/\s+/g, ' ').slice(0, 4000)}`
        );
      }
    }
    if (!parsed.spec) {
      throw new Error(
        `The provider returned no usable flow — ${parsed.reason ?? 'unknown reason'} (finish_reason: ${last.finishReason ?? 'unknown'}). Response began: “${responseSnippet(last.text)}”`
      );
    }
    const flow = parsed.spec;
    linkFlowSources(flow, model);
    const generatedAt = new Date().toISOString();
    const cacheKey = flowCache.key(model.meta.revision, config.model);
    flowCache.write(model.meta.root, cacheKey, {
      ...flow,
      model: config.model,
      revision: model.meta.revision,
      generatedAt
    });
    ArchitecturePanel.postFlow(flow);
    const briefSettings: ProviderSettings = {
      ...settings,
      maxTokens: Math.min(config.maxOutputTokens, 1200)
    };
    try {
      const briefResult = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Derust — ${model.meta.crate} opening line`,
          cancellable: true
        },
        async (progress, token) => {
          progress.report({ message: 'Writing the opening line…' });
          const controller = new AbortController();
          token.onCancellationRequested(() => controller.abort());
          return completeJson(
            FLOW_BRIEF_SYSTEM_PROMPT,
            buildFlowBriefInput(model, flow),
            briefSettings,
            controller.signal
          );
        }
      );
      let brief = parseFlowBrief(briefResult.text);
      if (!brief) {
        output.appendLine(
          `[architecture] brief raw (finish=${briefResult.finishReason ?? '?'}): ${briefResult.text.replace(/\s+/g, ' ').slice(0, 2000)}`
        );
        const repair = await completeJsonRepair(
          FLOW_BRIEF_SYSTEM_PROMPT,
          buildFlowBriefInput(model, flow),
          briefResult.text,
          briefSettings
        );
        brief = parseFlowBrief(repair.text);
        if (!brief) {
          output.appendLine(
            `[architecture] brief retry raw (finish=${repair.finishReason ?? '?'}): ${repair.text.replace(/\s+/g, ' ').slice(0, 2000)}`
          );
        }
      }
      if (brief) {
        flow.brief = brief;
        flowCache.write(model.meta.root, cacheKey, {
          ...flow,
          model: config.model,
          revision: model.meta.revision,
          generatedAt
        });
        ArchitecturePanel.postFlow(flow);
      }
    } catch (error) {
      output.appendLine(`[architecture] brief: ${messageOf(error)}`);
    }
  } catch (error) {
    output.appendLine(`[architecture] flow: ${messageOf(error)}`);
    ArchitecturePanel.postFlowError(messageOf(error));
  } finally {
    flowRunning = false;
  }
}

async function openModuleFromArchitecture(uri: vscode.Uri): Promise<void> {
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.Active,
      preview: false,
      preserveFocus: false
    });
    await showOverview(uri);
  } catch (error) {
    output.appendLine(`[architecture] open module failed: ${messageOf(error)}`);
    void vscode.window.showErrorMessage(`Derust: could not open ${uri.fsPath}`);
  }
}

async function analyzeArchitecture(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const uri =
    (editor?.document.languageId === 'rust' ? editor.document.uri : undefined) ??
    vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!uri) {
    void vscode.window.showInformationMessage('Derust: open a Rust workspace first.');
    return;
  }

  try {
    const model = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Derust: analyzing architecture',
        cancellable: true
      },
      (progress, token) => architectureService.build(uri, progress, token)
    );
    if (!model) {
      void vscode.window.showInformationMessage('Derust: no Rust sources under src/.');
      return;
    }
    architectureModel = model;
    const config = getConfig();
    const cachedFlow = config.model
      ? flowCache.read(model.meta.root, flowCache.key(model.meta.revision, config.model))
      : undefined;
    const cachedReading = config.model
      ? readingCache.read(
          model.meta.root,
          readingCache.key(model.meta.revision, config.model)
        )
      : undefined;
    const autoDraw = !cachedFlow || !cachedFlow.brief;
    ArchitecturePanel.show(
      contextRef,
      model,
      {
        onOpenModule: (uri) => {
          void openModuleFromArchitecture(uri);
        },
        onWriteFlow: () => {
          void writeFlow();
        },
        onWriteReading: () => {
          void writeReading();
        }
      },
      cachedFlow,
      cachedReading,
      autoDraw
    );
    if (autoDraw) {
      void writeFlow();
    }
  } catch (error) {
    output.appendLine(`[architecture] ${messageOf(error)}`);
    void vscode.window.showErrorMessage(
      `Derust: architecture analysis failed — ${messageOf(error)}`
    );
  }
}

async function openPanel(): Promise<void> {
  if (panel?.isDisposed) {
    panel = undefined;
  }

  const editor = vscode.window.activeTextEditor;

  if (editor && editor.document.languageId === 'rust') {
    const uri = editor.document.uri;

    if (panel && panelUri?.toString() === uri.toString()) {
      panel.reveal();
      return;
    }

    try {
      const hit = await readCachedForUri(uri);
      if (hit) {
        await showAnalysis(uri, hit.fileLabel, hit.cached, getConfig().defaultLayout);
      } else {
        await showStructuralOverview(uri, true);
      }
      return;
    } catch (error) {
      output.appendLine(`[open] ${messageOf(error)}`);
    }

    await showStructuralOverview(uri, true);
    return;
  }

  if (panel) {
    panel.reveal();
    return;
  }

  if (current) {
    try {
      const hit = await readCachedForUri(current.uri);
      if (hit) {
        await showAnalysis(current.uri, hit.fileLabel, hit.cached, getConfig().defaultLayout);
        return;
      }
    } catch (error) {
      output.appendLine(`[open] ${messageOf(error)}`);
    }
  }

  if (await restoreLastAnalysis(contextRef, true)) {
    return;
  }

  vscode.window.showInformationMessage('Derust: open a Rust file first.');
}

async function showOverview(uri?: vscode.Uri): Promise<void> {
  if (!uri) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'rust') {
      vscode.window.showInformationMessage('Derust: open a Rust file first.');
      return;
    }
    uri = editor.document.uri;
  }

  if (!uri.path.endsWith('.rs')) {
    vscode.window.showInformationMessage('Derust: only .rs files are supported.');
    return;
  }

  try {
    const hit = await readCachedForUri(uri);
    if (hit) {
      await showAnalysis(uri, hit.fileLabel, hit.cached, getConfig().defaultLayout);
    } else {
      await showStructuralOverview(uri, true);
    }
  } catch (error) {
    output.appendLine(`[overview] ${messageOf(error)}`);
    await showStructuralOverview(uri, true);
  }

  panel?.focusLens('overview');

  const config = getConfig();
  if (config.briefOnOverview && config.baseUrl && config.model) {
    void explainFile(uri, false);
  }
}

async function showStructuralOverview(uri: vscode.Uri, reveal: boolean): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  const overview = await overviewService.build(document);

  if (
    !reveal &&
    vscode.window.activeTextEditor?.document.uri.toString() !== uri.toString()
  ) {
    return;
  }

  if (panelUri && panelUri.toString() !== uri.toString()) {
    cancelBrief();
  }

  const fileLabel = vscode.workspace.asRelativePath(uri, false);
  const target = ensurePanel(uri);

  panelUri = uri;
  if (current && current.uri.toString() !== uri.toString()) {
    current = undefined;
    clearDecorations();
  }

  target.setSource(uri);
  await contextRef.workspaceState.update(LAST_FILE_KEY, uri.toString());
  target.updateOverview({ file: fileLabel, overview });

  const sourceHash = cache.sourceHash(document.getText());
  const analysisIsStale =
    current !== undefined &&
    current.uri.toString() === uri.toString() &&
    current.sourceHash !== sourceHash;

  target.setStatus(
    analysisIsStale ? 'stale' : 'ready',
    analysisIsStale
      ? 'Overview is current. The analysis is stale; analyze again to refresh the other tabs.'
      : 'Overview from source. Read & Analyze builds the module reading, spotlights and ownership.'
  );
  if (reveal) {
    target.reveal();
  }

  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.toString() === uri.toString()) {
    target.setCursor(editor.selection.active.line + 1);
  }

  if (current && !analysisIsStale) {
    applyValueColors();
  } else {
    clearValueColors();
  }

  void attachBrief(uri, fileLabel, sourceHash);
}

function cancelBrief(): void {
  briefController?.abort();
  briefController = undefined;
  briefTarget = undefined;
}

async function attachBrief(
  uri: vscode.Uri,
  fileLabel: string,
  sourceHash: string
): Promise<void> {
  if (!panel || panelUri?.toString() !== uri.toString() || briefTarget === uri.toString()) {
    return;
  }

  const config = getConfig();
  if (!config.model) {
    panel.updateBrief({ file: fileLabel });
    return;
  }

  let contextRevision = '';
  try {
    contextRevision = (await withTimeout(indexService.currentRevision(uri), 10000)) ?? '';
  } catch (error) {
    output.appendLine(`[index] ${fileLabel}: ${messageOf(error)}`);
  }
  const exact = await briefCache.read(
    briefCache.key(fileLabel, sourceHash, config.model, contextRevision)
  );
  if (!panel || panelUri?.toString() !== uri.toString()) {
    return;
  }

  if (exact && exact.sourceHash === sourceHash) {
    panel.updateBrief({
      file: fileLabel,
      brief: exact.brief,
      stale: false,
      meta: {
        model: exact.model,
        generatedAt: exact.generatedAt,
        usage: exact.usage
      }
    });
    return;
  }

  const latest = await briefCache.readLatestForFile(fileLabel, config.model, sourceHash, uri.toString());
  if (!panel || panelUri?.toString() !== uri.toString()) {
    return;
  }

  if (latest) {
    panel.updateBrief({
      file: fileLabel,
      brief: latest.brief,
      stale:
        latest.sourceHash !== sourceHash ||
        latest.promptVersion !== BRIEF_PROMPT_VERSION ||
        (latest.contextRevision ?? '') !== contextRevision,
      meta: {
        model: latest.model,
        generatedAt: latest.generatedAt,
        usage: latest.usage
      }
    });
  } else {
    panel.updateBrief({ file: fileLabel });
  }
}

async function showIndexPacket(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'rust') {
    vscode.window.showInformationMessage('Derust: open a Rust file first.');
    return;
  }

  try {
    const packet = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Derust — index packet',
        cancellable: false
      },
      async (progress) => {
        progress.report({ message: 'Reading workspace index…' });
        return indexService.getPacket(editor.document.uri);
      }
    );

    if (!packet) {
      vscode.window.showInformationMessage('Derust: no index packet for this file.');
      return;
    }

    const cachePath = indexService.cachePathFor(editor.document.uri);
    const content = [
      '# Derust — index packet',
      '',
      `File: ${packet.file}`,
      `Revision: ${packet.revision}`,
      ...(cachePath ? [`Cache: ${cachePath}`] : []),
      '',
      formatModuleContext(packet)
    ].join('\n');

    const document = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content
    });
    await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: false
    });
  } catch (error) {
    vscode.window.showErrorMessage(`Derust: ${messageOf(error)}`);
  }
}

async function rebuildIndex(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'rust') {
    vscode.window.showInformationMessage('Derust: open a Rust file first.');
    return;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Derust — workspace index',
        cancellable: false
      },
      async (progress) => {
        progress.report({ message: 'Rebuilding…' });
        await indexService.rebuild(editor.document.uri);
      }
    );
    vscode.window.showInformationMessage('Derust: workspace index rebuilt.');
  } catch (error) {
    vscode.window.showErrorMessage(`Derust: ${messageOf(error)}`);
  }
}

async function explainFile(uri: vscode.Uri, force: boolean): Promise<void> {
  if (!panel) {
    return;
  }
  if (!force && briefTarget === uri.toString() && briefController) {
    return;
  }

  let config = getConfig();
  const document = await vscode.workspace.openTextDocument(uri);
  const fileLabel = vscode.workspace.asRelativePath(uri, false);
  const source = document.getText();
  const sourceHash = cache.sourceHash(source);

  // Hide the primary action before the index build, not only before the
  // provider call. Otherwise the button stays active for the whole index wait.
  cancelBrief();
  const controller = new AbortController();
  briefController = controller;
  briefTarget = uri.toString();
  panel.updateBrief({ file: fileLabel, loading: true });
  panel.setStatus('loading', 'Building workspace index…');

  let moduleContext;
  try {
    moduleContext = await withTimeout(indexService.getPacket(uri), 15000);
    if (!moduleContext) {
      output.appendLine(`[index] ${fileLabel}: packet unavailable or timed out`);
      panel.setStatus('loading', 'Workspace index unavailable — writing without it…');
    }
  } catch (error) {
    output.appendLine(`[index] ${fileLabel}: ${messageOf(error)}`);
  }
  if (panelUri?.toString() !== uri.toString()) {
    if (briefController === controller) {
      briefController = undefined;
      briefTarget = undefined;
    }
    return;
  }
  const candidates = moduleContext
    ? buildProfileCandidates(moduleContext, source)
    : undefined;
  const contextRevision = moduleContext?.revision ?? '';
  let key = config.model
    ? briefCache.key(fileLabel, sourceHash, config.model, contextRevision)
    : '';

  if (!force && key) {
    const hit = await briefCache.read(key);
    if (hit) {
      if (briefController === controller) {
        briefController = undefined;
        briefTarget = undefined;
      }
      panel.updateBrief({
        file: fileLabel,
        brief: hit.brief,
        stale: false,
        loading: false,
        meta: {
          model: hit.model,
          generatedAt: hit.generatedAt,
          usage: hit.usage
        }
      });
      panel.setStatus('ready', 'Module reading loaded from cache.');
      return;
    }
  }

  if (!force && config.model) {
    const latest = await briefCache.readLatestForFile(fileLabel, config.model, sourceHash, uri.toString());
    if (
      latest &&
      latest.sourceHash === sourceHash &&
      latest.promptVersion === BRIEF_PROMPT_VERSION &&
      (latest.contextRevision ?? '') === contextRevision
    ) {
      if (briefController === controller) {
        briefController = undefined;
        briefTarget = undefined;
      }
      panel.updateBrief({
        file: fileLabel,
        brief: latest.brief,
        stale: false,
        loading: false,
        meta: {
          model: latest.model,
          generatedAt: latest.generatedAt,
          usage: latest.usage
        }
      });
      panel.setStatus('ready', 'Module reading loaded from cache.');
      return;
    }
  }

  try {
    const provider = await ensureProvider(contextRef);
    if (!provider) {
      throw new Error('Provider setup was cancelled.');
    }
    config = provider.config;
    if (!key && config.model) {
      key = briefCache.key(fileLabel, sourceHash, config.model, contextRevision);
    }
    const apiKey = provider.apiKey;

    const overview = await overviewService.build(document);
    if (panelUri?.toString() !== uri.toString()) {
      return;
    }

    const meta: BriefSourceMeta = {
      file: fileLabel,
      crateName: await readCrateName(uri),
      docs: config.includeDocs ? await readProjectDocs(uri) : '',
      model: config.model,
      sourceHash,
      overview,
      moduleContext,
      candidates
    };

    const settings: ProviderSettings = {
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey,
      jsonMode: config.jsonMode,
      timeoutMs: config.timeoutSeconds * 1000,
      maxTokens: Math.min(config.maxOutputTokens, 12000),
      reasoningEffort: config.reasoningEffort === 'none' ? 'none' : 'low',
      userAgent: `derust/${contextRef.extension.packageJSON.version}`
    };

    panel.updateBrief({ file: fileLabel, loading: true });
    panel.setStatus('loading', `Writing module reading for ${fileLabel}…`);

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Derust — ${path.basename(uri.fsPath)}`,
        cancellable: true
      },
      async (progress, token) => {
        token.onCancellationRequested(() => controller.abort());
        progress.report({ message: 'Writing module reading…' });
        return completeJson(
          BRIEF_SYSTEM_PROMPT,
          buildBriefUserPrompt(source, meta),
          settings,
          controller.signal
        );
      }
    );

    if (controller.signal.aborted) {
      panel.setStatus('ready', 'Module reading cancelled.');
      panel.updateBrief({ file: fileLabel, loading: false });
      return;
    }

    const parsed = parseBriefJson(result.text);
    const { brief, issues } = validateBrief(parsed, source, meta);
    const cached: CachedBrief = {
      brief,
      fileKey: uri.toString(),
      contextRevision,
      sourceHash,
      promptVersion: BRIEF_PROMPT_VERSION,
      model: config.model,
      generatedAt: new Date().toISOString(),
      usage: result.usage,
      issues
    };
    brief.generatedAt = cached.generatedAt;
    await briefCache.write(key, cached);

    const stale = cache.sourceHash(document.getText()) !== sourceHash;

    if (briefTarget === uri.toString() && briefController === controller) {
      panel.updateBrief({
        file: fileLabel,
        brief,
        stale,
        meta: {
          model: config.model,
          generatedAt: cached.generatedAt,
          usage: result.usage
        }
      });
      panel.setStatus(
        'ready',
        stale
          ? 'Module reading ready, but the source changed while it was writing. Refresh it to update the line links.'
          : issues.length > 0
            ? `Module reading ready. ${issues.length} record${issues.length === 1 ? '' : 's'} dropped by validation.`
            : 'Module reading ready.'
      );
    }

    for (const issue of issues.slice(0, 6)) {
      output.appendLine(`[brief] ${fileLabel}: ${issue}`);
    }
  } catch (error) {
    const stillCurrent =
      panelUri?.toString() === uri.toString() && briefController === controller;
    if (stillCurrent) {
      if (controller.signal.aborted) {
        panel.setStatus('ready', 'Module reading cancelled.');
      } else {
        panel.setStatus('error', messageOf(error));
        vscode.window.showErrorMessage(`Derust: ${messageOf(error)}`);
      }
      panel.updateBrief({ file: fileLabel, loading: false });
    }
    output.appendLine(`[brief] ${fileLabel}: ${messageOf(error)}`);
  } finally {
    if (briefController === controller) {
      briefController = undefined;
      briefTarget = undefined;
    }
  }
}

async function clearCache(): Promise<void> {
  briefController?.abort();
  await Promise.all([cache.clear(), briefCache.clear()]);
  vscode.window.showInformationMessage('Derust: analysis and module reading caches cleared.');
}

async function findRustFiles(folder: vscode.Uri): Promise<vscode.Uri[]> {
  const exclude = '**/{target,.git,node_modules,.code-explainer}/**';
  const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.rs'), exclude);
  return found.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
}

async function chooseAndAnalyze(uris: vscode.Uri[]): Promise<void> {
  if (uris.length === 0) {
    vscode.window.showInformationMessage('Derust: no .rs files matched.');
    return;
  }

  const items = uris.map((uri) => ({
    label: vscode.workspace.asRelativePath(uri, false),
    uri,
    picked: true
  }));

  const selected = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: `Analyze Rust files (${uris.length})`,
    placeHolder: 'Select files to analyze'
  });

  if (!selected || selected.length === 0) {
    return;
  }

  const config = getConfig();
  if (selected.length > config.maxFiles) {
    const answer = await vscode.window.showWarningMessage(
      `Analyze ${selected.length} files? Each file can take a few minutes and calls the provider.`,
      { modal: true },
      'Continue'
    );
    if (answer !== 'Continue') {
      return;
    }
  }

  await analyzeMany(selected.map((item) => item.uri));
}

async function analyzeMany(uris: vscode.Uri[]): Promise<void> {
  const config = getConfig();
  const succeeded: vscode.Uri[] = [];
  const failures: string[] = [];
  let completed = 0;
  let cursor = 0;
  const batchController = new AbortController();

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Derust',
      cancellable: true
    },
    async (progress, token) => {
      token.onCancellationRequested(() => batchController.abort());

      const worker = async (): Promise<void> => {
        while (cursor < uris.length) {
          if (token.isCancellationRequested) {
            return;
          }

          const index = cursor;
          cursor += 1;
          const uri = uris[index];

          try {
            const completed = await analyzeUri(uri, {
              force: false,
              showPanel: false,
              progress: false,
              signal: batchController.signal
            });
            if (completed) {
              succeeded.push(uri);
            } else if (!batchController.signal.aborted) {
              const label = vscode.workspace.asRelativePath(uri, false);
              failures.push(`${label}: analysis did not complete`);
            }
          } catch (error) {
            if (batchController.signal.aborted) {
              return;
            }
            const label = vscode.workspace.asRelativePath(uri, false);
            failures.push(`${label}: ${messageOf(error)}`);
            output.appendLine(`[fail] ${label}: ${messageOf(error)}`);
          } finally {
            completed += 1;
            progress.report({
              message: `${completed}/${uris.length} — ${vscode.workspace.asRelativePath(uri, false)}`,
              increment: 100 / uris.length
            });
          }
        }
      };

      const workers = Array.from(
        { length: Math.min(config.concurrency, uris.length) },
        () => worker()
      );
      await Promise.all(workers);
    }
  );

  if (batchController.signal.aborted) {
    vscode.window.showInformationMessage(
      `Derust: cancelled. Completed ${succeeded.length} file${succeeded.length === 1 ? '' : 's'}${
        failures.length > 0 ? `, ${failures.length} failed` : ''
      }.`
    );
    return;
  }

  if (succeeded.length > 0) {
    await analyzeUri(succeeded[0], { force: false, showPanel: true });
  }

  const summary =
    failures.length === 0
      ? `Derust: analyzed ${succeeded.length} file${succeeded.length === 1 ? '' : 's'}.`
      : `Derust: analyzed ${succeeded.length}, failed ${failures.length}.`;

  if (failures.length > 0) {
    output.show(true);
    vscode.window.showWarningMessage(summary);
  } else {
    vscode.window.showInformationMessage(summary);
  }
}

async function analyzeUri(uri: vscode.Uri, options: AnalyzeOptions): Promise<boolean> {
  let config = getConfig();
  const document = await vscode.workspace.openTextDocument(uri);

  if (document.lineCount > config.maxFileLines) {
    throw new Error(
      `${vscode.workspace.asRelativePath(uri, false)} has ${document.lineCount} lines; the configured analysis limit is ${config.maxFileLines}. Increase derust.maxFileLines to analyze it.`
    );
  }

  const text = document.getText();
  const fileLabel = vscode.workspace.asRelativePath(uri, false);
  const docs = config.includeDocs ? await readProjectDocs(uri) : '';
  let key = cache.key(text, config.model, `${fileLabel}\0${docs}`);

  let cached = options.force ? undefined : await cache.read(key);
  if (!cached && !options.force) {
    cached = await cache.readLatestForFile(fileLabel, cache.sourceHash(text), config.model);
  }

  if (!cached) {
    const provider = await ensureProvider(contextRef);
    if (!provider) {
      throw new Error('Provider setup was cancelled.');
    }
    config = provider.config;
    key = cache.key(text, config.model, `${fileLabel}\0${docs}`);
    const apiKey = provider.apiKey;

    const settings: ProviderSettings = {
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey,
      jsonMode: config.jsonMode,
      timeoutMs: config.timeoutSeconds * 1000,
      maxTokens: config.maxOutputTokens,
      reasoningEffort: config.reasoningEffort,
      userAgent: `derust/${contextRef.extension.packageJSON.version}`
    };

    if (options.showPanel) {
      const target = ensurePanel(uri);
      target.setSource(uri);
      target.setStatus('loading', `Analyzing ${fileLabel}…`);
      target.reveal();
    }

    const controller = new AbortController();
    if (options.signal) {
      if (options.signal.aborted) {
        return false;
      }
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    const run = async (): Promise<CachedAnalysis> => {
      const meta: SourceMeta = {
        file: fileLabel,
        crateName: await readCrateName(uri),
        docs,
        model: config.model
      };
      const result = await analyzeSource(text, meta, settings, controller.signal);
      const value: CachedAnalysis = {
        analysis: result.analysis,
        textHash: key,
        sourceHash: cache.sourceHash(text),
        promptVersion: PROMPT_VERSION,
        model: config.model,
        generatedAt: new Date().toISOString(),
        usage: result.usage,
        issues: result.issues
      };
      await cache.write(key, value, result.raw);
      return value;
    };

    try {
      if (options.progress === false) {
        cached = await run();
      } else {
        cached = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Derust — ${path.basename(uri.fsPath)}`,
            cancellable: true
          },
          async (progress, token) => {
            token.onCancellationRequested(() => controller.abort());
            progress.report({ message: 'Building context and calling the provider…' });
            return run();
          }
        );
      }
    } catch (error) {
      if (controller.signal.aborted) {
        if (options.showPanel) {
          panel?.setStatus('ready', 'Analysis cancelled.');
        }
        return false;
      }

      if (options.showPanel) {
        panel?.setStatus('error', messageOf(error));
      }
      output.appendLine(`[error] ${fileLabel}: ${messageOf(error)}`);
      throw error;
    }
  }

  if (!options.showPanel) {
    return true;
  }

  await showAnalysis(uri, fileLabel, cached, config.defaultLayout);
  return true;
}

async function showAnalysis(
  uri: vscode.Uri,
  fileLabel: string,
  cached: CachedAnalysis,
  layout: 'cards' | 'columns',
  reveal = true
): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  const overview = await overviewService.build(document);

  if (
    !reveal &&
    vscode.window.activeTextEditor?.document.uri.toString() !== uri.toString()
  ) {
    return;
  }

  if (panelUri && panelUri.toString() !== uri.toString()) {
    cancelBrief();
  }

  const target = ensurePanel(uri);
  const issues = Array.isArray(cached.issues) ? cached.issues : [];
  const sourceHash = cached.sourceHash || cache.sourceHash(document.getText());

  panelUri = uri;
  current = {
    uri,
    analysis: cached.analysis,
    sourceHash,
    model: cached.model
  };

  target.setSource(uri);
  void contextRef.workspaceState.update(LAST_FILE_KEY, uri.toString());
  target.update({
    file: fileLabel,
    analysis: cached.analysis,
    overview,
    layout,
    meta: {
      model: cached.model,
      generatedAt: cached.generatedAt,
      usage: cached.usage,
      issues
    }
  });
  target.setStatus(
    'ready',
    issues.length > 0
      ? `Ready. ${issues.length} record${issues.length === 1 ? '' : 's'} dropped by validation.`
      : 'Ready.'
  );
  if (reveal) {
    target.reveal();
  }

  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.toString() === uri.toString()) {
    target.setCursor(editor.selection.active.line + 1);
  }

  clearDecorations();
  applyValueColors();

  void attachBrief(uri, fileLabel, sourceHash);
}

async function readCachedForUri(
  uri: vscode.Uri
): Promise<{ cached: CachedAnalysis; fileLabel: string; text: string } | undefined> {
  const document = await vscode.workspace.openTextDocument(uri);
  const text = document.getText();
  const config = getConfig();
  const fileLabel = vscode.workspace.asRelativePath(uri, false);
  const docs = config.includeDocs ? await readProjectDocs(uri) : '';

  const exact = await cache.read(cache.key(text, config.model, `${fileLabel}\0${docs}`));
  if (exact) {
    return { cached: exact, fileLabel, text };
  }

  const fallback = await cache.readLatestForFile(fileLabel, cache.sourceHash(text), config.model);
  return fallback ? { cached: fallback, fileLabel, text } : undefined;
}

async function restoreLastAnalysis(context: vscode.ExtensionContext, force: boolean): Promise<boolean> {
  if (!force && !getConfig().restoreLastAnalysis) {
    return false;
  }

  const stored = context.workspaceState.get<string>(LAST_FILE_KEY);
  let uri: vscode.Uri | undefined;

  if (stored) {
    try {
      uri = vscode.Uri.parse(stored);
    } catch {
      uri = undefined;
    }
  }

  if (!uri) {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'rust') {
      uri = editor.document.uri;
    }
  }

  if (!uri || uri.scheme !== 'file') {
    return false;
  }

  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    return false;
  }

  try {
    const hit = await readCachedForUri(uri);
    if (!hit) {
      const config = getConfig();
      if (!config.model) {
        return false;
      }

      const document = await vscode.workspace.openTextDocument(uri);
      const fileLabel = vscode.workspace.asRelativePath(uri, false);
      const sourceHash = cache.sourceHash(document.getText());
      const latest = await briefCache.readLatestForFile(fileLabel, config.model, sourceHash, uri.toString());
      if (!latest) {
        return false;
      }

      await showStructuralOverview(uri, true);
      return true;
    }

    await showAnalysis(uri, hit.fileLabel, hit.cached, getConfig().defaultLayout);

    if (cache.sourceHash(hit.text) !== hit.cached.sourceHash) {
      panel?.setStatus('stale', 'File changed since this analysis. Analyze again to refresh.');
    }

    return true;
  } catch (error) {
    output.appendLine(`[restore] ${messageOf(error)}`);
    return false;
  }
}

function switchPanelView(view: PanelView): void {
  if (view === 'project') {
    if (ArchitecturePanel.reactivate()) {
      return;
    }
    void vscode.commands.executeCommand('derust.analyzeArchitecture');
    return;
  }
  if (panel && !panel.isDisposed) {
    panel.activate();
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.languageId === 'rust') {
    void showOverview(editor.document.uri);
    return;
  }
  void vscode.window.showInformationMessage(
    'Derust: open a Rust file and run Read & Analyze to see its reading.'
  );
}

function ensurePanel(uri: vscode.Uri): ReaderPanel {
  if (panel?.isDisposed) {
    panel = undefined;
  }

  if (!panel) {
    panel = ReaderPanel.create(contextRef, uri, {
      onReveal: (start, end) => void revealRange(start, end),
      onAnalyze: (force) => {
        const target = panelUri ?? current?.uri;
        if (target) {
          void readAndAnalyzeFile(target, force);
        }
      },
      onScrolled: (line) => revealLineFromWebview(line)
    });
    contextRef.subscriptions.push(panel);
  }

  return panel;
}

async function revealRange(start: number, end: number): Promise<void> {
  const uri = panelUri ?? current?.uri;
  if (!uri) {
    return;
  }

  ignoreEditorScrollUntil = Date.now() + 250;
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, {
    viewColumn: vscode.ViewColumn.One,
    preserveFocus: false
  });

  const startLine = Math.max(0, Math.min(start - 1, document.lineCount - 1));
  const endLine = Math.max(startLine, Math.min(end - 1, document.lineCount - 1));
  const range = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).range.end.character);

  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  editor.setDecorations(activeDecoration, [range]);
  applyValueColors();
}


async function readAndAnalyzeFile(uri: vscode.Uri, force: boolean): Promise<void> {
  if (!force && briefTarget === uri.toString() && briefController) {
    return;
  }
  const target = ensurePanel(uri);
  panelUri = uri;
  target.setSource(uri);
  target.reveal();

  await explainFile(uri, force);

  try {
    await analyzeUri(uri, { force, showPanel: true });
  } catch (error) {
    vscode.window.showErrorMessage(`Derust: ${messageOf(error)}`);
  }
}

async function runAnalyze(uri: vscode.Uri, options: AnalyzeOptions): Promise<void> {
  try {
    await analyzeUri(uri, options);
  } catch (error) {
    vscode.window.showErrorMessage(`Derust: ${messageOf(error)}`);
  }
}

function handleSelection(event: vscode.TextEditorSelectionChangeEvent): void {
  if (!panel || !panelUri) {
    return;
  }

  if (event.textEditor.document.uri.toString() !== panelUri.toString()) {
    return;
  }

  const line = event.selections[0]?.active.line;
  if (line === undefined) {
    return;
  }

  if (selectionTimer) {
    clearTimeout(selectionTimer);
  }

  selectionTimer = setTimeout(() => {
    panel?.setCursor(line + 1);
  }, 80);
}

function handleDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
  if (!event.document.uri.path.endsWith('.rs') || event.contentChanges.length === 0) {
    return;
  }

  if (changeTimer) {
    clearTimeout(changeTimer);
  }

  changeTimer = setTimeout(() => {
    overviewLens?.refresh();

    if (!panel || !panelUri || panelUri.toString() !== event.document.uri.toString()) {
      return;
    }

    if (current && current.uri.toString() === event.document.uri.toString()) {
      const nextHash = cache.sourceHash(event.document.getText());
      if (nextHash !== current.sourceHash) {
        const editor = vscode.window.visibleTextEditors.find(
          (candidate) => candidate.document.uri.toString() === event.document.uri.toString()
        );
        if (editor) {
          clearValueColors(editor);
        }
        panel.setStatus('stale', 'File changed. Analyze again to refresh.');
      }
    }

    void refreshOverview(event.document);
  }, 250);
}

async function refreshOverview(document: vscode.TextDocument): Promise<void> {
  if (!panel || !panelUri || panelUri.toString() !== document.uri.toString()) {
    return;
  }

  const version = document.version;

  try {
    const overview = await overviewService.build(document);
    if (
      !panel ||
      !panelUri ||
      panelUri.toString() !== document.uri.toString() ||
      document.version !== version
    ) {
      return;
    }

    panel.updateOverview({
      file: vscode.workspace.asRelativePath(document.uri, false),
      overview
    });

    if (!current || current.uri.toString() !== document.uri.toString()) {
      panel.setStatus(
        'ready',
        'Overview from source. Read & Analyze builds the module reading, spotlights and ownership.'
      );
    }

    void attachBrief(
      document.uri,
      vscode.workspace.asRelativePath(document.uri, false),
      cache.sourceHash(document.getText())
    );
  } catch (error) {
    output.appendLine(`[overview] ${messageOf(error)}`);
  }
}

function handleActiveEditor(editor: vscode.TextEditor | undefined): void {
  if (panel?.isDisposed) {
    panel = undefined;
  }

  if (!editor || !panel || editor.document.languageId !== 'rust') {
    return;
  }

  const uri = editor.document.uri;

  if (panelUri?.toString() === uri.toString()) {
    panel.setCursor(editor.selection.active.line + 1);
    if (current) {
      if (current.sourceHash === cache.sourceHash(editor.document.getText())) {
        applyValueColors();
      } else {
        clearValueColors(editor);
      }
    }
    return;
  }

  void (async () => {
    try {
      const hit = await readCachedForUri(uri);
      if (vscode.window.activeTextEditor?.document.uri.toString() !== uri.toString()) {
        return;
      }

      if (hit) {
        await showAnalysis(uri, hit.fileLabel, hit.cached, getConfig().defaultLayout, false);
      } else {
        await showStructuralOverview(uri, false);
      }
      applyValueColors();
    } catch (error) {
      output.appendLine(`[follow] ${messageOf(error)}`);
    }
  })();
}

function handleVisibleRanges(event: vscode.TextEditorVisibleRangesChangeEvent): void {
  if (Date.now() < ignoreEditorScrollUntil) {
    return;
  }

  if (!panel || !panelUri) {
    return;
  }

  if (event.textEditor.document.uri.toString() !== panelUri.toString()) {
    return;
  }

  const topLine = event.visibleRanges[0]?.start.line;
  if (topLine === undefined) {
    return;
  }

  if (visibleRangesTimer) {
    clearTimeout(visibleRangesTimer);
  }

  visibleRangesTimer = setTimeout(() => {
    panel?.setScrollLine(topLine + 1);
  }, 60);
}

function revealLineFromWebview(line: number): void {
  const uri = panelUri ?? current?.uri;
  if (!uri) {
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.toString() !== uri.toString()) {
    return;
  }

  const target = Math.max(0, Math.min(line - 1, editor.document.lineCount - 1));
  ignoreEditorScrollUntil = Date.now() + 250;
  editor.revealRange(
    new vscode.Range(target, 0, target, 0),
    vscode.TextEditorRevealType.AtTop
  );
}

function clearDecorations(): void {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    editor.setDecorations(activeDecoration, []);
    editor.setDecorations(pinnedDecoration, []);
  }
  clearValueColors();
}

function valueColorIndex(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return hash % MEMORY_COLORS.length;
}

function clearValueColors(editor?: vscode.TextEditor): void {
  const editors = editor ? [editor] : vscode.window.visibleTextEditors;
  for (const target of editors) {
    for (const type of valueDecorations) {
      target.setDecorations(type, []);
    }
  }
}

function applyValueColors(): void {
  clearValueColors();

  const editor = vscode.window.activeTextEditor;
  if (
    !editor ||
    !current ||
    editor.document.uri.toString() !== current.uri.toString() ||
    !getConfig().colorCode
  ) {
    return;
  }

  const ranges = MEMORY_COLORS.map(() => [] as vscode.Range[]);
  const text = editor.document.getText();

  for (const record of current.analysis.memory || []) {
    for (const value of record.values || []) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.name)) {
        continue;
      }

      const colorIndex = valueColorIndex(value.id);
      const startLine = Math.max(0, Math.min(editor.document.lineCount - 1, value.start - 1));
      const endLine = Math.max(startLine, Math.min(editor.document.lineCount - 1, value.end - 1));
      const startOffset = editor.document.offsetAt(new vscode.Position(startLine, 0));
      const endOffset = editor.document.offsetAt(
        new vscode.Position(endLine, editor.document.lineAt(endLine).text.length)
      );
      const segment = text.slice(startOffset, endOffset);
      const pattern = new RegExp(`\\b${escapeRegExp(value.name)}\\b`, 'g');
      let match: RegExpExecArray | null;

      while ((match = pattern.exec(segment)) !== null) {
        const from = editor.document.positionAt(startOffset + match.index);
        const to = editor.document.positionAt(startOffset + match.index + match[0].length);
        ranges[colorIndex].push(new vscode.Range(from, to));
      }
    }
  }

  valueDecorations.forEach((type, index) => editor.setDecorations(type, ranges[index]));
}

function withTimeout<T>(promise: Thenable<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    Promise.resolve(promise).catch(() => undefined),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))
  ]);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function readProjectDocs(uri: vscode.Uri): Promise<string> {
  const base =
    crateRoot(uri) ??
    vscode.workspace.getWorkspaceFolder(uri)?.uri ??
    vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!base) {
    return '';
  }

  const names = ['DESIGN.md', 'README.md', 'Cargo.toml'];
  let combined = '';

  for (const name of names) {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(base, name));
      const text = new TextDecoder().decode(bytes);
      combined += `\n# ${name}\n${text}`;
    } catch {
      // Missing files are expected; keep the context small.
    }
  }

  return combined.slice(0, 8000);
}
