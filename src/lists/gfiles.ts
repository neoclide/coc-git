import { BasicList, ListAction, ListContext, ListItem, Neovim, Uri, workspace } from 'coc.nvim'
import path from 'path'
import Manager from '../manager'

export function parseTreeEntry(entry: string): { sha: string, filepath: string } | undefined {
  const separator = entry.indexOf('\t')
  if (separator === -1) return undefined
  const head = entry.slice(0, separator)
  const filepath = entry.slice(separator + 1)
  const sha = head.split(/\s+/)[2]
  return sha ? { sha, filepath } : undefined
}

export default class Gfiles extends BasicList {
  public readonly name = 'gfiles'
  public readonly description = 'view files on different branches (or commits, or tags)'
  public readonly detail = 'Pass git sha as first command argument, when empty, HEAD is used.\nExample: :CocList gfiles 7b5c5cb'
  public readonly defaultAction = 'edit'
  public actions: ListAction[] = []

  constructor(nvim: Neovim, private manager: Manager) {
    super()
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
        let content = (await this.manager.git.exec(root, ['cat-file', '-p', sha])).stdout
        let lines = content.replace(/\n$/, '').split('\n')
        let cmd = name == 'edit' ? jumpCommand : name
        let bufferName = await nvim.call('fnameescape', [`(${branch}) ${filepath}`]) as string
        nvim.pauseNotification()
        nvim.command(`${cmd} ${bufferName}`, true)
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
      let content = (await this.manager.git.exec(root, ['--no-pager', 'diff', ...this.manager.diffOptions, '--no-ext-diff', branch, '--', filepath])).stdout
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
    let revisions = args.length ? args : ['HEAD']
    const output = (await this.manager.git.exec(root, ['-c', 'core.quotepath=false', 'ls-tree', '-r', '-z', ...revisions])).stdout
    if (!output) return []
    // let root = this.manager.refreshStatus
    let res: ListItem[] = []
    for (let line of output.split('\0')) {
      if (!line) continue
      const entry = parseTreeEntry(line)
      if (!entry) continue
      const { sha, filepath } = entry
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
