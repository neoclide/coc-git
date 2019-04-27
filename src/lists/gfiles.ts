import { BasicList, ListAction, ListContext, ListItem, Neovim } from 'coc.nvim'
import Manager from '../manager'
import { runCommand } from '../util'
import path from 'path'

export default class Gfiles extends BasicList {
  public readonly name = 'gfiles'
  public readonly description = 'view files on different branches (or commits, or tags)'
  public readonly defaultAction = 'show'
  public actions: ListAction[] = []

  constructor(nvim: Neovim, private manager: Manager) {
    super(nvim)
    this.addAction('show', async item => {
      let { root, sha, filepath, branch } = item.data
      if (!sha) return
      nvim.pauseNotification()
      nvim.command(`exe "lcd ".fnameescape('${root}')`, true)
      nvim.command(`new | read ! git cat-file -p ${sha}`, true)
      nvim.command('normal! ggdd', true)
      nvim.command('setl buftype=nofile nomodifiable bufhidden=wipe nobuflisted', true)
      nvim.command(`file (${branch}) ${path.basename(filepath)}`, true)
      nvim.command('filetype detect', true)
      await nvim.resumeNotification()
    })

    this.addAction('preview', async (item, context) => {
      let { root, sha, filepath, branch } = item.data
      if (!sha) return
      let content = await runCommand(`git cat-file -p ${sha}`, { cwd: root })
      let lines = content.replace(/\n$/, '').split('\n')
      let mod = context.options.position == 'top' ? 'below' : 'above'
      let winid = context.listWindow.id
      nvim.pauseNotification()
      nvim.command('pclose', true)
      nvim.command(`${mod} ${this.previewHeight}sp +setl\\ previewwindow (${branch}) ${path.basename(filepath)}`, true)
      nvim.call('append', [0, lines], true)
      nvim.command('normal! Gdd', true)
      nvim.command(`exe 1`, true)
      nvim.command('setl buftype=nofile nomodifiable bufhidden=wipe nobuflisted', true)
      nvim.command('filetype detect', true)
      nvim.call('win_gotoid', [winid], true)
      await nvim.resumeNotification()
    })

    this.addAction('diff', async item => {
      let { root, sha, filepath, branch } = item.data
      if (!sha) return
      let content = await runCommand(`git --no-pager diff ${branch} -- ${filepath}`, { cwd: root })
      let lines = content.replace(/\n$/, '').split('\n')
      nvim.pauseNotification()
      nvim.command(`edit (diff ${branch})`, true)
      nvim.call('append', [0, lines], true)
      nvim.command('normal! Gdd', true)
      nvim.command(`exe 1`, true)
      nvim.command('setl buftype=nofile nomodifiable bufhidden=wipe nobuflisted', true)
      nvim.command('setf diff', true)
      await nvim.resumeNotification()
    })
  }

  public async loadItems(context: ListContext): Promise<ListItem[]> {
    let buf = await context.window.buffer
    let root = await this.manager.resolveGitRoot(buf.id)
    if (!root) {
      throw new Error(`Can't resolve git root.`)
      return
    }
    const { args } = context
    let output = await runCommand(`git ls-tree -r ${args.length ? args[0] : 'HEAD'}`, { cwd: root })
    output = output.replace(/\s+$/, '')
    if (!output) return []
    // let root = this.manager.refreshStatus
    let res: ListItem[] = []
    for (let line of output.split(/\r?\n/)) {
      let [head, filepath] = line.split('\t', 2)
      let sha = head.split(" ")[2]
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
