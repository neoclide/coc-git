import { workspace, events, Disposable, Mutex, disposeAll } from 'coc.nvim'
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
  constructor(private service: GitService) {
    let config = workspace.getConfiguration('git')
    this._enabled = config.get<boolean>('enableGlobalStatus', true)
    this.branchCharacter = config.get<string>('branchCharacter', '')
    this.characters = {
      changedDecorator: config.get<string>('changedDecorator'),
      conflictedDecorator: config.get<string>('conflictedDecorator'),
      stagedDecorator: config.get<string>('stagedDecorator'),
      untrackedDecorator: config.get<string>('untrackedDecorator'),
    }
    events.on('BufEnter', this.refresh, this, this.disposables)
    events.on('FocusGained', this.refresh, this, this.disposables)
    let timer: NodeJS.Timer
    events.on('BufWritePost', () => {
      timer = setTimeout(() => {
        this.refresh()
      }, 300)
    }, this, this.disposables)
    this.disposables.push({
      dispose: () => {
        if (timer) clearTimeout(timer)
      }
    })
    this.refresh().catch(_e => {
      // noop
    })
  }

  private async refresh(): Promise<void> {
    if (!this._enabled) return
    let release = await this.mutex.acquire()
    try {
      let repo = await this.service.getCurrentRepo()
      if (repo) {
        let status = await repo.getStatus(this.branchCharacter, this.characters)
        this.setGitStatus(status || '')
      } else {
        this.setGitStatus('')
      }
    } catch (e) {
      this.service.log(`[Error] error on refresh: ${e.message}`)
    }
    release()
  }

  private setGitStatus(status: string): void {
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
  }
}
