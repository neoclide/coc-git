import { ConfigurationChangeEvent, Disposable, disposeAll, Document, events, Neovim, window, workspace } from 'coc.nvim'
import debounce from 'debounce'
import GitBuffer from './model/buffer'
import Git from './model/git'
import Service from './model/service'
import GitStatus from './model/status'
import { ConflictPart, Diff, DiffCategory, GitConfiguration } from './types'

export default class DocumentManager {
  private buffers: Map<number, GitBuffer> = new Map()
  private gitStatus: GitStatus
  private config: GitConfiguration
  private disposables: Disposable[] = []
  private defined = false
  constructor(
    private nvim: Neovim,
    private service: Service,
    private virtualTextSrcId: number,
    private conflictSrcId: number = 0
  ) {
    this.loadConfiguration()
    workspace.onDidChangeConfiguration(this.loadConfiguration, this, this.disposables)
    this.gitStatus = new GitStatus(service)
    this.disposables.push(workspace.registerBufferSync((doc: Document) => {
      let disposed = false
      let gitBuffer: GitBuffer
      let { bufnr, uri } = doc
      service.createBuffer(doc, this.config).then(buf => {
        if (!buf) return
        if (disposed) {
          buf.dispose()
          return
        }
        gitBuffer = buf
        this.defineSigns().catch(e => {
          console.error(e.message)
        })
        this.buffers.set(doc.bufnr, buf)
      }).catch(e => {
        service.log(`[Error] unable to create git buffer for ${uri}: ${e.message}`)
      })
      return {
        onChange: e => {
          if (gitBuffer) {
            if (e.contentChanges.some(change => change.text.includes('<<<<<<<'))) {
              gitBuffer.markConflictCheck()
            }
            gitBuffer._refresh().catch(e => service.log(`[Error] refresh error: ${e.message}`))
          }
        },
        dispose: () => {
          disposed = true
          this.buffers.delete(bufnr)
          this.service.resolver.delete(uri)
          if (gitBuffer) gitBuffer.dispose()
        }
      }
    }))
    const cursorMoved = debounce(async (bufnr, cursor) => {
      let buf = this.buffers.get(bufnr)
      if (buf) {
        try {
          await buf.showBlameInfo(cursor[0])
        } catch (e) {
          service.log(`[Error] unable to show blame: ${e.message}`)
        }
      }
    }, 100)
    events.on('CursorMoved', cursorMoved, null, this.disposables)
    this.disposables.push({ dispose: () => cursorMoved.clear() })
    this.disposables.push(workspace.registerAutocmd({
      event: 'BufWritePost',
      arglist: ["+expand('<abuf>')"],
      callback: bufnr => {
        if (!this.enableGutters || this.config.realtimeGutters) return
        let buf = this.buffers.get(bufnr)
        if (buf) {
          buf.diffDocument(true).catch(e => service.log(`[Error] refresh error: ${e.message}`))
        }
      }
    }))
    events.on('FocusGained', async () => {
      let bufnr = await nvim.call('bufnr', ['%']) as number
      let buf = this.buffers.get(bufnr)
      if (buf) {
        buf.markConflictCheck()
        buf.refresh()
      }
    }, null, this.disposables)
    events.on('BufEnter', bufnr => {
      let buf = this.buffers.get(bufnr)
      if (buf) {
        buf.markConflictCheck()
        buf.refresh()
      }
    }, null, this.disposables)
  }

