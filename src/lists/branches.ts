import { IList, ListAction, ListContext, ListItem, Neovim, window } from 'coc.nvim'
import colors from 'colors/safe'
import Manager from '../manager'

export interface BranchItemData {
  current: boolean
  branch: string
  remote: boolean
}

export function parseBranchLine(line: string): BranchItemData | undefined {
  const name = line.slice(2)
  if (!name || name.includes(' -> ')) return undefined
  const remote = name.startsWith('remotes/')
  return {
    current: line[0] == '*',
    branch: remote ? name.slice('remotes/'.length) : name,
    remote
  }
}

export default class Branches implements IList {
  public readonly name = 'branches'
  public readonly description = 'git branches'
  public readonly defaultAction = 'checkout'
  public actions: ListAction[] = []

  constructor(nvim: Neovim, private manager: Manager) {
    this.actions.push({
      name: 'checkout',
      execute: async (item: ListItem) => {
        let { root, branch } = item.data
        await this.manager.git.exec(root, ['checkout', branch])
        nvim.command('bufdo e', true)
      }
    })
    this.actions.push({
      name: 'delete',
      persist: true,
      reload: true,
      execute: async (item: ListItem) => {
        let { root, branch, remote } = item.data
        if (remote) {
          let res = await window.showPrompt(`Delete remote branch ${branch}?`)
          if (!res) return
          let separator = branch.indexOf('/')
          if (separator === -1) throw new Error(`Invalid remote branch: ${branch}`)
          let remoteName = branch.slice(0, separator)
          let remoteBranch = branch.slice(separator + 1)
          await this.manager.git.exec(root, ['push', remoteName, '--delete', remoteBranch])
          await this.manager.git.exec(root, ['fetch', '-p', remoteName])
        } else {
          try {
            await this.manager.git.exec(root, ['branch', '-d', branch])
          } catch (_e) {
            let res = await window.showPrompt(`Delete failed, force delete ${branch}?`)
            if (!res) return
            await this.manager.git.exec(root, ['branch', '-D', branch])
          }
        }
      }
    })
    this.actions.push({
      name: 'merge',
      execute: async (item: ListItem) => {
        let { root, branch } = item.data
        await this.manager.git.exec(root, ['merge', branch])
        nvim.command('bufdo e', true)
      }
    })
    this.actions.push({
      name: 'rebase',
      execute: async (item: ListItem) => {
        let { root, branch } = item.data
        await this.manager.git.exec(root, ['rebase', branch])
        nvim.command('bufdo e', true)
      }
    })
  }

  public async loadItems(context: ListContext): Promise<ListItem[]> {
    let res: ListItem[] = []
    let buf = await context.window.buffer
    let root = await this.manager.resolveGitRootFromBufferOrCwd(buf.id)
    if (!root) {
      throw new Error(`Can't resolve git root.`)
      return
    }
    let result = await this.manager.git.exec(root, ['branch', '--no-color', ...context.args])
    let output = result.stdout
    if (output == null) return
    output = output.replace(/\s+$/, '')
    for (let line of output.split(/\r?\n/)) {
      const data = parseBranchLine(line)
      if (!data) continue
      res.push({
        label: colors.yellow(line.slice(0, 2)) + line.slice(2),
        filterText: line.slice(2),
        data: {
          root,
          ...data
        }
      })
    }
    return res
  }
}
