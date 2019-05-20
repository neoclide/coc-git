# coc-git

Git integration of [coc.nvim](https://github.com/neoclide/coc.nvim).

## Install

In your vim/neovim, run command:

```
:CocInstall coc-git
```

## Why

- Always async.
- Always refresh on TextChange.
- Powerful list support.
- Doesn't need python.

## Features

- Git status of current project, by `g:coc_git_status`.
- Git status of current buffer, by`b:coc_git_status`.
- Git related lists, including `gfiles`, `gstatus`, `commits`, `branches` & `bcommits`
- Keymaps for git chunks, including `<Plug>(coc-git-chunkinfo)` `<Plug>(coc-git-nextchunk)` & `<Plug>(coc-git-prevchunk)` ,
- Commands for chunks, including `git.chunkInfo` `git.chunkStage` & `git.chunkUndo`

## Configuration

- `git.command`:Command for git, could be absolute path of git executable., default: `"git"`
- `git.branchCharacter`:Branch character used with g:coc_git_branch, default: `""`
- `git.enableGutters`:Enable gutters in sign column., default: `true`
- `git.signOffset`:Start offset of sign gutter, change to higher value to prevent overwrite by other plugin., default: `99`
- `git.changedSign.text`:Text of changed sign., default: `"~"`
- `git.changedSign.hlGroup`:Highlight group for changed sign., default: `"DiffChange"`
- `git.addedSign.text`:Text of added sign., default: `"+"`
- `git.addedSign.hlGroup`:Highlight group for added sign., default: `"DiffAdd"`
- `git.removedSign.text`:Text of removed sign., default: `"_"`
- `git.removedSign.hlGroup`:Highlight group for removed sign., default: `"DiffDelete"`
- `git.topRemovedSign.text`:Text of top removed sign., default: `"‾"`
- `git.topRemovedSign.hlGroup`:Highlight group for top removed sign., default: `"DiffDelete"`
- `git.changeRemovedSign.text`:Text of change removed sign., default: `"≃"`
- `git.changeRemovedSign.hlGroup`:Highlight group for change removed sign., default: `"DiffDelete"`

**Note** for user from [vim-gitgutter](https://github.com/airblade/vim-gitgutte),
if your have highlight groups defined for vim-gitgutter, you can use:

```json
"git.addedSign.hlGroup": "GitGutterAdd",
"git.changedSign.hlGroup": "GitGutterChange",
"git.removedSign.hlGroup": "GitGutterDelete",
"git.topRemovedSign.hlGroup": "GitGutterDelete",
"git.changeRemovedSign.hlGroup": "GitGutterChangeDelete",
```

## Usage

### Statusline integration

- `g:coc_git_status` including git branch and current project status.
- `b:coc_git_status` including changed lines of current buffer.

If you're not using statusline plugin, you can add them to statusline by:

```vim
set statusline^=%{get(g:,'coc_git_status','')}%{get(b:,'coc_git_status','')}
```

### Keymaps and commands

- Create keymappings like:

  ```vim
  " navigate chunks of current buffer
  nmap [g <Plug>(coc-git-prevchunk)
  nmap ]g <Plug>(coc-git-nextchunk)
  " show chunk diff at current position
  nmap gs <Plug>(coc-git-chunkinfo)
  " show commit ad current position
  nmap gc <Plug>(coc-git-commit)
  ```

- For `stage` and `undo` action of current chunk, open command list by
  `:CocCommand`, filter list by type `git`, select action by type `<CR>`.
- Use `:CocCommand git.browserOpen` to open current line in your browser.
  Support github only for now.

### Work with git lists

To open a specified coc list, you have different ways:

- Run `:CocList` and select the list by `<CR>`.
- Run `:CocList` and type name of list for completion.
- Create keymap for open specified list with list options, like:

  ```vim
  nnoremap <silent> <space>g  :<C-u>CocList --normal gstatus<CR>
  ```

To toggle list mode, use `<C-o>` and `i`.

To move up&down on insertmode, use `<C-j>` and `<C-k>`

To run a action, press `<tab>` and select the action.

For more advance usage, checkout `:h coc-list`.

## Settings

## License

MIT
