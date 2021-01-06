import { IList, ListAction, ListContext, ListItem, Neovim, window } from 'coc.nvim'
import colors from 'colors/safe'
import Manager from '../manager'
import { safeRun } from '../util'

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
        await safeRun(`git checkout ${branch}`, { cwd: root })
        nvim.command('bufdo e', true)
      }
    })
    this.actions.push({
      name: 'delete',
      persist: true,
      reload: true,
      execute: async (item: ListItem) => {
        let cmd: string
        let { root, branch, remote } = item.data
        if (remote) {
          let res = await window.showPrompt(`Delete remote branch ${branch}?`)
          if (!res) return
          let parts = branch.split('/', 2)
          cmd = `git push ${parts[0]} --delete ${parts[1]}`
          await safeRun(cmd, { cwd: root })
          await safeRun(`git fetch -p ${parts[0]}`)
        } else {
          cmd = `git branch -d ${branch}`
          let res = await safeRun(cmd, { cwd: root })
          if (res == null) {
            let res = await window.showPrompt(`Delete failed, force delete ${branch}?`)
            if (!res) return
            await safeRun(`git branch -D ${branch}`, { cwd: root })
          }
        }
      }
    })
    this.actions.push({
      name: 'merge',
      execute: async (item: ListItem) => {
        let { root, branch } = item.data
        let cmd = `git merge ${branch}`
        await safeRun(cmd, { cwd: root })
        nvim.command('bufdo e', true)
      }
    })
    this.actions.push({
      name: 'rebase',
      execute: async (item: ListItem) => {
        let { root, branch } = item.data
        let cmd = `git rebase ${branch}`
        await safeRun(cmd, { cwd: root })
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
    let output = result.stdout.trim()
    if (output == null) return
    output = output.replace(/\s+$/, '')
    for (let line of output.split(/\r?\n/)) {
      let remote = line.slice(2).startsWith('remotes/')
      res.push({
        label: colors.yellow(line.slice(0, 2)) + line.slice(2),
        filterText: line.slice(2),
        data: {
          current: line[0] == '*',
          root,
          branch: remote ? line.slice(10) : line.slice(2),
          remote
        }
      })
    }
    return res
  }
}
