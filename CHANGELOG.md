# Changelog

## Unreleased

- **Hide unrelated models.** Show only the selected model and its lineage. Search can still select hidden models.
- **Upstream and downstream depth.** Set each direction independently: `0` excludes it, `1` includes direct neighbors, and an empty field includes all levels. Depth limits also apply to highlighting.
- **Rearrange on update.** Off by default. When on, it arranges only the visible models and connections when the selection, depth, graph, or flow direction changes; most useful together with *Hide unrelated*, which then shows a small, tidy graph of just that lineage. Turn it off to see your saved positions again.
- Fit-to-view and the minimap follow the visible graph. The canvas remembers filter, depth, and rearrangement preferences.
- Column tracing temporarily pauses lineage filtering and automatic rearrangement so the complete trace remains visible.
- Fixed invisible connections in straight horizontal or vertical layouts.
- Removed a machine-specific project path from the F5 development configuration.

## 0.3.1 (preview)

- **Settings are now `nodeviz.*`** (were `dbtFlow.*`), and the layout file is `.nodeviz.json` (was `.dbtflow.json`). Old settings still work when the new one is not set, and NodeViz says so once. The old layout file is read and moved to `.nodeviz.json` the first time you change something on the canvas. Command ids are `nodeviz.*` too; update any keyboard shortcuts you made for them.
- **A dbt project added after the folder was opened is found** without reloading the window (for example when you copy a project into a freshly cloned repo). NodeViz now starts in every workspace but stays invisible and idle until there is a `dbt_project.yml`.
- **Clearer connection direction.** Connections have arrowheads. The question before a file is changed says it in words ("`fct_orders.sql` will read from `stg_payments`") and has a *Swap direction* button. A connection that looks backwards (an existing model reading from a box with no file yet, or a marts model feeding staging) is questioned even with `nodeviz.confirmFileEdits` off. A new box moves to the right of its first input instead of staying where you right-clicked.
- **Undo says what it undid.** After Ctrl+Z (or redo) the canvas shows what was reverted and what the next press would revert, so undoing one step too many is a choice. Holding Ctrl+Z no longer repeats. Each canvas action was already one undo step (now covered by a test), so what looked like one undo removing both a connection and a new file was most likely two presses, or a held key.
- **`dbt clean` in the ▶ menu**, for the stale parse cache behind "unable to infer all dependencies". Run `deps` after it if you use packages.
- **Materialization from `dbt_project.yml`.** The chip on a box now also shows a folder's `+materialized` from `dbt_project.yml` (the deepest folder wins); `config()` in the file still wins over it. Hover the chip to see where it came from.
- **New models go into the folder's models `.yml`.** *Create file* adds `- name: <model>` with an empty `description:` to the folder's models `.yml` (e.g. `_marts__models.yml`), following the file's own indentation. Only when the folder has exactly one `.yml` with a `models:` list; part of the same undo step. New setting `nodeviz.addToModelsYml` (on by default).
- README: troubleshooting for settings in the wrong `.vscode/` folder and for Databricks `RuntimeWarning`s on `docs generate`; the sketching steps describe the new connect dialog.

## 0.3.0 (preview)

First release on the VS Code Marketplace.

- **New name: NodeViz** (was dbt Lens / dbt Flow), with a new icon and logo. Settings keep their `dbtFlow.*` names, so existing setups keep working.
- **Run dbt from the canvas.** Right-click a box for `dbt build`, `run`, `test` or `compile` on that model and everything upstream; the ▶ button runs a command on the whole project. Commands go to a normal terminal called *NodeViz*. New settings `dbtFlow.dbt.executable`, `dbtFlow.dbt.target` and `dbtFlow.dbt.envFile`.
- **Trace a column.** With [DAGtracer](https://github.com/alexD1990/DAGtracer) installed, *Trace column…* shows which models still have a column and marks where it is dropped. Also from the right-click menu in a SQL file.
- **Sync with files** reads the whole project again and lays it out from scratch (one undo step).
- **Remove from canvas** takes any box off the canvas without touching its file; *Show removed boxes* brings them back.
- **Rename** a model on the canvas or in Explorer, and NodeViz offers to update every `ref()` to it. A red box (ref to a missing model) can be pointed at another model, or its refs removed.
- **Flow direction:** left to right or top to bottom.
- New look: glowing connections, icon tiles, minimap and a floating tool bar. The box for the file you have open lights up.
- Removed the lock mode: every box moves freely, and moving never changes SQL.

## 0.2.0

- The canvas is now an editor tab that opens to the right of your code on startup, instead of a side bar view that replaced Explorer.
- New: **dbt Flow** button in the status bar and a canvas button in the title bar of `.sql` files to reopen it.
- New setting `dbtFlow.openOnStartup`.

## 0.1.0

First version.

- Canvas of models, sources, seeds and snapshots from `ref()` / `source()`, live on save.
- Finds `model-paths` from `dbt_project.yml`, forgiving about `model` vs `models` and case.
- Colour per folder under the models folder.
- Create boxes, connect them, create one or all `.sql` files with import CTEs.
- Connecting onto an existing model adds the `ref()` at the top of its file.
- Locked positions for models with files; unlock, move, put back.
- Undo / redo for every canvas change, including file edits.
- Lineage highlight, search, tidy-up layout, fit to view.
- Activity bar view, or open as an editor tab.
