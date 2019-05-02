import { IList, ListAction, ListContext, ListItem, Neovim, workspace } from 'coc.nvim'
import colors from 'colors/safe'
import Manager from '../manager'
import { runCommand } from '../util'

export default class Branches implements IList {
  public readonly name = 'branches'
  public readonly description = 'git branches'
  public readonly defaultAction = 'checkout'
  public actions: ListAction[] = []

  constructor(private nvim: Neovim, private manager: Manager) {
    this.actions.push({
      name: 'checkout',
      execute: async (item: ListItem) => {
        let { root, branch } = item.data
        await runCommand(`git checkout ${branch}`, { cwd: root })
        await nvim.command('bufdo e')
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
          let res = await workspace.showPrompt(`Delete remote branch ${branch}?`)
          if (!res) return
          let parts = branch.split('/', 2)
          cmd = `git push ${parts[0]} --delete ${parts[1]}`
          await runCommand(cmd, { cwd: root })
          await runCommand(`git fetch -p ${parts[0]}`)
        } else {
          cmd = `git branch -d ${branch}`
          try {
            await runCommand(cmd, { cwd: root })
          } catch (e) {
            let res = await workspace.showPrompt(`Delete failed, force delete ${branch}?`)
            if (!res) return
            await runCommand(`git branch -D ${branch}`, { cwd: root })
          }
        }
      }
    })
    this.actions.push({
      name: 'merge',
      execute: async (item: ListItem) => {
        let { root, branch } = item.data
        let cmd = `git merge ${branch}`
        await runCommand(cmd, { cwd: root })
        await nvim.command('bufdo e')
      }
    })
    this.actions.push({
      name: 'rebase',
      execute: async (item: ListItem) => {
        let { root, branch } = item.data
        let cmd = `git rebase ${branch}`
        await runCommand(cmd, { cwd: root })
        await nvim.command('bufdo e')
      }
    })
  }

  public async loadItems(context: ListContext): Promise<ListItem[]> {
    let res: ListItem[] = []
    let buf = await context.window.buffer
    let root = await this.manager.resolveGitRoot(buf.id)
    if (!root) {
      throw new Error(`Can't resolve git root.`)
      return
    }
    let output = await runCommand(`git branch --no-color -a ${context.args.join(' ')}`, { cwd: root })
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
