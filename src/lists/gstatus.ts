import { BasicList, ListContext, ListItem, Neovim, Uri, window } from 'coc.nvim'
import colors from 'colors/safe'
import fs from 'fs'
import path from 'path'
import Manager from '../manager'
import { runCommand, spawnCommand, wait } from '../util'

const STATUS_MAP = {
  ' ': ' ',
  M: colors.cyan('~'),
  A: colors.green('+'),
  D: colors.red('-'),
  R: colors.magenta('→'),
  C: colors.yellow('C'),
  U: colors.blue('U'),
  '?': colors.gray('?')
}

export default class GStatus extends BasicList {
  public readonly name = 'gstatus'
  public readonly description = 'Git status of current project'
  public readonly defaultAction = 'open'

  constructor(nvim: Neovim, private manager: Manager) {
    super(nvim)
    this.addLocationActions()
    this.addMultipleAction('add', async items => {
      let { root } = items[0].data
      let fileArgs = items.map(o => o.data.relative)
      await spawnCommand('git', ['add', ...fileArgs], root)
    }, { reload: true, persist: true })

    this.addMultipleAction('patch', async items => {
      let { root } = items[0].data
      let fileArgs = items.map(o => o.data.relative.replace(/\s/, '\\ '))
      let cmd = `git add ${fileArgs.join(' ')} --patch`
      await nvim.call('coc#util#open_terminal', [{
        cmd,
        cwd: root
      }])
    })

    this.addMultipleAction('commit', async items => {
      let { root } = items[0].data
      await nvim.command(`exe "lcd ".fnameescape('${root}')`)
      let filesArg = await nvim.eval(`join(map([${items.map(s => "'" + s.data.relative + "'").join(',')}],'fnameescape(v:val)'),' ')`)
      try {
        await nvim.command(`G commit -v ${filesArg}`)
      } catch (e) {
        window.showMessage(`G commit command failed, make sure fugitive installed.`, 'error')
      }
    })

    this.addAction('reset', async item => {
      let { staged, tree, relative, root } = item.data
      if (staged && tree) {
        let choices = ['&Reset', '&Checkout']
        let n = await nvim.call('confirm', [`Choose action for ${relative}:`, choices.join('\n')]) as number
        if (!n || n < 1) return
        if (n == 1) {
          await this.reset(root, relative)
        } else {
          await this.checkout(root, relative)
        }
      } else if (tree) {
        await this.checkout(root, relative)
      } else if (staged) {
        await this.reset(root, relative)
      } else {
        let confirmed = await window.showPrompt(`remove ${relative}?`)
        if (!confirmed) return
        let hasRmtrash = await nvim.call('executable', ['rmtrash'])
        let fullpath = path.join(root, relative)
        if (hasRmtrash) {
          await runCommand(`rmtrash ${fullpath.replace(/\s/, '\\ ')}`)
        } else {
          fs.unlinkSync(fullpath)
        }
      }
      this.nvim.command('checktime', true)
      await wait(100)
    }, { reload: true, persist: true })

    // preview the diff
    this.addAction('preview', async (item, context) => {
      let { tree_symbol, index_symbol, root, relative } = item.data
      if (tree_symbol != 'M' && index_symbol != 'M') {
        await this.previewLocation({
          uri: Uri.file(path.join(root, relative)).toString(),
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 }
          }
        }, context)
        return
      }
      let args = ['--no-pager', 'diff', '--no-ext-diff']
      if (index_symbol == 'M' && tree_symbol != 'M') {
        args.push('--cached')
      }
      let cmd = `git ${args.join(' ')} ${relative}`
      let content = await runCommand(cmd, { cwd: root })
      let lines = content.trim().split('\n')
      await this.preview({
        lines,
        filetype: 'diff',
        sketch: true,
        bufname: `(diff) ${relative}`
      }, context)
    })
  }

  private async reset(root: string, relative: string): Promise<void> {
    await spawnCommand('git', ['reset', 'HEAD', '--', relative], root)
  }

  private async checkout(root: string, relative: string): Promise<void> {
    await spawnCommand('git', ['checkout', '--', relative], root)
  }

  public async loadItems(context: ListContext): Promise<ListItem[]> {
    let buf = await context.window.buffer
    let root = await this.manager.resolveGitRootFromBufferOrCwd(buf.id)
    if (!root) {
      throw new Error(`Can't resolve git root.`)
      return
    }
    if (this.manager.gstatusSaveBeforeOpen) {
     await this.nvim.command(`wa`)
    }
    let output = await runCommand(`git status --porcelain -uall ${context.args.join(' ')}`, { cwd: root })
    output = output.replace(/\s+$/, '')
    if (!output) return []
    // let root = this.manager.refreshStatus
    let res: ListItem[] = []
    for (let line of output.split(/\r?\n/)) {
      let filepath = path.join(root, line.slice(3))
      let index_symbol = STATUS_MAP[line[0]]
      let tree_symbol = STATUS_MAP[line[1]]
      res.push({
        label: `${index_symbol}${tree_symbol} ${line.slice(3)}`,
        filterText: line.slice(3),
        data: {
          root,
          relative: line.slice(3),
          index_symbol: line[0],
          tree_symbol: line[1],
          staged: line[0] != ' ' && line[0] != '?',
          tree: line[1] != ' ' && line[1] != '?',
        },
        location: Uri.file(filepath).toString()
      })
    }
    return res
  }
}
