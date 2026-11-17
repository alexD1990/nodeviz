# Contributing to NodeViz

Thank you for helping out! NodeViz is a small project, and every bug report, idea and pull request is welcome. This page explains how to run it from source, how branches and pull requests work, and what NodeViz promises its users, so your change fits in.

## Run it from source

NodeViz is plain JavaScript with **no build step and no dependencies**, so there is nothing to install.

```bash
git clone https://github.com/alexD1990/nodeviz.git
cd nodeviz
git switch dev
npm test
```

CI runs on Node.js 22.

To try your changes, open the folder in VS Code and press **F5** (*Run → Start Debugging*, configuration **Run NodeViz**). A second VS Code window starts with NodeViz loaded from source. Open any dbt project in that window with *File → Open Folder*. NodeViz only reads the files, so the project does not need to build. After a code change, close that window and press F5 again.

If you always use the same dbt project, you can add its folder after `--extensionDevelopmentPath=${workspaceFolder}` in `.vscode/launch.json`, but please do not commit that line.

## Branches and pull requests

- **`main`** is the version published on the VS Code Marketplace.
- **`dev`** is where new work goes. `dev` is merged into `main` for each release.

So: branch from `dev` and open your pull request **into `dev`**. CI runs the tests and builds the extension on every pull request; the `.vsix` it builds is attached to the run, so anyone can install and try your change.

In your pull request:

- **Describe the change for users** under `## Unreleased` at the top of `CHANGELOG.md`. Add the heading if it is not there.
- **Leave `version` in `package.json` alone.** The release workflow sets it.
- **Update `README.md`** when something a user sees or does changes.
- **Add or update tests** (see below), and make sure `npm test` passes.
- Keep a pull request to one idea. For something big, open an issue or a draft pull request first, so we can agree on the direction before you spend a lot of time on it.

## How the code is laid out

| Path | What it is |
| --- | --- |
| `extension.js` | Wires everything to VS Code: commands, the canvas tab, file watchers, dialogs, settings. |
| `src/*.js` | The core: parsing `ref()`/`source()`, layout, SQL edits, undo, dbt commands. No VS Code imports, so it is tested directly. |
| `src/host/` | Loads optional integrations and runs outside tools safely. |
| `src/integrations/<name>/` | One folder per optional outside tool, e.g. `dagtracer/` for column tracing. |
| `media/main.js`, `media/main.css` | The canvas in the webview: plain DOM and SVG, no framework. |
| `media/integrations/` | Canvas add-ons for integrations. |
| `test/` | Tests, one file per area. |

A few rules keep this tidy; `test/architecture.test.js` checks all but the first:

- the core (`src/*.js`) never imports `vscode`, so it runs and is tested in plain Node;
- the core never requires `src/host/` or `src/integrations/`;
- the host only requires its own files and Node built-ins;
- an integration only requires files in its own folder and Node built-ins;
- a canvas add-on only talks to the canvas through `window.nodevizPlugins`.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains these boundaries, the messages between the canvas and the extension, the canvas add-on API, and how to add an integration for another outside tool.

Also:

- **No dependencies and no build step.** If you think something needs a library, ask in an issue first.
- **Code, comments and UI text are in English.**
- Read settings through `settings()` in `extension.js`, never `vscode.workspace.getConfiguration` directly (it handles the old `dbtFlow.*` names).

## Tests

Tests use Node's built-in runner (`node:test` with `node:assert/strict`), no framework. Each test file is listed in the `test` script in `package.json`, so **add a new test file there too**.

- Core logic (`src/`) is tested directly with small sample projects written to a temp folder.
- `extension.js` is tested with a fake `vscode` module (`test/extension.test.js`).
- Canvas code is tested in a fake DOM (`test/dagtracer-ui.test.js`, `test/lineage-ui.test.js`).

## What NodeViz promises its users

These are the ideas behind most design choices. A change that bends one of them is not ruled out, but say so in the pull request so we can talk about it.

- **Your layout is yours.** Boxes stay where the user put them, and that layout is saved. NodeViz only lays the canvas out again when the user asks (*Tidy up*, *Sync with files*, switching flow direction), and never quietly shows something else in its place.
- **Moving a box never changes SQL.**
- **NodeViz never deletes files.** Removing a box only takes it off the canvas; *Show removed boxes* brings it back.
- **File edits are small and asked for.** Adding a `ref()` to an existing `.sql` file asks first (unless the user turned that off), and every edit shows up plainly in `git diff`.
- **Everything can be undone.** Each canvas action, including the file edits it makes, is one undo step.
- **No dbt run needed.** The canvas is drawn from the files alone, so it works on a fresh clone and on models that do not compile yet. Running dbt and reading `target/` are optional extras.
- **Quiet outside dbt projects.** Without a `dbt_project.yml`, NodeViz shows and runs nothing.
- **Outside tools are optional.** When a tool such as DAGtracer is missing, its feature is simply not offered; nothing else breaks.

## Releases

Releases are made by the maintainer: *Actions → Release → Run workflow* on `main`, after merging `dev` into `main`. The workflow runs the tests, bumps the version, turns `## Unreleased` into that version, publishes to the Marketplace and creates a GitHub release with the `.vsix`.

## Questions and ideas

Open an [issue](https://github.com/alexD1990/nodeviz/issues). Ideas are welcome even if you don't plan to build them yourself.

By contributing, you agree that your contribution is licensed under the project's [MIT license](LICENSE.md).
