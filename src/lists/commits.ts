import { ChildProcess, spawn } from 'child_process'
import { ansiparse, BasicList, ListAction, ListContext, ListTask, Neovim } from 'coc.nvim'
import { EventEmitter } from 'events'
import readline from 'readline'
import Manager from '../manager'
import { runCommandWithData, runCommand } from '../util'

class CommitsTask extends EventEmitter implements ListTask {
  private process: ChildProcess
  constructor(private root: string) {
    super()
  }

  public start(cmd: string, args: string[], cwd: string): void {
    this.process = spawn(cmd, args, { cwd })
    this.process.on('error', e => {
      this.emit('error', e.message)
    })
    this.process.stderr.on('data', chunk => {
      console.error(chunk.toString('utf8')) // tslint:disable-line
    })
    const rl = readline.createInterface(this.process.stdout)
    rl.on('line', line => {
      if (!line.length) return
      let res = ansiparse(line)
      let idx = res.findIndex(o => o.foreground == 'yellow')
      let message = idx == -1 ? null : res[idx + 1].text
      this.emit('data', {
        label: line,
        data: {
          root: this.root,
          commit: res.length > 5 ? res[1].text : null,
          message: message ? message.trim() : null
        }
      })
    })
    rl.on('close', () => {
      this.emit('end')
    })
  }

  public dispose(): void {
    if (this.process) {
      this.process.kill()
    }
  }
}

export default class Commits extends BasicList {
  public readonly name = 'commits'
  public readonly description = 'Commits of current project.'
  public readonly defaultAction = 'show'
  public actions: ListAction[] = []

  constructor(nvim: Neovim, private manager: Manager) {
    super(nvim)
    this.addAction('preview', async (item, context) => {
      let { commit, root } = item.data
      if (!commit) {
        await nvim.command('pclose')
        return
      }
      let content = await runCommand(`git --no-pager show ${commit}`, { cwd: root })
      let lines = content.replace(/\n$/, '').split('\n')
      let winid = context.listWindow.id
      let mod = context.options.position == 'top' ? 'below' : 'above'
      nvim.pauseNotification()
      nvim.command('pclose', true)
      nvim.command(`${mod} ${this.previewHeight}sp +setl\\ previewwindow [commit ${commit}]`, true)
      nvim.command('setl winfixheight buftype=nofile foldmethod=syntax foldenable', true)
      nvim.command('setl nobuflisted bufhidden=wipe', true)
      nvim.command('setf git', true)
      nvim.call('append', [0, lines], true)
      nvim.command('normal! Gdd', true)
      nvim.command(`exe 1`, true)
      nvim.call('win_gotoid', [winid], true)
      await nvim.resumeNotification()
    })
    this.addAction('show', async item => {
      let { commit, root } = item.data
      if (!commit) return
      let hasFugitive = await nvim.getVar('loaded_fugitive')
      if (hasFugitive) {
        await nvim.command(`Gedit ${commit}`)
      } else {
        let content = await runCommand(`git --no-pager show ${commit}`, { cwd: root })
        let lines = content.trim().split('\n')
        nvim.pauseNotification()
        nvim.command(`edit +setl\\ buftype=nofile [commit ${commit}]`, true)
        nvim.command('setl foldmethod=syntax nobuflisted bufhidden=wipe', true)
        nvim.command('setf git', true)
        nvim.call('append', [0, lines], true)
        nvim.command('normal! Gdd', true)
        nvim.command(`exe 1`, true)
        await nvim.resumeNotification()
      }
    })
    this.addAction('reset', async item => {
      let { root, commit } = item.data
      if (!commit) return
      let choices = ['&Mixed', '&Soft', '&Hard']
      let n = await nvim.call('confirm', [`Choose mode for reset:`, choices.join('\n')]) as number
      if (!n || n < 1) return
      let opt = ''
      switch (n) {
        case 1:
          opt = '--mixed'
          break
        case 2:
          opt = '--soft'
          break
        case 3:
          opt = '--hard'
          break
      }
      await runCommand(`git reset ${opt} ${commit}`, { cwd: root })
    })
    this.addAction('checkout', async item => {
      let { root, commit } = item.data
      if (!commit) return
      await runCommand(`git checkout ${commit}`, { cwd: root })
    })
    this.addMultipleAction('revert', async items => {
      let list = items.filter(item => item.data.commit != null)
      if (!list.length) return
      let arg = list.map(o => o.data.commit).join(' ')
      await runCommand(`git revert ${arg}`, { cwd: list[0].data.root })
    })
    this.addMultipleAction('diff', async (items, context) => {
      let list = items.filter(item => item.data.commit != null)
      if (!list.length) {
        nvim.command('pclose', true)
        return
      }
      let arg: string
      if (list.length == 1) {
        arg = `${list[0].data.commit} HEAD`
      } else {
        arg = `${list[1].data.commit} ${list[0].data.commit}`
      }
      // await runCommand
      let content = await runCommand(`git --no-pager diff ${arg}`, { cwd: list[0].data.root })
      let lines = content.replace(/\n$/, '').split('\n')
      let winid = context.listWindow.id
      let mod = context.options.position == 'top' ? 'below' : 'above'
      nvim.pauseNotification()
      nvim.command('pclose', true)
      nvim.command(`${mod} ${this.previewHeight}sp +setl\\ previewwindow [diff ${arg}]`, true)
      nvim.command('setl winfixheight buftype=nofile foldmethod=syntax foldenable', true)
      nvim.command('setl nobuflisted bufhidden=wipe', true)
      nvim.command('setf git', true)
      nvim.call('append', [0, lines], true)
      nvim.command('normal! Gdd', true)
      nvim.command(`exe 1`, true)
      nvim.call('win_gotoid', [winid], true)
      await nvim.resumeNotification()
    }, { persist: true, reload: false })
    this.addMultipleAction('copy', async items => {
      let list = items.filter(item => item.data.message != null)
      let lines = list.map(o => o.data.message)
      await runCommandWithData('pbcopy', [], process.cwd(), lines.join('\n'))
    })
    this.addAction('files', async item => {
      let { commit } = item.data
      if (!commit) return
      nvim.command(`CocList gfiles ${commit}`, true)
    })
  }

  public async loadItems(context: ListContext): Promise<ListTask> {
    let buf = await context.window.buffer
    let root = await this.manager.resolveGitRoot(buf.id)
    if (!root) {
      throw new Error(`Can't resolve git root.`)
      return
    }
    const args = ['--no-pager', 'log', '--graph', '--pretty', '--color',
      `--format=%Cred%h%Creset -%C(yellow)%d%Creset %s %Cgreen(%cd) %C(bold blue)<%an>%Creset`,
      '--abbrev-commit', '--date=iso']
    let task = new CommitsTask(root)
    task.start('git', args, root)
    return task
  }
}
