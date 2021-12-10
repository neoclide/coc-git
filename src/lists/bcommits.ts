import { ChildProcess, spawn } from 'child_process'
import { ansiparse, BasicList, events, ListAction, ListContext, ListTask, Neovim, runCommand } from 'coc.nvim'
import { EventEmitter } from 'events'
import readline from 'readline'
import Manager from '../manager'
import { shellescape } from '../util'

class CommitsTask extends EventEmitter implements ListTask {
  private process: ChildProcess
  constructor(private root: string, private file: string) {
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
      let item = res.find(o => o.foreground == 'red' && o.text.length > 4)
      let commit = item ? item.text : ''
      this.emit('data', {
        label: line,
        data: {
          commit,
          file: this.file,
          root: this.root,
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

export default class Bcommits extends BasicList {
  public readonly name = 'bcommits'
  public readonly description = 'Commits of current file.'
  public readonly defaultAction = 'show'
  public actions: ListAction[] = []
  private bufnr: number

  constructor(nvim: Neovim, private manager: Manager) {
    super(nvim)
    this.addAction('preview', async (item, context) => {
      let { commit, root } = item.data
      let lines: string[] = []
      if (commit) {
        let content = await runCommand(`git --no-pager show ${commit}`, { cwd: root })
        lines = content.trim().split('\n')
      }
      await this.preview({
        lines,
        filetype: 'git',
        sketch: true,
        bufname: commit ? `[commit ${commit}]` : ''
      }, context)
    })
    this.addAction('show', async item => {
      let { commit, root } = item.data
      if (!commit) return
      let hasFugitive = await nvim.getVar('loaded_fugitive')
      if (hasFugitive) {
        await nvim.command(`G edit ${commit}`)
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
    this.addAction('view', async (item, context) => {
      let { commit, root, file } = item.data
      let { window, listWindow } = context
      let content = await runCommand(`git show ${commit}:${shellescape(file)}`, { cwd: root })
      let lines = content.replace(/\n$/, '').split('\n')
      nvim.pauseNotification()
      nvim.call('win_gotoid', [window.id], true)
      nvim.command(`exe "edit ".fnameescape('(${commit}) ${file}')`, true)
      nvim.call('append', [0, lines], true)
      nvim.command('normal! Gdd', true)
      nvim.command(`exe 1`, true)
      nvim.command('setl buftype=nofile nomodifiable bufhidden=wipe nobuflisted', true)
      nvim.command('filetype detect', true)
      nvim.call('win_gotoid', [listWindow.id], true)
      await nvim.resumeNotification()
    }, { persist: true })

    this.addAction('diff', async (item, context) => {
      let buffer = await context.window.buffer
      let filetype = await buffer.getOption('filetype')
      let { root, commit, file } = item.data
      if (!commit) return
      let content = await runCommand(`git --no-pager show --no-color ${commit}:${file}`, { cwd: root })
      if (!content) return
      let lines = content.replace(/\n$/, '').split(/\r?\n/)
      nvim.pauseNotification()
      nvim.command('diffoff', true)
      nvim.command('diffthis', true)
      nvim.command(`keepalt vsplit +setl\\ buftype=nofile [Git ${commit}]`, true)
      nvim.call('append', [0, lines], true)
      nvim.command('normal! Gdd', true)
      nvim.command(`exe 1`, true)
      nvim.command(`setf ${filetype}`, true)
      nvim.command('diffthis', true)
      nvim.command('setl foldenable', true)
      nvim.command(`call setwinvar(winnr(), 'easygit_diff_origin', ${buffer.id})`, true)
      nvim.command(`call setpos('.', [bufnr('%'), 0, 0, 0])`, true)
      await nvim.resumeNotification()
    })

    events.on('BufEnter', async bufnr => {
      if (!this.bufnr || bufnr != this.bufnr) return
      let diff = await nvim.eval('&diff')
      if (!diff) return
      let res = await nvim.eval(`map(getwininfo(), 'get(v:val["variables"], "easygit_diff_origin", 0)')`) as number[]
      let idx = res.findIndex(i => i == bufnr)
      if (idx == -1) await nvim.command('diffoff')
    }, null, this.disposables)
  }

  public async loadItems(context: ListContext): Promise<ListTask> {
    let buf = await this.manager.getBuffer(context.buffer.id)
    if (!buf) {
      throw new Error(`Can't resolve git root.`)
      return
    }
    let { relpath } = buf
    const output = await buf.repo.safeRun(['ls-files', ...context.args, '--', relpath])
    if (!output || output.trim().length == 0) {
      throw new Error(`${relpath} not indexed`)
      return
    }
    this.bufnr = context.buffer.id
    let root = buf.repo.root
    const args = ['--no-pager', 'log', '--pretty', '--color',
      `--format=%Cred%h%Creset -%C(yellow)%d%Creset %s %Cgreen(%cr) %C(bold blue)<%an>%Creset`,
      '--abbrev-commit', '--date=iso', '--', relpath]
    let task = new CommitsTask(root, relpath)
    task.start('git', args, root)
    return task
  }
}
