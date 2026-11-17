# Architecture

NodeViz has a **core** (the canvas: reading the project, drawing, sketching, editing
SQL, undo, typing dbt commands into a terminal) and optional **integrations** with
outside tools whose output NodeViz reads (DAGtracer today). The rule behind everything
below:

> The core must work exactly as before when an integration is missing, broken,
> turned off or slow. An integration can fail; it cannot take the canvas with it.

## Layout

```
extension.js                 VS Code wiring. Starts the integration host inside try/catch.
src/                         CORE, no vscode imports: model, parser, layout, sqlgen,
                             project, nodeio, modelsyml, dbtrun, aliases.
  layout.js                  Also loaded in the canvas webview (window.NodeVizLayout),
                             so it must stay free of require() and Node APIs.
  dbtrun.js                  Running dbt: builds the terminal line from a fixed list of
                             commands. Core, not an integration, because NodeViz only
                             types the line into a terminal and never reads dbt's output.
src/host/
  integrationHost.js         Loads integrations, checks them, routes messages, keeps state.
  runTool.js                 Runs an outside tool as a process. Never throws.
src/integrations/
  index.js                   The list of integration folders to load.
  dagtracer/
    index.js                 detect() + activate() → handlers (trace).
    contract.js              The only file that knows dgt's JSON. Checks schema_version.
    idmap.js                 dgt unique_ids ↔ box ids; trace → what the canvas draws.
    catalog.js               Column names of a box from target/catalog.json (suggestions only).
    util.js                  Small helpers, kept inside the folder on purpose.
src/aliases.js               CORE. Which model `prep1` in `prep1.order_id` stands for.
media/main.js                Canvas UI. Starts canvas add-ons and gives them a small API.
media/integrations/
  dagtracer.js, .css         Canvas add-on: menu items, overlay, ✕ marks, panel.
test/
  architecture.test.js       Enforces the boundaries below.
  host.test.js               Host and runTool, including every failure path.
  dagtracer.test.js          Contract, id mapping, catalog, full traces with a fake dgt.
  dagtracer-ui.test.js       The canvas add-on in a fake DOM.
  lineage-ui.test.js         Lineage filter and depth on the canvas, in a fake DOM.
  aliases.test.js            Import CTEs and aliases.
  model/extension/…test.js   The core and the VS Code wiring (with a fake vscode module).
  fixtures/dagtracer/        Real dgt output from tpch_dbt (see its README).
```

## Three boundaries

**1. Process boundary.** Outside tools are never imported. They run as their own
process through `runTool`, and their answer is read as JSON. A crash, hang or
missing install becomes a result with `error` set (`not_found`, `timeout`,
`cancelled`, `spawn_failed`, `too_large`), never an exception.

