import { BasicList, ListAction, ListContext, ListItem, Neovim, Uri, workspace } from 'coc.nvim'
import path from 'path'
import Manager from '../manager'
import { runCommand, shellescape } from '../util'

export default class Gfiles extends BasicList {
  public readonly name = 'gfiles'
  public readonly description = 'view files on different branches (or commits, or tags)'
  public readonly detail = 'Pass git sha as first command argument, when empty, HEAD is used.\nExample: :CocList gfiles 7b5c5cb'
  public readonly defaultAction = 'edit'
  public actions: ListAction[] = []

  constructor(nvim: Neovim, private manager: Manager) {
    super(nvim)
    const preferences = workspace.getConfiguration('coc.preferences')
    let jumpCommand = preferences.get<string>('jumpCommand', 'edit')

    for (let name of ['edit', 'tabe', 'vsplit', 'split']) {
      this.addAction(name, async (item, ctx) => {
        let { root, sha, filepath, branch } = item.data
        if (!sha) return
        if (branch == 'HEAD') {
          let cmd = name == 'edit' ? jumpCommand : name
          if (ctx.options.position === 'tab') cmd = 'tabe'
          let fullpath = path.join(root, filepath)
          await workspace.jumpTo(Uri.file(fullpath).toString(), null, cmd)
          return
        }
        let content = await runCommand(`git cat-file -p ${sha}`, { cwd: root })
        let lines = content.replace(/\n$/, '').split('\n')
        let cmd = name == 'edit' ? jumpCommand : name
        nvim.pauseNotification()
        nvim.command(`exe "${cmd} ".fnameescape('(${branch}) ${filepath}')`, true)
        nvim.call('append', [0, lines], true)
        nvim.command('normal! Gdd', true)
        nvim.command(`exe 1`, true)
        nvim.command('setl buftype=nofile nomodifiable bufhidden=wipe nobuflisted', true)
        nvim.command('filetype detect', true)
        await nvim.resumeNotification()
      }, { tabPersist: name === 'edit' })
    }

    this.addAction('preview', async (item, context) => {
      let { root, sha, filepath, branch } = item.data
      if (!sha) return
      let content = await runCommand(`git --no-pager diff --no-ext-diff ${branch} -- ${shellescape(filepath)}`, { cwd: root })
      let lines = content.replace(/\n$/, '').split('\n')
      await this.preview({
        lines,
        filetype: 'diff',
        sketch: true,
        bufname: `(diff ${branch}) ${path.basename(filepath)}`
      }, context)
    })
  }

  public async loadItems(context: ListContext): Promise<ListItem[]> {
    let buf = await context.window.buffer
    let root = await this.manager.resolveGitRootFromBufferOrCwd(buf.id)
    if (!root) {
      throw new Error(`Can't resolve git root.`)
      return
    }
    const { args } = context
    let arg = args.length ? args.join(' ') : 'HEAD'
    let output = await runCommand(`git ls-tree -r ${arg}`, { cwd: root })
    output = output.replace(/\s+$/, '')
    if (!output) return []
    // let root = this.manager.refreshStatus
    let res: ListItem[] = []
    for (let line of output.split(/\r?\n/)) {
      let [head, filepath] = line.split('\t', 2)
      let sha = head.split(' ')[2]
      res.push({
        label: filepath,
        data: {
          branch: args[0] || 'HEAD',
          filepath,
          root,
          sha
        }
      })
    }
    return res
  }
}
