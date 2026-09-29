import { BasicList, ListContext, Neovim } from 'coc.nvim'

export async function previewDiff(list: BasicList, nvim: Neovim, context: ListContext, lines: string[], bufname: string): Promise<void> {
  await list.preview({
    lines,
    filetype: 'git',
    sketch: true,
    bufname
  }, context)
  await nvim.command("call win_execute(coc#list#get_preview(), 'setlocal foldmethod=syntax')")
}