**2. Contract boundary.** Each integration has one `contract.js` that knows the tool's
output format. It checks the major `schema_version`, ignores unknown fields (the
tools' own rule: minor versions only add fields) and turns the output into a plain
internal shape. When a tool changes its format, the fix is in that one file.

**3. Code boundary.** Dependencies point one way:

- the core (`src/*.js`) never requires `src/host` or `src/integrations`;
- the host requires only its own files and Node built-ins (no `vscode`, no core);
- an integration requires only files in its own folder and Node built-ins.

`test/architecture.test.js` fails if any of these is broken.

## What an integration is

```js
module.exports = {
  id: 'dagtracer',                 // lowercase; also the message prefix
  title: 'DAGtracer',
  async detect(api) { ... },       // → { ok: true, version } | { ok: false, state, reason }
  activate(api) {                  // → { handlers: { <action>: async (msg) => ... }, dispose? }
    ...
  },
};
```

`api` is all an integration can reach (frozen):

| | |
|---|---|
| `projectRoot()` | dbt project folder, or null |
| `view()` | a **copy** of the graph view; changing it changes nothing |
| `post(type, payload)` | message to the canvas, always sent as `"<id>/<type>"` |
| `setting(key, default)` | `nodeviz.integrations.<id>.<key>` |
| `run(cmd, args, opts)` | `runTool`, with the integration's log attached |
| `log(line)` | the integration's output channel |
| `ask(opts)` / `pick(opts)` | an input box / a quick pick (that can also take a typed value); `undefined` when cancelled |

There is no way to reach `FlowModel`, `.nodeviz.json`, files or undo history.
Integration results are shown as an overlay on the canvas and are never saved.

## States

Each integration is in one state, shown by *NodeViz: Check Integrations*:

| State | Meaning |
|---|---|
| `checking` | detect() is running |
| `ready` | usable |
| `missing` | the tool is not installed or not found |
| `incompatible` | the tool answers, but in a version or format we do not understand |
| `failed` | the module could not load, or detect/activate threw |
| `disabled` | turned off with `nodeviz.integrations.<id>.enabled` |

The host posts `{ type: 'integrations', list }` to the canvas whenever states change,
so the canvas can show or hide actions.

## Messages

Canvas messages with a `/` in the type (`dagtracer/trace`) go to the host; everything
else goes to the core as before. The host refuses politely (`<id>/error`) when the
integration does not exist, is not ready, has no such action or is busy. A handler
that throws is logged and reported as `<id>/error`; the host stays usable.

The extension keeps the last `<id>/result` and sends it again to a canvas that opens
later, until the canvas sends `integrationForget { id }` (the user cleared it).

DAGtracer:

| Direction | Type | Payload |
|---|---|---|
| canvas → ext | `dagtracer/traceBox` | `{ id, column? }`: trace up and down from one box; without a column the user picks one (from `catalog.json`) or types it |
| canvas → ext | `dagtracer/trace` | `{ starts: [boxId], column, direction: 'up' \| 'down' \| 'both' }` |
| ext → canvas | `dagtracer/started` | `{ column, direction, starts }` |
| ext → canvas | `dagtracer/result` | `{ request, trace, absent, skipped, errors }` |
| ext → canvas | `dagtracer/error` | `{ action, message }` |

`trace.crossings` lists the connections where the column stops: from each parent that
still has it to the box that lost it (`edge` is the hop to mark). `trace.markers` holds
other findings (starts at a source, reaches a leaf, absent at source). `absent` is set
when the column is not in the box a `traceBox` started from; the panel then offers an
upstream trace instead. With several start boxes going downstream, boxes that do not
have the column are listed in `skipped`.

Running dbt is not an integration and has no `/` messages: the canvas sends
`dbt { command, id? }` to the core, which only accepts commands from the list in
`src/dbtrun.js` and types the resulting line into the *NodeViz* terminal.

## Canvas add-ons

An integration can have a canvas part in `media/integrations/<id>.js` (and `.css`).
The extension adds them to the webview **before** `main.js`; each one registers itself:

```js
(window.nodevizPlugins = window.nodevizPlugins || []).push({ id: 'dagtracer', init(api) { ... } });
```

`main.js` calls `init` once, inside try/catch, with this API (frozen):

| | |
|---|---|
| `on(hook, fn)` | `message` (every message to the canvas), `nodeMenu(box)` and `canvasMenu()` (return menu items), `decorate()` (after every render: re-apply classes), `edgesMoved(id?)`, `escape()` (return true if handled) |
| `post(type, payload)` | sends `"<id>/<type>"`; it cannot send core messages |
| `forget()` | the extension stops replaying this add-on's last result |
| `view()`, `nodeEl(id)`, `edges()`, `edgeLayer`, `viewport` | read the graph and the DOM to draw on |
| `setOverlay(on)` | while on, the lineage highlight steps aside |
| `toast`, `el`, `svg`, `centerOn`, `fitTo(ids)`, `select`, `isTB` | helpers |

Every hook call is wrapped: a throwing add-on is logged to the webview console and the
canvas carries on. Overlays use their own CSS classes (`dgt-*`) and are rebuilt on
`decorate`; they are never written to `.nodeviz.json`. `test/architecture.test.js`
checks that an add-on registers through `window.nodevizPlugins` with its own id and
never calls `acquireVsCodeApi`.

## Editor integration

*Trace Column* in the SQL editor's right-click menu (`nodeviz.traceColumnAtCursor`)
takes the word under the cursor. For `prep1.order_id` it starts at the model behind
`prep1` (`src/aliases.js` reads import CTEs and `ref()` aliases); otherwise at the
model the file belongs to. It opens the canvas and sends `dagtracer/traceBox`.

## Debugging

- *NodeViz: Check Integrations* re-checks everything and lists state, version and
  reason. Picking one opens its log.
- Each integration has its own Output channel (*NodeViz: DAGtracer*). Every run logs
  the command line, folder, exit code, duration and the end of stderr.
- If the host itself cannot start, the reason is in Help → Toggle Developer Tools →
  Console, and the canvas works without integrations.

## Adding an integration

1. Make `src/integrations/<id>/` with `index.js`, `contract.js` and what else it needs.
2. Add `<id>` to `src/integrations/index.js`.
3. Add settings `nodeviz.integrations.<id>.enabled` / `.executable` to `package.json`.
4. Save real tool output as fixtures and test the contract, the failure paths and a
   full run through `IntegrationHost` with a fake `run`.
5. For a canvas part, add `media/integrations/<id>.js` (+ `.css`) using only the
   add-on API, and test it in a fake DOM like `test/dagtracer-ui.test.js`.
6. `npm test` (the architecture test checks the boundaries).
