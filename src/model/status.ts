import { Disposable, Mutex, disposeAll, events, workspace } from 'coc.nvim'
import { Decorator } from '../types'
import GitService from './service'

// global coc_git_status
export default class GitStatus implements Disposable {
  private disposables: Disposable[] = []
  private _enabled = false
  private gitStatus: string
  private mutex: Mutex = new Mutex()
  private characters: Decorator
  private branchCharacter: string
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  constructor(private service: GitService) {
    this.loadConfiguration()
    workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('git')) return
      this.loadConfiguration()
      if (!this._enabled) this.setGitStatus('')
      this.scheduleRefresh(0)
    }, null, this.disposables)
    events.on('BufEnter', () => this.scheduleRefresh(100), this, this.disposables)
    events.on('FocusGained', () => this.scheduleRefresh(100), this, this.disposables)
    events.on('BufWritePost', () => this.scheduleRefresh(50), this, this.disposables)
    this.disposables.push({ dispose: () => this.clearTimer() })
    this.scheduleRefresh(300)
  }

  private loadConfiguration(): void {
    let config = workspace.getConfiguration('git')
    this._enabled = config.get<boolean>('enableGlobalStatus', true)
    this.branchCharacter = config.get<string>('branchCharacter', '')
    this.characters = {
      changedDecorator: config.get<string>('changedDecorator'),
      conflictedDecorator: config.get<string>('conflictedDecorator'),
      stagedDecorator: config.get<string>('stagedDecorator'),
      untrackedDecorator: config.get<string>('untrackedDecorator'),
    }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  private scheduleRefresh(delay: number): void {
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.refresh().catch(e => this.service.log(`[Error] error on refresh: ${e.message}`))
    }, delay)
  }

  private async refresh(): Promise<void> {
    if (!this._enabled || this.disposed) return
    let release = await this.mutex.acquire()
    try {
      if (this.disposed) return
      let repo = await this.service.getCurrentRepo()
      if (this.disposed) return
      if (repo) {
        let status = await repo.getStatus(this.branchCharacter, this.characters)
        if (!this._enabled || this.disposed) return
        this.setGitStatus(status || '')
      } else {
        this.setGitStatus('')
      }
    } catch (e) {
      this.service.log(`[Error] error on refresh: ${e.message}`)
    } finally {
      release()
    }
  }

  private setGitStatus(status: string): void {
    if (this.disposed) return
    if (this.gitStatus == status) return
    this.gitStatus = status
    let { nvim } = workspace
    nvim.pauseNotification()
    nvim.setVar('coc_git_status', status, true)
    nvim.call('coc#util#do_autocmd', ['CocGitStatusChange'], true)
    nvim.resumeNotification(false, true)
  }

  public dispose(): void {
    disposeAll(this.disposables)
    this.setGitStatus('')
    this.disposed = true
  }
}
