import { ChildProcess } from 'child_process'
import { ansiparse, BasicList, ListContext, ListTask, Neovim } from 'coc.nvim'
import { EventEmitter } from 'events'
import readline from 'readline'
import Manager from '../manager'

class CommitsTask extends EventEmitter implements ListTask {
  private process: ChildProcess
  constructor(private root: string) {
    super()
  }

  public start(process: ChildProcess): void {
    this.process = process
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

export default class Commits extends BasicList {
  public readonly name = 'commits'
  public readonly description = 'Commits of current project.'
  public readonly defaultAction = 'show'
  private cachedCommits: Map<string, string[]> = new Map()

  private cacheKey(root: string, commit: string): string {
    return `${root}\0${commit}`
  }

  private getCached(root: string, commit: string): string[] | undefined {
    return this.cachedCommits.get(this.cacheKey(root, commit))
  }

  private setCached(root: string, commit: string, lines: string[]): void {
    const key = this.cacheKey(root, commit)
    this.cachedCommits.delete(key)
    this.cachedCommits.set(key, lines)
    if (this.cachedCommits.size > 100) {
      this.cachedCommits.delete(this.cachedCommits.keys().next().value)
    }
  }

  constructor(nvim: Neovim, private manager: Manager) {
    super()
    this.addAction('preview', async (item, context) => {
      let { commit, root } = item.data
      let lines: string[] = []
      if (commit) {
        lines = this.getCached(root, commit)
        if (!lines) {
          let content = (await this.manager.git.exec(root, ['--no-pager', 'show', commit])).stdout
          lines = content.replace(/\n$/, '').split(/\r?\n/)
          this.setCached(root, commit, lines)
        }
      }
      await this.preview({
        lines,
        filetype: 'git',
        sketch: true,
        bufname: commit ? `[commit ${commit}]` : ''
      }, context)
    })
    this.addAction('show', async (item, ctx) => {
      let { commit, root } = item.data
      if (!commit) return
      let hasFugitive = await nvim.getVar('loaded_fugitive')
      if (hasFugitive) {
        let cmd = ctx.options.position === 'tab' ? 'Gtabedit' : 'Gedit'
        await nvim.command(`${cmd} ${commit}`)
      } else {
        let lines = this.getCached(root, commit)
        if (!lines) {
          let content = (await this.manager.git.exec(root, ['--no-pager', 'show', commit])).stdout
          lines = content.replace(/\n$/, '').split(/\r?\n/)
          this.setCached(root, commit, lines)
        }
        let cmd = ctx.options.position === 'tab' ? 'tabe' : 'edit'
        nvim.pauseNotification()
        nvim.command(`${cmd} +setl\\ buftype=nofile [commit ${commit}]`, true)
        nvim.command('setl foldmethod=syntax nobuflisted bufhidden=wipe', true)
        nvim.command('setf git', true)
        nvim.call('append', [0, lines], true)
        nvim.command('normal! Gdd', true)
        nvim.command(`exe 1`, true)
        await nvim.resumeNotification()
      }
    }, { tabPersist: true })
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
      await this.manager.git.exec(root, ['reset', opt, commit])
      await this.nvim.command('checktime')
    })
    this.addAction('checkout', async item => {
      let { root, commit } = item.data
      if (!commit) return
      await this.manager.git.exec(root, ['checkout', commit])
    })
    this.addMultipleAction('revert', async items => {
      let list = items.filter(item => item.data.commit != null)
      if (!list.length) return
      await this.manager.git.exec(list[0].data.root, ['revert', ...list.map(o => o.data.commit)])
    })
    this.addMultipleAction('tabdiff', async items => {
      let list = items.filter(item => item.data.commit != null)
      if (!list.length) return
      let arg: string
      if (list.length == 1) {
        arg = `${list[0].data.commit} HEAD`
      } else {
        arg = `${list[1].data.commit} ${list[0].data.commit}`
      }
      let content = (await this.manager.git.exec(list[0].data.root, ['--no-pager', 'diff', '--no-ext-diff', ...this.manager.diffOptions, ...arg.split(' ')])).stdout
      let lines = content.replace(/\n$/, '').split('\n')
      nvim.pauseNotification()
      nvim.command(`tabe [diff ${arg}]`, true)
      nvim.command('setl winfixheight buftype=nofile foldmethod=syntax nofen', true)
      nvim.command('setl nobuflisted bufhidden=wipe', true)
      nvim.command('setf git', true)
      nvim.call('append', [0, lines], true)
      nvim.command('normal! Gdd', true)
      nvim.command(`exe 1`, true)
      await nvim.resumeNotification()
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
      let content = (await this.manager.git.exec(list[0].data.root, ['--no-pager', 'diff', ...this.manager.diffOptions, '--no-ext-diff', ...arg.split(' ')])).stdout
      let lines = content.replace(/\n$/, '').split('\n')
      let winid = context.listWindow.id
      let mod = context.options.position == 'tab' ? 'below' : 'above'
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
      await this.nvim.call('setreg', ['+', lines.join('\n')])
    }, { persist: true })
    this.addAction('files', async item => {
      let { commit } = item.data
      if (!commit) return
      nvim.command(`CocList gfiles ${commit}`, true)
    })
  }

  public async loadItems(context: ListContext): Promise<ListTask> {
    let buf = await context.window.buffer
    let root = await this.manager.resolveGitRootFromBufferOrCwd(buf.id)
    if (!root) {
      throw new Error(`Can't resolve git root.`)
      return
    }
    const args = ['--no-pager', 'log', '--graph', '--pretty', '--color',
      `--format=%Cred%h%Creset -%C(yellow)%d%Creset %s %Cgreen(%cd) %C(bold blue)<%an>%Creset`,
      '--abbrev-commit', ...context.args]
    let task = new CommitsTask(root)
    task.start(this.manager.git.stream(root, args))
    return task
  }
}