  private async defineSigns(): Promise<void> {
    if (!this.enableGutters || this.defined) return
    this.defined = true
    let { nvim } = this
    const config = workspace.getConfiguration('git')
    let items = ['Changed', 'Added', 'Removed', 'TopRemoved', 'ChangeRemoved']
    nvim.pauseNotification()
    for (let item of items) {
      let section = item[0].toLowerCase() + item.slice(1) + 'Sign'
      let text = config.get<string>(`${section}.text`, '')
      let hlGroup = config.get<string>(`${section}.hlGroup`, '')
      nvim.command(`sign define CocGit${item} text=${text} texthl=CocGit${item}Sign`, true)
      nvim.command(`highlight default link CocGit${item}Sign ${hlGroup}`, true)
    }
    const stagedItems = [
      ['StagedAdded', 'stagedAddedSign', 'CocGitStagedAdd', 'DiffAdd'],
      ['StagedChanged', 'stagedChangedSign', 'CocGitStagedChange', 'DiffChange'],
      ['StagedRemoved', 'stagedRemovedSign', 'CocGitStagedDelete', 'DiffDelete'],
      ['Mixed', 'mixedSign', 'CocGitMixed', 'WarningMsg']
    ]
    for (let [item, section, defaultGroup, fallback] of stagedItems) {
      let text = config.get<string>(`${section}.text`, '')
      let hlGroup = config.get<string>(`${section}.hlGroup`, defaultGroup)
      nvim.command(`sign define CocGit${item} text=${text} texthl=${hlGroup}`, true)
      nvim.command(`highlight default link ${hlGroup} ${fallback}`, true)
    }
    await nvim.resumeNotification()
  }

  private loadConfiguration(e?: ConfigurationChangeEvent): void {
    if (e && !e.affectsConfiguration('git')) return
    let config = workspace.getConfiguration('git')
    let obj: GitConfiguration = {
      remoteName: config.get<string>('remoteName', 'origin'),
      diffRevision: config.get<string>('diffRevision', ''),
      foldContext: config.get<number>('foldContext', 0),
      diffOptions: config.get<string[]>('diffOptions', []),
      issueFormat: config.get<string>('issueFormat', '#%i'),
      virtualTextPrefix: config.get<string>('virtualTextPrefix', '     '),
      blameFormat: config.get<string>('blameFormat', '(%a %t) %s'),
      addGBlameToVirtualText: config.get<boolean>('addGBlameToVirtualText', false),
      addGBlameToBufferVar: config.get<boolean>('addGBlameToBufferVar', false),
      blameUseRealTime: config.get<boolean>('blameUseRealTime', false),
      enableGutters: config.get<boolean>('enableGutters', true),
      realtimeGutters: config.get<boolean>('realtimeGutters', true),
      enableStagedGutters: config.get<boolean>('enableStagedGutters', false),
      showCommitInFloating: config.get<boolean>('showCommitInFloating', false),
      signPriority: config.get<number>('signPriority', 10),
      stagedSignPriority: config.get<number>('stagedSignPriority', 9),
      pushArguments: config.get<string[]>('pushArguments') ?? [],
      splitWindowCommand: config.get<string>('splitWindowCommand', 'above sp'),
      changedSign: {
        text: config.get<string>('changedSign.text', '~'),
        hlGroup: config.get<string>('changedSign.hlGroup', 'DiffChange')
      },
      addedSign: {
        text: config.get<string>('addedSign.text', '+'),
        hlGroup: config.get<string>('addedSign.hlGroup', 'DiffAdd')
      },
      removedSign: {
        text: config.get<string>('removedSign.text', '_'),
        hlGroup: config.get<string>('removedSign.hlGroup', 'DiffDelete')
      },
      topRemovedSign: {
        text: config.get<string>('topRemovedSign.text', '‾'),
        hlGroup: config.get<string>('topRemovedSign.hlGroup', 'DiffDelete')
      },
      changeRemovedSign: {
        text: config.get<string>('changeRemovedSign.text', '≃'),
        hlGroup: config.get<string>('changeRemovedSign.hlGroup', 'DiffChange')
      },
      stagedAddedSign: {
        text: config.get<string>('stagedAddedSign.text', '┃'),
        hlGroup: config.get<string>('stagedAddedSign.hlGroup', 'CocGitStagedAdd')
      },
      stagedChangedSign: {
        text: config.get<string>('stagedChangedSign.text', '┃'),
        hlGroup: config.get<string>('stagedChangedSign.hlGroup', 'CocGitStagedChange')
      },
      stagedRemovedSign: {
        text: config.get<string>('stagedRemovedSign.text', '╻'),
        hlGroup: config.get<string>('stagedRemovedSign.hlGroup', 'CocGitStagedDelete')
      },
      mixedSign: {
        text: config.get<string>('mixedSign.text', '┋'),
        hlGroup: config.get<string>('mixedSign.hlGroup', 'CocGitMixed')
      },
      conflict: {
        enabled: config.get<boolean>('conflict.enabled', true),
        currentHlGroup: config.get<string>('conflict.current.hlGroup', 'DiffChange'),
        incomingHlGroup: config.get<string>('conflict.incoming.hlGroup', 'DiffAdd'),
        commonHlGroup: config.get<string>('conflict.common.hlGroup', 'DiffText')
      },
      floatConfig: config.get<any>('floatConfig', {}),
      gstatus: {
        saveBeforeOpen: config.get<boolean>('gstatus.saveBeforeOpen', false)
      },
      virtualTextSrcId: this.virtualTextSrcId,
      conflictSrcId: this.conflictSrcId
    }
    this.config = Object.assign(this.config || {}, obj)
    if (e) {
      this.defined = false
      for (let buffer of this.buffers.values()) {
        buffer.markConflictCheck()
        buffer.invalidateStagedCache()
        buffer.diffDocument(true).catch(err => this.service.log(`[Error] configuration refresh: ${err.message}`))
      }
      this.defineSigns().catch(err => this.service.log(`[Error] define signs: ${err.message}`))
    }
  }

