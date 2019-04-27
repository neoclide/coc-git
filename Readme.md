# coc-git

Git integration of [coc.nvim](https://github.com/neoclide/coc.nvim).

## Why

- Always async.
- Always refresh on TextChange.

## Features

- Git status of current project, by `g:coc_git_status`.
- Git status of current buffer, by`b:coc_git_status`.
- Git related lists, including `gfiles`, `gstatus`, `commits`, `branches` & `bcommits`
- Keymaps for git chunks, including `<Plug>(coc-git-chunkinfo)` `<Plug>(coc-git-nextchunk)` & `<Plug>(coc-git-prevchunk)` ,
- Commands for chunks, including `git.chunkInfo` `git.chunkStage` & `git.chunkUndo`

## Install

In your vim/neovim, run command:

```
:CocInstall coc-git
```

## Options

## License

MIT
