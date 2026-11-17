'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { FlowModel } = require('./src/model');
const { createNodeIO } = require('./src/nodeio');
const { findProjectRoots } = require('./src/project');
const { importAliases, boxIdOf } = require('./src/aliases');
const dbtrun = require('./src/dbtrun');

const COLUMN_AT_CURSOR = /[A-Za-z_][A-Za-z0-9_$]*/;

/** Integrations that have a canvas add-on in media/integrations/<id>.js (and maybe .css). */
function integrationUis(extensionPath) {
  try {
    const names = require('./src/integrations');
    return names
      .filter((n) => /^[a-z][a-z0-9-]*$/.test(n))
      .map((n) => ({
        id: n,
        js: fs.existsSync(path.join(extensionPath, 'media', 'integrations', `${n}.js`)),
        css: fs.existsSync(path.join(extensionPath, 'media', 'integrations', `${n}.css`)),
      }))
      .filter((u) => u.js);
  } catch {
    return [];
  }
}

const PANEL_TYPE = 'nodeviz.panel';
const STARTUP_DELAY_MS = 500;
const FOLDER_RE = /^[\w-]+(\/[\w-]+)*$/;

// ------------------------------------------------------------ settings

// Settings were called dbtFlow.* up to 0.3.0. Old values still count.
const SECTION = 'nodeviz';
const LEGACY_SECTION = 'dbtFlow';
const SETTING_KEYS = [
  'openOnStartup', 'projectPath', 'confirmFileEdits', 'openCreatedFile', 'addToModelsYml',
  'dbt.executable', 'dbt.target', 'dbt.envFile',
  'integrations.dagtracer.enabled', 'integrations.dagtracer.executable', 'integrations.dagtracer.timeoutSeconds',
];

/** The value the user set for `key` in `cfg` (folder, workspace or user settings), if any. */
function userValue(cfg, key) {
  const i = typeof cfg.inspect === 'function' ? cfg.inspect(key) : null;
  if (!i) return { set: false };
  for (const v of [i.workspaceFolderValue, i.workspaceValue, i.globalValue]) {
    if (v !== undefined) return { set: true, value: v };
  }
  return { set: false };
}

/**
 * NodeViz settings: a nodeviz.* value the user set wins, then an old dbtFlow.*
 * value, then the default from package.json.
 */
function settings() {
  const now = vscode.workspace.getConfiguration(SECTION);
  const old = vscode.workspace.getConfiguration(LEGACY_SECTION);
  return {
    get(key) {
      if (!userValue(now, key).set) {
        const o = userValue(old, key);
        if (o.set) return o.value;
      }
      return now.get(key);
    },
    update: (key, value, target) => now.update(key, value, target),
  };
}

/** Old dbtFlow.* settings the user still has, e.g. ['dbtFlow.dbt.executable']. */
function legacySettingsInUse() {
  const old = vscode.workspace.getConfiguration(LEGACY_SECTION);
  return SETTING_KEYS.filter((k) => userValue(old, k).set).map((k) => `${LEGACY_SECTION}.${k}`);
}

/** " and added it to _marts__models.yml", or '' when no .yml was touched. */
const ymlNote = (r) => (r && r.yml && r.yml.length ? ` and added ${r.yml.length > 1 ? 'them' : 'it'} to ${r.yml.join(', ')}` : '');

const affectsSetting = (e, key) =>
  e.affectsConfiguration(`${SECTION}.${key}`) || e.affectsConfiguration(`${LEGACY_SECTION}.${key}`);

class Controller {
  constructor(context) {
    this.context = context;
    this.surfaces = new Set(); // { webview, kind: 'view' | 'panel', panel? }
    this.panel = null;
    this.model = null;
    this.io = createNodeIO((abs) =>
      vscode.workspace.textDocuments.some((d) => d.isDirty && d.uri.fsPath === abs)
    );
    this.refreshTimer = null;
    this.integrations = null; // IntegrationHost, or null if it could not start
    this.integrationChannels = new Map(); // integration id -> output channel
    this.integrationResults = new Map(); // "<id>/result" -> last result, replayed to a canvas that opens later
    this.dbtTerminal = null; // the "NodeViz" terminal dbt commands are typed into
    this.dbtTerminalRoot = null; // the folder that terminal is in
  }

  // ------------------------------------------------------------ project

  loadProject(forceRoot) {
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    if (!folders.length) {
      this.model = null;
      return;
    }
    let root = forceRoot;
    if (!root) {
      const configured = settings().get('projectPath');
      if (configured) {
        root = path.isAbsolute(configured) ? configured : path.join(folders[0], configured);
      }
    }
    if (!root) {
      const roots = findProjectRoots(folders, this.io);
      const ws = this.context.workspaceState;
      const remembered = ws.get('nodeviz.root') || ws.get('dbtFlow.root');
      root = roots.includes(remembered) ? remembered : roots[0] || folders[0];
      this.roots = roots;
    }
    this.model = new FlowModel(this.io);
    this.model.open(root);
    if (this.model.loadError) vscode.window.showWarningMessage(`NodeViz: ${this.model.loadError}`);
  }

