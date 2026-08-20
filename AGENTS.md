# AGENTS.md

## Repository purpose

`coc-git` is the Git integration extension for `coc.nvim`. Its runtime entry point is `src/index.ts`; the published entry point is the bundled `lib/index.js`. The extension owns Git-backed buffer state, gutters and blame text, conflict actions, Coc lists, GitHub/GitLab issue completion, and the commands/keymaps declared in `package.json`.

## Code map


- `src/index.ts` is the activation and registration layer. Register new Coc commands, `<Plug>` keymaps, lists, completion providers, and disposables here.
- `src/manager.ts` coordinates editor events, live `GitBuffer` instances, configuration, and user-facing operations.
- `src/model/git.ts` is the low-level child-process wrapper around the configured Git executable.
- `src/model/repo.ts` implements repository-scoped Git operations; put Git command construction and output parsing there rather than in the activation layer.
- `src/model/resolver.ts` resolves documents and working directories to repositories and relative paths.
- `src/model/buffer.ts` owns per-buffer diffs, signs, blame, folds, and conflict state.
- `src/model/service.ts` owns resolver/repository lifetimes and constructs `GitBuffer` instances.
- `src/lists/` contains Coc list implementations (`gstatus`, `gfiles`, `gchanges`, `gchunks`, `branches`, `commits`, and `bcommits`). List-specific actions and rendering belong in the corresponding list class.
- `src/source.ts` implements GitHub/GitLab issue loading plus the `issues` list/completion source.
- `src/types.ts` is the shared contract for diffs, conflicts, and the configuration object passed into buffer/model code.
- `package.json` is also the Coc extension manifest: command names, activation, and all user-visible configuration schemas live there.
- `Readme.md` documents the public commands, keymaps, lists, environment variables, and settings.

## Public-contract synchronization

When changing a user-facing feature, update every surface that represents the same contract:

- A new `git.*` command needs a `commands.registerCommand` registration in `src/index.ts` and an entry under `contributes.commands` in `package.json`. Add it to `Readme.md` when it is intended for direct use.
- A new `<Plug>(coc-git-...)` mapping needs a `workspace.registerKeymap` registration in `src/index.ts` and matching usage documentation in `Readme.md`.
- A new `git.*` setting needs a schema entry under `contributes.configuration.properties` in `package.json`, a typed field in `src/types.ts` when consumed beyond the registration layer, and loading/default logic in `DocumentManager.loadConfiguration()` in `src/manager.ts`. Keep defaults identical across those locations and `Readme.md`.
- A new list must be implemented under `src/lists/`, registered through `listManager` in `src/index.ts`, and added to the documented list names.
- Preserve the exported `ExtensionApi` shape in `src/index.ts` unless the API change is intentional; other Coc extensions can consume `git`, `resolver`, and `manager` from activation.

## Git and editor behavior

- Use the configured executable discovered from `git.command`; do not hard-code an executable path. Model-layer Git execution should flow through `Git`, `GitRepo`, or the existing command helpers.
- Keep Git work asynchronous. Do not introduce synchronous child-process calls into buffer refresh, cursor movement, completion, or list loading paths.
- Pass arguments as arrays to `Git.exec`, `Git.stream`, or `spawnCommand` when filenames or revisions are involved. The repository already supports paths containing spaces; avoid building an unescaped shell string unless the operation specifically requires an interactive terminal command.
- Preserve cancellation and disposal behavior around spawned processes and Coc event listeners. Anything registered during activation or manager construction must be owned by the existing `subscriptions`/`disposables` lifecycle.
- Buffer refreshes are event-driven (`TextChange`, writes when realtime gutters are disabled, `FocusGained`, and `BufEnter`). Changes to diff or blame behavior must account for stale async results and for buffers disposed while repository resolution is still running.
- Keep Vim and Neovim compatibility. Virtual text, floating windows, namespaces, terminal operations, and popup behavior must retain the existing capability checks or Coc abstractions; do not use a Neovim-only API on an unconditional path.
- Git output is normalized under `LC_ALL`/`LANG=en_US.UTF-8` and decoded through `iconv-lite`. Parsing code must not depend on the user's localized Git messages.
- GitHub issue access uses `GITHUB_API_TOKEN`; GitLab access uses `GITLAB_PRIVATE_TOKEN` and `git.gitlab.hosts`. Do not log tokens or put them into rendered list/completion items.

## Generated output and dependencies

- Do not edit or commit `lib/index.js`; `lib/` is generated and ignored. Change TypeScript under `src/` and rebuild it with `npm run build`.
- `esbuild.js` must continue to bundle `src/index.ts` for Node while leaving `coc.nvim` external. The bundle target is `node10.12`; avoid emitting runtime syntax or APIs that violate that target unless the target is deliberately raised.
- Use npm for dependency and lockfile changes. CI installs with `npm ci`, so `package.json` and `package-lock.json` must stay synchronized.
- `npm run lint` is TypeScript checking (`tsc -p tsconfig.json`), not an ESLint formatting pass. The project enables `noUnusedLocals` and emits nothing during this check.

## Verification

Run checks according to the affected subsystem:

- Type/config/registration changes: `npm run lint` and `npm run build`.
- Git parsing, repository, buffer, manager, list, source, command, or keymap behavior: `npm test`.
- Vim-specific behavior: `npm run test:integration:vim`.
- Neovim-specific behavior: `npm run test:integration:nvim`.
- Changes intended to pass CI must succeed in both editor variants. The GitHub Actions matrix uses Node 22 and runs typechecking plus the Vim and Neovim integration suites.

For manual editor verification, load the rebuilt extension through Coc and exercise the exact public surface changed: the relevant `:CocCommand git.*`, `<Plug>(coc-git-*)` mapping, `:CocList` list, gutter/blame update, conflict action, or issue completion flow. Use a temporary Git repository containing the required staged, unstaged, untracked, renamed, conflicted, or non-UTF-8-path state rather than testing against this checkout's working tree.