  private get enableGutters(): boolean {
    return this.config.enableGutters
  }

  public get gstatusSaveBeforeOpen(): boolean {
    return this.config.gstatus.saveBeforeOpen
  }

  public get git(): Git {
    return this.service.git
  }

  public get diffOptions(): ReadonlyArray<string> {
    return this.config.diffOptions
  }

  public async getTerminalGitCommand(args: string[]): Promise<string> {
    const values = [this.git.path, ...args]
    const escaped = await Promise.all(values.map(value => this.nvim.call('shellescape', [value, 1]) as Promise<string>))
    return escaped.join(' ')
  }

  public async toggleGutters(): Promise<void> {
    let enabled = this.enableGutters
    let config = workspace.getConfiguration('git')
    await config.update('enableGutters', !enabled, true)
    for (let buf of this.buffers.values()) {
      await buf.toggleGutters(!enabled)
    }
  }

  public async toggleFold(): Promise<void> {
    let buf = await this.buffer
    if (buf) await buf.toggleFold()
  }

  public async resolveGitRootFromBufferOrCwd(bufnr: number): Promise<string | undefined> {
    let doc = workspace.getDocument(bufnr)
    let root: string
    let { resolver } = this.service
    if (doc) {
      root = await resolver.resolveGitRoot(doc)
    }
    if (!root) {
      root = await resolver.resolveRootFromCwd()
    }
    return root
  }

  public async getCurrentChunk(): Promise<Diff> {
    const { nvim } = this
    let buf = await this.buffer
    if (!buf) return
    let line = await nvim.call('line', '.') as number
    return buf.getChunk(line)
  }

  public async chunkInfo(): Promise<void> {
    let buf = await this.buffer
    if (buf) await buf.chunkInfo()
  }

  public async allChunkInfo(): Promise<Diff[]> {
    let buf = await this.buffer
    if (buf) return buf.allChunkInfo()
    return []
  }

  public async nextChunk(): Promise<void> {
    let buf = await this.buffer
    if (buf) await buf.nextChunk()
  }

  public async prevChunk(): Promise<void> {
    let buf = await this.buffer
    if (buf) await buf.prevChunk()
  }

  public async nextConflict(): Promise<void> {
    let buf = await this.buffer
    if (buf) await buf.nextConflict()
  }

  public async prevConflict(): Promise<void> {
    let buf = await this.buffer
    if (buf) await buf.prevConflict()
  }

