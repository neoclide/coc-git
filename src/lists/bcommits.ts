import { ChildProcess, spawn } from 'child_process'
import { Uri, events, ansiparse, BasicList, ListAction, ListContext, ListTask, Neovim, workspace } from 'coc.nvim'
import { runCommand, showEmptyPreview } from '../util'
import { EventEmitter } from 'events'
import readline from 'readline'
import Manager from '../manager'
import path from 'path'

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
      let winid = context.listWindow.id
      let mod = context.options.position == 'top' ? 'below' : 'above'
      let { commit, root } = item.data
      if (!commit) {
        await showEmptyPreview(mod, winid)
        return
      }
      let content = await runCommand(`git --no-pager show ${commit}`, { cwd: root })
      let lines = content.trim().split('\n')
      nvim.pauseNotification()
      nvim.command('pclose', true)
      nvim.command(`${mod} ${this.previewHeight}sp +setl\\ previewwindow [commit ${commit}]`, true)
      nvim.command('setl winfixheight buftype=nofile foldmethod=syntax', true)
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
    let buf = await context.window.buffer
    let root = await this.manager.resolveGitRoot(buf.id)
    if (!root) {
      throw new Error(`Can't resolve git root.`)
      return
    }
    let doc = workspace.getDocument(buf.id)
    if (!doc || doc.schema != 'file') {
      throw new Error(`Current buffer is not file`)
      return
    }
    let file = path.relative(root, Uri.parse(doc.uri).fsPath)
    const output = await runCommand(`git ls-files ${context.args.join(' ')} -- ${file}`)
    if (!output.trim()) {
      throw new Error(`${file} not indexed`)
      return
    }
    this.bufnr = buf.id
    const args = ['--no-pager', 'log', '--pretty', '--color',
      `--format=%Cred%h%Creset -%C(yellow)%d%Creset %s %Cgreen(%cr) %C(bold blue)<%an>%Creset`,
      '--abbrev-commit', '--date=iso', '--', file]
    let task = new CommitsTask(root, file)
    task.start('git', args, root)
    return task
  }
}