  /** True when the workspace has a dbt_project.yml (3 folders deep at most), or a project folder is set. */
  workspaceHasProject() {
    if (settings().get('projectPath')) return true;
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    return folders.length > 0 && findProjectRoots(folders, this.io).length > 0;
  }

  async selectProject() {
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    const roots = findProjectRoots(folders, this.io);
    if (!roots.length) {
      vscode.window.showInformationMessage('NodeViz found no dbt_project.yml in this workspace.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      roots.map((r) => ({ label: path.basename(r), description: r, root: r })),
      { placeHolder: 'Which dbt project should NodeViz show?' }
    );
    if (!pick) return;
    await this.context.workspaceState.update('nodeviz.root', pick.root);
    this.loadProject(pick.root);
    this.broadcast();
  }

  scheduleRefresh(stateFile = false) {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      if (!this.model) return this.loadProject(), this.broadcast();
      if (stateFile && this.model.stateChangedOnDisk()) this.model.open(this.model.cfg.root);
      else this.model.refresh();
      this.broadcast();
    }, 200);
  }

  broadcast() {
    const view = this.model ? this.model.getView() : null;
    for (const s of this.surfaces) s.webview.postMessage({ type: 'graph', view });
    this.postActiveFile();
  }

  postActiveFile() {
    const ed = vscode.window.activeTextEditor;
    let id = null;
    if (ed && this.model) {
      const fsPath = ed.document.uri.fsPath;
      for (const n of this.model.nodes.values()) if (n.abs === fsPath && n.kind === 'model') id = n.id;
    }
    for (const s of this.surfaces) s.webview.postMessage({ type: 'activeFile', id });
  }

  // ------------------------------------------------------------ webviews

  attach(webview, kind, panel) {
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const layoutRoot = vscode.Uri.joinPath(this.context.extensionUri, 'src');
    webview.options = { enableScripts: true, localResourceRoots: [media, layoutRoot] };
    const layoutJs = webview.asWebviewUri(vscode.Uri.joinPath(layoutRoot, 'layout.js'));
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.js'));
    // Integration add-ons load before main.js, which starts them (see "integrations" in main.js).
    const uis = integrationUis(this.context.extensionUri.fsPath);
    const uiUri = (id, ext) => webview.asWebviewUri(vscode.Uri.joinPath(media, 'integrations', `${id}.${ext}`));
    const uiCss = uis.filter((u) => u.css).map((u) => `\n<link href="${uiUri(u.id, 'css')}" rel="stylesheet">`).join('');
    const uiJs = uis.map((u) => `<script nonce="${nonce}" src="${uiUri(u.id, 'js')}"></script>\n`).join('');
    webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${css}" rel="stylesheet">${uiCss}
<title>NodeViz</title>
</head>
<body data-surface="${kind}">
<div id="app"></div>
<script nonce="${nonce}" src="${layoutJs}"></script>
${uiJs}<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
    const surface = { webview, kind, panel };
    this.surfaces.add(surface);
    const sub = webview.onDidReceiveMessage((msg) =>
      this.handle(msg, surface).catch((e) => vscode.window.showErrorMessage(`NodeViz: ${e.message}`))
    );
    return {
      dispose: () => {
        sub.dispose();
        this.surfaces.delete(surface);
      },
    };
  }

  /**
   * Opens the canvas as an editor tab in the group to the right of the code,
   * so Explorer, the file and the canvas are all visible at once.
   * On startup it opens without taking focus from the file.
   */
  openPanel({ preserveFocus = false } = {}) {
    if (this.panel) {
      this.panel.reveal(undefined, preserveFocus);
      return;
    }
    const ed = vscode.window.activeTextEditor;
    const column = ed && ed.viewColumn ? ed.viewColumn + 1 : vscode.ViewColumn.Two;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel(
      PANEL_TYPE,
      'NodeViz',
      { viewColumn: column, preserveFocus },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] }
    );
    panel.iconPath = {
      dark: vscode.Uri.joinPath(media, 'icon.svg'),
      light: vscode.Uri.joinPath(media, 'icon-light.svg'),
    };
    const handle = this.attach(panel.webview, 'panel', panel);
    this.panel = panel;
    panel.onDidDispose(() => {
      handle.dispose();
      this.panel = null;
    });
  }

  // ------------------------------------------------------------ integrations

  /**
   * Starts the optional integrations (DAGtracer, ...). See docs/ARCHITECTURE.md.
   * If anything here fails, integrations stay off and the canvas works as before.
   */
  startIntegrations() {
    try {
      const { IntegrationHost } = require('./src/host/integrationHost');
      const names = require('./src/integrations');
      this.integrations = new IntegrationHost({
        projectRoot: () => (this.model && this.model.cfg ? this.model.cfg.root : null),
        view: () => (this.model ? this.model.getView() : null),
        post: (msg) => {
          if (/^[a-z][a-z0-9-]*\/result$/.test(msg.type)) this.integrationResults.set(msg.type, msg);
          for (const s of this.surfaces) s.webview.postMessage(msg);
        },
        setting: (id, key) => settings().get(`integrations.${id}.${key}`),
        ask: (o) =>
          vscode.window.showInputBox({ prompt: o.prompt, placeHolder: o.placeHolder, value: o.value, validateInput: o.validate }),
        pick: (o) => this.pickWithTyping(o),
        logger: (id, title) => {
          if (typeof vscode.window.createOutputChannel !== 'function') return () => {};
          let ch = this.integrationChannels.get(id);
          if (!ch) {
            ch = vscode.window.createOutputChannel(`NodeViz: ${title}`);
            this.integrationChannels.set(id, ch);
            this.context.subscriptions.push(ch);
          }
          return (line) => ch.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);
        },
      }).load(names);
      this.integrations.start().catch(() => {});
    } catch (e) {
      this.integrations = null;
      console.error(`NodeViz: integrations are off (${e.message})`);
    }
  }

  /** Re-checks every integration and lists them; picking one opens its log. */
  async checkIntegrations() {
    if (!this.integrations) {
      vscode.window.showWarningMessage('NodeViz: integrations could not be started. See Help → Toggle Developer Tools → Console.');
      return;
    }
    const list = await this.integrations.recheck();
    const icons = { ready: '$(pass)', missing: '$(circle-slash)', incompatible: '$(warning)', failed: '$(error)', disabled: '$(debug-pause)' };
    const items = list.map((s) => ({
      label: `${icons[s.state] || '$(question)'} ${s.title}`,
      description: s.state + (s.version ? ` · ${s.version}` : ''),
      detail: s.reason || undefined,
      id: s.id,
    }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'NodeViz integrations. Pick one to open its log.' });
    const ch = pick && this.integrationChannels.get(pick.id);
    if (ch) ch.show(true);
  }

  /**
   * A quick pick that also accepts a typed value that is not in the list,
   * e.g. a column the catalog does not know yet. Resolves the label or undefined.
   */
  pickWithTyping({ title, placeHolder, items = [], allowTyped = false }) {
    return new Promise((resolve) => {
      const qp = vscode.window.createQuickPick();
      const base = items.map((i) => ({ label: i.label, description: i.description || '' }));
      qp.title = title;
      qp.placeholder = placeHolder;
      qp.items = base;
      if (allowTyped) {
        qp.onDidChangeValue((v) => {
          const typed = v.trim();
          const known = base.some((i) => i.label.toLowerCase() === typed.toLowerCase());
          qp.items = typed && !known && COLUMN_AT_CURSOR.test(typed) ? [{ label: typed, description: 'not in the catalog' }, ...base] : base;
        });
      }
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        qp.dispose();
        resolve(value);
      };
      qp.onDidAccept(() => finish(qp.selectedItems[0] ? qp.selectedItems[0].label : undefined));
      qp.onDidHide(() => finish(undefined));
      qp.show();
    });
  }

  /**
   * Right-click on a column in a model's SQL → Trace Column. For `prep1.order_id`
   * the trace starts at the model behind `prep1` (an import CTE or an alias of
   * ref()); otherwise at the model the file belongs to.
   */
  async traceColumnAtCursor() {
    const ed = vscode.window.activeTextEditor;
    if (!ed || !this.model) return;
    if (!this.integrations || !this.integrations.isReady('dagtracer')) {
      vscode.window.showWarningMessage('NodeViz: DAGtracer is not ready. Run "NodeViz: Check Integrations" to see why.');
      return;
    }
    const doc = ed.document;
    const range = doc.getWordRangeAtPosition(ed.selection.active, COLUMN_AT_CURSOR);
    if (!range) {
      vscode.window.showInformationMessage('NodeViz: put the cursor on a column name, then Trace Column.');
      return;
    }
    const line = doc.lineAt(range.start.line).text;
    let column = doc.getText(range);
    let qualifier = null;
    const after = /^\.([A-Za-z_][A-Za-z0-9_$]*)/.exec(line.slice(range.end.character));
    const before = /([A-Za-z_][A-Za-z0-9_$]*)\.$/.exec(line.slice(0, range.start.character));
    if (after) {
      // The cursor is on "prep1" in "prep1.order_id": trace order_id.
      qualifier = column;
      column = after[1];
    } else if (before) {
      qualifier = before[1];
    }
    const own = [...this.model.nodes.values()].find((n) => n.abs === doc.uri.fsPath && n.kind === 'model');
    if (!own) {
      vscode.window.showInformationMessage('NodeViz: this file is not a model in the open dbt project.');
      return;
    }
    let start = own.id;
    if (qualifier) {
      const dep = importAliases(doc.getText()).get(qualifier.toLowerCase());
      if (dep && this.model.nodes.has(boxIdOf(dep))) start = boxIdOf(dep);
    }
    this.openPanel({ preserveFocus: true });
    await this.integrations.handle({ type: 'dagtracer/traceBox', id: start, column });
  }

  // ------------------------------------------------------------ messages

  report(result, successMessage) {
    if (!result) return;
    if (result.ok === false && result.message && !result.quiet) {
      vscode.window.showWarningMessage(result.message);
    } else if (result.ok !== false && successMessage) {
      vscode.window.setStatusBarMessage(`NodeViz: ${successMessage}`, 4000);
    }
    this.broadcast();
  }

  async handle(msg, surface) {
    if (msg.type === 'ready') {
      if (!this.model) this.loadProject();
      this.broadcast();
      if (this.integrations) this.integrations.announce();
      surface.webview.postMessage({ type: 'dbtCommands', project: dbtrun.PROJECT_COMMANDS, box: dbtrun.BOX_COMMANDS });
      // A canvas that opens after a trace finished still shows it.
      for (const r of this.integrationResults.values()) surface.webview.postMessage(r);
      return;
    }
    if (msg.type === 'integrationForget') {
      this.integrationResults.delete(`${msg.id}/result`);
      return;
    }
    // "<integration>/<action>" goes to the integration host, which never throws.
    if (typeof msg.type === 'string' && msg.type.includes('/')) {
      if (this.integrations) await this.integrations.handle(msg);
      return;
    }
    const m = this.model;
    if (!m) return;

    switch (msg.type) {
      case 'createBoxAt': {
        const name = await this.askName('Name of the new model', '');
        if (!name) return;
        const place = await this.pickFolder(name);
        if (!place) return;
        return this.report(m.createBox(name, place, msg.x, msg.y));
      }
      case 'planMissing': {
        const place = await this.pickFolder(msg.id);
        if (!place) return;
        const n = m.getView().nodes.find((x) => x.id === msg.id);
        return this.report(m.createBox(msg.id, place, n ? n.x : 0, n ? n.y : 0));
      }
      case 'rename': {
        const node = m.nodes.get(msg.id);
        if (!node) return;
        const name = await this.askName(`Rename ${msg.id}`, msg.id, msg.id);
        if (!name || name === msg.id) return;
        if (node.kind === 'planned') return this.report(m.renameBox(msg.id, name));
        return this.renameModel(msg.id, name);
      }
      case 'retarget':
        return this.retarget(msg.id);
      case 'removeRefs':
        return this.removeRefs(msg.id);
      case 'changeFolder': {
        const place = await this.pickFolder(msg.id, true);
        if (!place) return;
        return this.report(m.setFolder(msg.id, place));
      }
      case 'deleteBox':
        return this.report(m.deleteBox(msg.id));
      case 'removeFromCanvas':
        return this.report(m.removeFromCanvas(msg.id));
      case 'showHidden':
        return this.report(m.showHidden(), 'Removed boxes are back on the canvas');
      case 'move':
        return this.report(m.moveNode(msg.id, msg.x, msg.y));
      case 'tidy':
        return this.report(m.tidy(), 'Layout tidied. Undo puts it back.');
      case 'setDirection': {
        const r = m.setDirection(msg.direction);
        this.report(r);
        for (const s of this.surfaces) s.webview.postMessage({ type: 'fit' });
        return;
      }
      case 'sync': {
        const r = m.syncFromFiles();
        this.report(r);
        for (const s of this.surfaces) s.webview.postMessage({ type: 'synced', summary: r.summary });
        return;
      }
      case 'undo':
      case 'redo': {
        const r = msg.type === 'undo' ? m.undo() : m.redo();
        this.report(r, r.ok ? r.message : null);
        if (r.ok) {
          for (const s of this.surfaces) s.webview.postMessage({ type: 'stepped', verb: r.verb, label: r.label, next: r.next });
        }
        return;
      }
      case 'refresh':
        m.refresh();
        return this.broadcast();
      case 'connect':
        return this.connect(msg.from, msg.to);
      case 'disconnect': {
        const r = m.disconnect(msg.from, msg.to);
        if (r.fileEdge) {
          const choice = await vscode.window.showInformationMessage(r.message, 'Open file');
          if (choice) this.openFile(msg.to, surface);
          return;
        }
        return this.report(r);
      }
      case 'open':
        return this.openFile(msg.id, surface);
      case 'openRel': {
        const abs = path.resolve(m.cfg.root, msg.rel);
        if (path.relative(m.cfg.root, abs).startsWith('..')) return;
        return this.openPath(abs, surface);
      }
      case 'createFile': {
        const r = m.createFiles([msg.id], { modelsYml: settings().get('addToModelsYml') });
        this.report(r, `Created ${msg.id}.sql${ymlNote(r)}`);
        if (r.ok && settings().get('openCreatedFile')) {
          this.openFile(msg.id, surface);
        }
        return;
      }
      case 'createAll': {
        const ids = m.getView().nodes.filter((n) => n.kind === 'planned').map((n) => n.id);
        const r = m.createFiles(ids, { modelsYml: settings().get('addToModelsYml') });
        return this.report(r, r.ok ? `Created ${ids.length} file${ids.length > 1 ? 's' : ''}${ymlNote(r)}` : null);
      }
      case 'selectProject':
        return this.selectProject();
      case 'dbt':
        return this.runDbt(msg.command, msg.id || null);
    }
  }

  // ------------------------------------------------------------ dbt

  /**
   * Types a dbt command into the "NodeViz" terminal, the same line you would type
   * yourself. With a box id it runs that box and everything upstream of it
   * (`--select +mart`); without, the whole project. Unsaved files are saved first,
   * so dbt runs what the editor shows. See src/dbtrun.js.
   */
  async runDbt(command, id) {
    const m = this.model;
    if (!m || !m.cfg) return;
    const node = id ? m.nodes.get(id) : null;
    if (id && !node) return;
    const config = settings();
    const plan = dbtrun.planDbt({
      command,
      node: node && { id: node.id, name: node.name, kind: node.kind },
      executable: config.get('dbt.executable'),
      target: config.get('dbt.target'),
    });
    if (!plan.ok) {
      vscode.window.showWarningMessage(`NodeViz: ${plan.message}`);
      return;
    }
    if (vscode.workspace.saveAll) await vscode.workspace.saveAll(false);
    const term = this.dbtTerminalFor(m.cfg.root, config.get('dbt.envFile'));
    term.show(true);
    term.sendText(plan.line);
  }

  /** The "NodeViz" terminal in the project folder, made (and given the env file) once. */
  dbtTerminalFor(root, envFile) {
    let term = this.dbtTerminal;
    if (term && term.exitStatus === undefined) {
      if (this.dbtTerminalRoot !== root) {
        term.sendText(`cd ${dbtrun.shellWord(root)}`);
        this.dbtTerminalRoot = root;
      }
      return term;
    }
    term = vscode.window.createTerminal({ name: 'NodeViz', cwd: root });
    const env = dbtrun.envFileLine(envFile);
    if (env) term.sendText(env);
    this.dbtTerminal = term;
    this.dbtTerminalRoot = root;
    return term;
  }

  /** Command palette: pick a dbt command for the whole project. */
  async pickDbtCommand() {
    if (!this.model) return;
    const items = dbtrun.PROJECT_COMMANDS.filter((c) => c !== '-').map((c) => ({ label: `dbt ${c.command}`, description: c.hint, command: c.command }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Run a dbt command on the whole project' });
    if (pick) await this.runDbt(pick.command, null);
  }

  /**
   * Dragging from a box's right-hand (or bottom) dot onto another box means
   * "the other box reads from this one". The question says that in words, offers
   * to swap, and asks first (even with confirmFileEdits off) when the connection
   * looks reversed, e.g. an existing model reading from a box with no file yet.
   */
  async connect(from, to) {
    const m = this.model;
    const plan = m.planConnect(from, to);
    if (!plan.ok) return this.report(plan);
    const config = settings();
    // A file changes now (fileEdit) or when the box without a file is created.
    const editsFile = plan.fileEdit || (plan.from.kind === 'planned' && plan.to.kind === 'model');
    if (plan.suspect || (editsFile && config.get('confirmFileEdits'))) {
      const choice = await this.askConnect(plan, m.planConnect(to, from).ok);
      if (choice === 'swap') {
        return this.report(m.connect(to, from), `Connected: ${plan.from.name} reads from ${plan.to.name}`);
      }
      if (!choice) return this.broadcast();
      if (choice === 'always') await config.update('confirmFileEdits', false, vscode.ConfigurationTarget.Global);
    }
    const r = m.connect(from, to);
    this.report(r, `Connected: ${plan.to.name} reads from ${plan.from.name}${r.moved ? ` (moved ${plan.to.name} next to it)` : ''}`);
  }

  /** The connect question. Resolves 'add', 'swap', 'always' or undefined (cancel). */
  async askConnect(plan, canSwap) {
    const { from, to } = plan;
    const expr = from.kind === 'source' ? `{{ source('${from.source}', '${from.table}') }}` : `{{ ref('${from.name}') }}`;
    const reader = to.rel ? path.basename(to.rel) : to.name;
    const what = plan.fileEdit
      ? `Adds ${expr} to ${to.rel} as an import CTE at the top of the file. Undo in NodeViz takes it out again.`
      : to.kind === 'model'
        ? `${from.name} has no file yet. When you create it, ${expr} is added to ${to.rel}.`
        : `${to.name} has no file yet; the ref is written when you create it.`;
    const swapLine = canSwap ? `\n\nSwap direction: ${from.name} reads from ${to.name} instead.` : '';
    const detail = (plan.suspect ? `This looks reversed. ${plan.suspect}\n\n` : '') + what + swapLine;
    const add = plan.fileEdit ? 'Add ref' : 'Connect';
    const swap = 'Swap direction';
    const always = 'Add, and stop asking';
    const buttons = plan.suspect
      ? [...(canSwap ? [swap] : []), add]
      : [add, ...(canSwap ? [swap] : []), ...(plan.fileEdit ? [always] : [])];
    const choice = await vscode.window.showInformationMessage(
      `${reader} will read from ${from.name}.`,
      { modal: true, detail },
      ...buttons
    );
    return { [add]: 'add', [swap]: 'swap', [always]: 'always' }[choice];
  }

  /** Asks before rewriting other files when refs point at the renamed model. */
  async confirmRefEdits(question, files) {
    const config = settings();
    if (!files.length || !config.get('confirmFileEdits')) return true;
    const list = files.slice(0, 8).join('\n') + (files.length > 8 ? `\n…and ${files.length - 8} more` : '');
    const choice = await vscode.window.showInformationMessage(
      question,
      { modal: true, detail: `${list}\n\nUndo in NodeViz changes them back.` },
      'Update refs'
    );
    return !!choice;
  }

  async renameModel(id, newName) {
    const m = this.model;
    const files = m.referencingFiles(id, m.absPath(id)).map((f) => f.rel);
    const ok = await this.confirmRefEdits(
      `Rename ${id} to ${newName} and update ref('${id}') in ${files.length} file${files.length === 1 ? '' : 's'}?`,
      files
    );
    if (!ok) return this.broadcast();
    const wasOpen = vscode.workspace.textDocuments.some((d) => d.uri.fsPath === m.absPath(id));
    const r = m.renameModel(id, newName);
    this.report(r, `Renamed ${id} to ${newName}`);
    if (r.ok && wasOpen) await this.openPath(r.newAbs, this.panelSurface());
  }

  /** For a red box: point every ref() to it at an existing model instead. */
  async retarget(missingId) {
    const m = this.model;
    const models = [...m.nodes.values()].filter((n) => n.kind === 'model').map((n) => n.name).sort();
    const pick = await vscode.window.showQuickPick(models, {
      placeHolder: `Which model should ref('${missingId}') point to?`,
    });
    if (!pick) return;
    const files = m.referencingFiles(missingId).map((f) => f.rel);
    const ok = await this.confirmRefEdits(`Change ref('${missingId}') to ref('${pick}') in ${files.length} file${files.length === 1 ? '' : 's'}?`, files);
    if (!ok) return;
    this.report(m.retargetRefs(missingId, pick), `ref('${missingId}') now points to ${pick}`);
  }

  /**
   * Red box (a ref to a model with no file): remove the import CTEs that ref()
   * it, after asking. Files that use the model further than the import are
   * not touched; NodeViz offers to open them instead.
   */
  async removeRefs(name, { confirmed = false } = {}) {
    const m = this.model;
    const { auto, manual } = m.planRemoveRefs(name);
    if (auto.length) {
      const files = auto.map((f) => f.rel);
      const where = files.length === 1 ? files[0] : `${files.length} files`;
      const ok = confirmed || (await this.confirmRefEdits(`Remove ref('${name}') from ${where}?`, files));
      if (ok) this.report(m.removeRefs(name), `Removed ref('${name}') from ${where}`);
    }
    if (manual.length) {
      const first = manual[0];
      const others = manual.length > 1 ? ` and ${manual.length - 1} more` : '';
      const choice = await vscode.window.showWarningMessage(
        `${first.rel}${others} uses ${name} beyond the import at the top, so remove ref('${name}') there by hand.`,
        'Open file'
      );
      if (choice) await this.openPath(first.abs, this.panelSurface());
    }
  }

  /**
   * A model file was deleted in VS Code (Explorer): if other models still ref()
   * it, ask once whether to remove those refs, so no red box is left behind.
   * Deleting with rm in a terminal does not reach here; the red box's
   * "Remove ref" menu item covers that case.
   */
  async onFilesDeleted(files) {
    const m = this.model;
    if (!m) return;
    m.refresh();
    this.broadcast();
    for (const uri of files) {
      const ext = path.extname(uri.fsPath).toLowerCase();
      if (ext !== '.sql' && ext !== '.py') continue;
      const name = path.basename(uri.fsPath, ext);
      const node = m.nodes.get(name);
      if (!node || node.kind !== 'missing') continue;
      const users = m.referencingFiles(name).map((f) => f.rel);
      if (!users.length) continue;
      const who = users.length === 1 ? users[0] : `${users.length} files`;
      const choice = await vscode.window.showInformationMessage(
        `${name} was deleted, but ${who} still ${users.length === 1 ? 'uses' : 'use'} ref('${name}'). Remove the ref?`,
        { modal: true, detail: `${users.slice(0, 8).join('\n')}\n\nOnly the import CTE at the top is removed. Undo in NodeViz puts it back.` },
        'Remove ref'
      );
      if (choice) await this.removeRefs(name, { confirmed: true });
    }
  }

  /**
   * A model file was renamed in Explorer: keep its box in place and update the
   * refs to it, asking the same way as a rename on the canvas does (a dialog,
   * or no question at all when nodeviz.confirmFileEdits is off).
   */
  async onFilesRenamed(files) {
    const m = this.model;
    if (!m) return;
    for (const { oldUri, newUri } of files) {
      const info = m.fileRenamed(oldUri.fsPath, newUri.fsPath);
      if (!info) continue;
      this.broadcast();
      if (!info.usedBy.length) continue;
      const n = info.usedBy.length;
      const ok = await this.confirmRefEdits(
        `You renamed ${info.oldName} to ${info.newName}. Update ref('${info.oldName}') to ref('${info.newName}') in ${n} file${n === 1 ? '' : 's'}?`,
        info.usedBy
      );
      if (ok) this.report(m.retargetRefs(info.oldName, info.newName), `Updated refs to ${info.newName}`);
    }
  }

  panelSurface() {
    return [...this.surfaces].find((s) => s.panel);
  }

  openFile(id, surface) {
    const abs = this.model.absPath(id);
    if (abs) return this.openPath(abs, surface);
  }

  /**
   * Opens a file to the left of the canvas, so NodeViz always stays on the right.
   * If the canvas is the only editor group (all files closed), the file opens in a
   * new group that is then moved to the left of the canvas.
   */
  async openPath(abs, surface) {
    const uri = vscode.Uri.file(abs);
    const col = surface && surface.panel ? surface.panel.viewColumn : undefined;
    if (!col) {
      await vscode.window.showTextDocument(uri, { preview: false });
      return;
    }
    if (col > 1) {
      await vscode.window.showTextDocument(uri, { preview: false, viewColumn: col - 1 });
      return;
    }
    const groupsBefore = vscode.window.tabGroups.all.length;
    await vscode.window.showTextDocument(uri, { preview: false, viewColumn: vscode.ViewColumn.Two });
    if (groupsBefore === 1) await vscode.commands.executeCommand('workbench.action.moveActiveEditorGroupLeft');
  }

  askName(prompt, value, ignore) {
    return vscode.window
      .showInputBox({
        prompt,
        value,
        placeHolder: 'e.g. stg_orders, int_orders_joined, fct_orders',
        validateInput: (v) => this.model.validateName(v.trim(), ignore),
      })
      .then((v) => (v ? v.trim() : v));
  }

  /** Returns { modelDir, folder } or undefined if cancelled. */
  async pickFolder(name, alwaysAsk = false) {
    const m = this.model;
    const choices = m.folderChoices();
    if (choices.length === 1 && !alwaysAsk) return choices[0];
    const suggested = m.suggestFolder(name, choices);
    const items = choices.map((c, i) => ({
      label: c.folder ? `$(folder) ${c.folder}` : `$(root-folder) ${c.modelDir}`,
      description: i === suggested && suggested !== 0 ? 'suggested from the name' : c.folder ? `${c.modelDir}/${c.folder}` : 'top of the models folder',
      choice: c,
    }));
    const ordered = [items[suggested], ...items.filter((_, i) => i !== suggested)];
    ordered.push({ label: '$(new-folder) New folder…', description: 'created when the file is created', newFolder: true });
    const pick = await vscode.window.showQuickPick(ordered, { placeHolder: `Where should ${name}.sql go?` });
    if (!pick) return undefined;
    if (!pick.newFolder) return pick.choice;
    const folder = await vscode.window.showInputBox({
      prompt: `New folder inside ${choices[0].modelDir}/`,
      placeHolder: 'e.g. staging or marts/finance',
      validateInput: (v) => (FOLDER_RE.test(v.trim()) ? null : 'Use letters, numbers, - and _; separate subfolders with /.'),
    });
    if (!folder) return undefined;
    return { modelDir: choices[0].modelDir, folder: folder.trim() };
  }
}

function activate(context) {
  const ctl = new Controller(context);

  // A status bar button to bring the canvas back after it has been closed.
  // Shown once there is a dbt project (or the canvas was opened by hand).
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  status.text = '$(type-hierarchy-sub) NodeViz';
  status.tooltip = 'Open the NodeViz canvas';
  status.command = 'nodeviz.openPanel';

  // NodeViz activates in every workspace (onStartupFinished), so it notices a dbt
  // project that is added after the folder was opened. Until there is one it
  // shows nothing and runs nothing: no status bar button, no integrations, no refreshes.
  let started = false;
  let openTimer = null;
  let probe = null;
  context.subscriptions.push({ dispose: () => (clearTimeout(openTimer), clearTimeout(probe)) });

  /** when: 'startup' (project there from the start), 'later' (project just appeared), 'manual' (Open Canvas). */
  const start = (when) => {
    if (started) return;
    started = true;
    status.show();
    ctl.startIntegrations();
    noticeLegacySettings(context);
    if (when === 'manual') return;
    if (settings().get('openOnStartup')) {
      // On startup, wait until editors have been restored, so the canvas lands beside the code.
      const delay = when === 'startup' ? STARTUP_DELAY_MS : 0;
      openTimer = setTimeout(() => {
        if (!ctl.panel) ctl.openPanel({ preserveFocus: true });
      }, delay);
    } else if (when === 'later') {
      vscode.window
        .showInformationMessage('NodeViz found a dbt project in this workspace.', 'Open Canvas')
        .then((choice) => choice && ctl.openPanel());
    }
  };

  /** A dbt_project.yml may have appeared: show it, unless NodeViz already shows a project. */
  const projectAppeared = () => {
    if (ctl.model && ctl.model.cfg && ctl.model.cfg.hasProject) return;
    if (!ctl.workspaceHasProject()) return;
    ctl.loadProject();
    ctl.broadcast();
    start('later');
  };
  const probeSoon = () => {
    if (started && ctl.model && ctl.model.cfg && ctl.model.cfg.hasProject) return;
    clearTimeout(probe);
    probe = setTimeout(projectAppeared, 500);
  };

  context.subscriptions.push(
    status,
    vscode.commands.registerCommand('nodeviz.openPanel', () => {
      start('manual');
      ctl.openPanel();
    }),
    vscode.commands.registerCommand('nodeviz.refresh', () => {
      ctl.loadProject(ctl.model ? ctl.model.cfg.root : undefined);
      ctl.broadcast();
    }),
    vscode.commands.registerCommand('nodeviz.undo', () => ctl.handle({ type: 'undo' })),
    vscode.commands.registerCommand('nodeviz.redo', () => ctl.handle({ type: 'redo' })),
    vscode.commands.registerCommand('nodeviz.tidy', () => ctl.handle({ type: 'tidy' })),
    vscode.commands.registerCommand('nodeviz.createAll', () => ctl.handle({ type: 'createAll' })),
    vscode.commands.registerCommand('nodeviz.selectProject', () => ctl.selectProject()),
    vscode.commands.registerCommand('nodeviz.checkIntegrations', () => ctl.checkIntegrations()),
    vscode.commands.registerCommand('nodeviz.traceColumnAtCursor', () => ctl.traceColumnAtCursor()),
    vscode.commands.registerCommand('nodeviz.runDbt', () => ctl.pickDbtCommand()),
    { dispose: () => ctl.integrations && ctl.integrations.dispose() },
    vscode.window.onDidCloseTerminal
      ? vscode.window.onDidCloseTerminal((t) => {
          if (t === ctl.dbtTerminal) ctl.dbtTerminal = null;
        })
      : { dispose() {} },
    vscode.window.onDidChangeActiveTextEditor(() => ctl.postActiveFile()),
    vscode.workspace.onDidRenameFiles((e) =>
      ctl.onFilesRenamed(e.files).catch((err) => vscode.window.showErrorMessage(`NodeViz: ${err.message}`))
    ),
    vscode.workspace.onDidDeleteFiles
      ? vscode.workspace.onDidDeleteFiles((e) =>
          ctl.onFilesDeleted(e.files).catch((err) => vscode.window.showErrorMessage(`NodeViz: ${err.message}`))
        )
      : { dispose() {} },
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (!started) return projectAppeared();
      ctl.loadProject();
      ctl.broadcast();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (affectsSetting(e, 'projectPath')) {
        if (!started) return projectAppeared();
        ctl.loadProject();
        ctl.broadcast();
      }
    })
  );

  // Optional tools (DAGtracer, ...) start in start(), in the background; the canvas never waits for them.
  if (vscode.workspace.onDidChangeConfiguration) {
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (affectsSetting(e, 'integrations') && ctl.integrations) ctl.integrations.recheck();
      })
    );
  }

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{sql,py,csv,yml,yaml}');
  const onChange = () => started && ctl.scheduleRefresh();
  // A project copied in as a folder may only report some of its files: any new
  // file is a reason to look for dbt_project.yml again (cheap, and only until one is found).
  watcher.onDidCreate(() => {
    probeSoon();
    onChange();
  });
  watcher.onDidChange(onChange);
  watcher.onDidDelete(onChange);
  const projectWatcher = vscode.workspace.createFileSystemWatcher('**/dbt_project.yml');
  projectWatcher.onDidCreate(probeSoon);
  const stateWatcher = vscode.workspace.createFileSystemWatcher('**/{.nodeviz.json,.dbtflow.json}');
  const onState = () => started && ctl.scheduleRefresh(true);
  stateWatcher.onDidChange(onState);
  stateWatcher.onDidCreate(onState);
  context.subscriptions.push(watcher, projectWatcher, stateWatcher);

  if (ctl.workspaceHasProject()) start('startup');
}

/** Once per machine: say that dbtFlow.* settings are now nodeviz.* (the old ones keep working). */
function noticeLegacySettings(context) {
  const state = context.globalState;
  if (!state || state.get('nodeviz.legacySettingsNotice')) return;
  const old = legacySettingsInUse();
  if (!old.length) return;
  state.update('nodeviz.legacySettingsNotice', true);
  const example = old[0].replace(`${LEGACY_SECTION}.`, `${SECTION}.`);
  vscode.window.showInformationMessage(
    `NodeViz settings are now called nodeviz.* instead of dbtFlow.* (e.g. ${example}). Your old settings still work; rename them when it suits you.`
  );
}

function deactivate() {}

module.exports = { activate, deactivate, settings };