  public async keepCurrent(): Promise<void> {
    return this.conflictKeepPart(ConflictPart.Current)
  }

  public async keepIncoming(): Promise<void> {
    return this.conflictKeepPart(ConflictPart.Incoming)
  }

  public async keepBoth(): Promise<void> {
    return this.conflictKeepPart(ConflictPart.Both)
  }

  private async conflictKeepPart(part: ConflictPart) {
    let buf = await this.buffer
    if (buf) await buf.conflictKeepPart(part)
  }

  public async chunkStage(): Promise<void> {
    let buf = await this.buffer
    if (!buf) return
    await buf.chunkStage()
  }

  public async chunkUnstage(): Promise<void> {
    let buf = await this.buffer
    if (!buf) return
    await buf.chunkUnstage()
  }

  public async chunkUndo(): Promise<void> {
    let buf = await this.buffer
    if (buf) await buf.chunkUndo()
  }

  // show commit of current line in split window
  public async showCommit(): Promise<void> {
    let buf = await this.buffer
    if (buf) await buf.showCommit()
  }

  public async showBlameDoc(): Promise<void> {
    let buf = await this.buffer
    let line = await this.nvim.call('line', '.') as number
    if (buf) await buf.showBlameDoc(line)
  }

  public async browser(action = 'open', range?: [number, number], permalink = false): Promise<void> {
    let buf = await this.buffer
    if (buf) await buf.browser(action, range, permalink)
  }

  public async diffCached(): Promise<void> {
    let buf = await this.buffer
    if (buf) await buf.diffCached()
  }

  public refresh(): void {
    for (let buf of this.buffers.values()) {
      buf.invalidateStagedCache()
      buf.refresh()
    }
  }

  // push code
  public async push(args: string[]): Promise<void> {
    let bufnr = await workspace.nvim.call('bufnr', '%') as number
    let root = await this.resolveGitRootFromBufferOrCwd(bufnr)
    let extra = this.config.pushArguments
    if (!root) {
      window.showWarningMessage(`not belongs to git repository.`)
      return
    }
    if (args && args.length) {
      await window.runTerminalCommand(await this.getTerminalGitCommand(['push', ...args, ...extra]), root, true)
      return
    }
    let repo = this.service.getRepoFromRoot(root)
    // resolve remote
    let output = await repo.safeRun(['remote'])
    let remote = output.trim().split(/\r?\n/)[0]
    if (!remote) {
      window.showWarningMessage(`remote not found`)
      return
    }
    // resolve current branch
    output = await repo.safeRun(['rev-parse', '--abbrev-ref', 'HEAD'])
    if (!output) {
      window.showWarningMessage(`current branch not found`)
      return
    }
    await window.runTerminalCommand(await this.getTerminalGitCommand(['push', remote, output, ...extra]), root, true)
  }

  private get buffer(): Promise<GitBuffer> {
    return workspace.nvim.call('bufnr', '%').then(bufnr => {
      let buf = this.buffers.get(bufnr as number)
      if (!buf) window.showWarningMessage(`Can't resolve git repository for current buffer.`)
      return buf
    })
  }

  public getBuffer(bufnr: number): GitBuffer | undefined {
    return this.buffers.get(bufnr)
  }

  public async getDiffAll(category: DiffCategory): Promise<Map<string, Diff[]>> {
    let bufnr = await workspace.nvim.call('bufnr', '%') as number
    let root = await this.resolveGitRootFromBufferOrCwd(bufnr)
    if (!root) {
      window.showWarningMessage(`not belongs to git repository.`)
      return null
    }
    let repo = this.service.getRepoFromRoot(root)
    return repo.getDiffAll(category)
  }

  public dispose(): void {
    disposeAll(this.disposables)
    this.gitStatus.dispose()
    for (let buf of this.buffers.values()) {
      buf.dispose()
    }
    this.buffers.clear()
    this.service.dispose()
  }
}
