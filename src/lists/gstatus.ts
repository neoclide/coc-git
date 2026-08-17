import { BasicList, ListContext, ListItem, Neovim, Uri, window } from 'coc.nvim'
import colors from 'colors/safe'
import fs from 'fs'
import path from 'path'
import Manager from '../manager'
import { spawnCommand } from '../util'

const STATUS_MAP = {
  ' ': ' ',
  M: colors.cyan('~'),
  A: colors.green('+'),
  D: colors.red('-'),
  R: colors.magenta('→'),
  C: colors.yellow('C'),
  T: colors.yellow('T'),
  U: colors.blue('U'),
  '?': colors.gray('?'),
  '!': colors.gray('!')
}

export interface StatusEntry {
  index: string
  tree: string
  relative: string
}

export function parseStatusEntries(output: string): StatusEntry[] {
  let result: StatusEntry[] = []
  let entries = output.split('\0')
  for (let i = 0; i < entries.length; i++) {
    let line = entries[i]
    if (!line) continue
    result.push({ index: line[0], tree: line[1], relative: line.slice(3) })
    if (line[0] === 'R' || line[0] === 'C' || line[1] === 'R' || line[1] === 'C') {
      i++ // porcelain -z emits the original path as the following record
    }
  }
  return result
}

export default class GStatus extends BasicList {
  public readonly name = 'gstatus'
  public readonly description = 'Git status of current project'
  public readonly defaultAction = 'open'

  constructor(nvim: Neovim, private manager: Manager) {
    super()
    this.addLocationActions()
    this.addMultipleAction('add', async items => {
      let { root } = items[0].data
      let fileArgs = items.map(o => o.data.relative)
      await this.manager.git.exec(root, ['add', '--', ...fileArgs])
    }, { reload: true, persist: true })

    this.addMultipleAction('patch', async items => {
      let { root } = items[0].data
      let fileArgs = items.map(o => o.data.relative)
      let cmd = await this.manager.getTerminalGitCommand(['add', '--patch', '--', ...fileArgs])
      await nvim.call('coc#util#open_terminal', [{
        cmd,
        cwd: root
      }])
    })

    this.addMultipleAction('commit', async items => {
      let { root } = items[0].data
      let escapedRoot = await nvim.call('fnameescape', [root]) as string
      await nvim.command(`lcd ${escapedRoot}`)
      let escapedFiles = await Promise.all(items.map(item => nvim.call('fnameescape', [item.data.relative]) as Promise<string>))
      try {
        await nvim.command(`G commit -v -- ${escapedFiles.join(' ')}`)
      } catch (e) {
        window.showErrorMessage(`G commit command failed, make sure fugitive installed.`)
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
          await spawnCommand('rmtrash', [fullpath], root)
        } else {
          await fs.promises.unlink(fullpath)
        }
      }
      await this.nvim.command('checktime')
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
      let args = ['--no-pager', 'diff', '--no-ext-diff', ...this.manager.diffOptions]
      if (index_symbol == 'M' && tree_symbol != 'M') {
        args.push('--cached')
      }
      let content = (await this.manager.git.exec(root, [...args, '--', relative])).stdout
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
    await this.manager.git.exec(root, ['reset', '--', relative])
  }

  private async checkout(root: string, relative: string): Promise<void> {
    await this.manager.git.exec(root, ['checkout', '--', relative])
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
    let output = (await this.manager.git.exec(root, ['status', '--porcelain=v1', '-z', '-uall', ...context.args])).stdout
    if (!output) return []
    // let root = this.manager.refreshStatus
    let res: ListItem[] = []
    for (let entry of parseStatusEntries(output)) {
      let { index, tree, relative } = entry
      let filepath = path.join(root, relative)
      let index_symbol = STATUS_MAP[index]
      let tree_symbol = STATUS_MAP[tree]
      res.push({
        label: `${index_symbol}${tree_symbol} ${relative}`,
        filterText: relative,
        data: {
          root,
          relative,
          index_symbol: index,
          tree_symbol: tree,
          staged: index != ' ' && index != '?',
          tree: tree != ' ' && tree != '?',
        },
        location: Uri.file(filepath).toString()
      })
    }
    return res
  }
}
