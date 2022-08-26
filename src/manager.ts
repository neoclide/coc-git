import { ConfigurationChangeEvent, Disposable, disposeAll, Document, events, Neovim, window, workspace } from 'coc.nvim'
import debounce from 'debounce'
import GitBuffer from './model/buffer'
import Git from './model/git'
import Service from './model/service'
import GitStatus from './model/status'
import { ConflictPart, Diff, GitConfiguration } from './types'

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
    const createBuffer = (doc: Document) => {
      let { uri } = doc
      service.createBuffer(doc, this.config).then(buf => {
        if (!buf || workspace.getDocument(uri) == null) return
        this.defineSigns().catch(e => {
          console.error(e.message)
        })
        this.buffers.set(doc.bufnr, buf)
      })
    }
    for (let doc of workspace.documents) {
      createBuffer(doc)
    }
    workspace.onDidOpenTextDocument(async e => {
      createBuffer(workspace.getDocument(e.bufnr))
    }, null, this.disposables)
    workspace.onDidChangeTextDocument(async e => {
      let buf = this.buffers.get(e.bufnr)
      if (buf) buf.refresh()
    }, null, this.disposables)
    workspace.onDidCloseTextDocument(e => {
      let buf = this.buffers.get(e.bufnr)
      if (buf) buf.dispose()
      this.buffers.delete(e.bufnr)
      this.service.resolver.delete(e.uri)
    }, null, this.disposables)
    events.on('CursorMoved', debounce(async (bufnr, cursor) => {
      let buf = this.buffers.get(bufnr)
      if (buf) await buf.showBlameInfo(cursor[0])
    }, 100), null, this.disposables)
    events.on('BufWritePre', bufnr => {
      if (!this.enableGutters || this.config.realtimeGutters) return
      let buf = this.buffers.get(bufnr)
      if (buf) buf.updateGutters()
    }, null, this.disposables)
    events.on('FocusGained', async () => {
      let bufnr = await nvim.call('bufnr', ['%'])
      let buf = this.buffers.get(bufnr)
      if (buf) buf.refresh()
    }, null, this.disposables)
    events.on('BufEnter', bufnr => {
      let buf = this.buffers.get(bufnr)
      if (buf) buf.refresh()
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
    await nvim.resumeNotification()
  }

  private loadConfiguration(e?: ConfigurationChangeEvent): void {
    if (e && !e.affectsConfiguration('git')) return
    let config = workspace.getConfiguration('git')
    let obj: GitConfiguration = {
      remoteName: config.get<string>('remoteName', 'origin'),
      diffRevision: config.get<string>('diffRevision', ''),
      issueFormat: config.get<string>('issueFormat', '#%i'),
      virtualTextPrefix: config.get<string>('virtualTextPrefix', '     '),
      addGBlameToVirtualText: workspace.nvim.hasFunction('nvim_buf_set_virtual_text') && config.get<boolean>('addGBlameToVirtualText', false),
      addGBlameToBufferVar: config.get<boolean>('addGBlameToBufferVar', false),
      blameUseRealTime: config.get<boolean>('blameUseRealTime', false),
      enableGutters: config.get<boolean>('enableGutters', true),
      realtimeGutters: config.get<boolean>('realtimeGutters', true),
      showCommitInFloating: config.get<boolean>('showCommitInFloating', false),
      signPriority: config.get<number>('signPriority', 10),
      pushArguments: config.get<string[]>('pushArguments', []),
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
      conflict: {
        enabled: config.get<boolean>('conflict.enabled', true),
        currentHlGroup: config.get<string>('conflict.current.hlGroup', 'DiffChange'),
        incomingHlGroup: config.get<string>('conflict.incoming.hlGroup', 'DiffAdd')
      },
      floatConfig: {
        border: config.get<boolean>('floatConfig.border', true),
        rounded: config.get<boolean>('floatConfig.rounded', true),
        highlight: config.get<string>('floatConfig.highlight', "CocFloating"),
        title: config.get<string>('floatConfig.title', ""),
        borderhighlight: config.get<string>('floatConfig.borderhighlight', "CocFloating"),
        close: config.get<boolean>('floatConfig.close', false),
        maxHeight: config.get<number>('floatConfig.maxHeight', 100),
        maxWidth: config.get<number>('floatConfig.maxWidth', 100),
        winblend: config.get<number>('floatConfig.winblend', 0),
        focusable: config.get<boolean>('floatConfig.focusable', false),
        shadow: config.get<boolean>('floatConfig.shadow', false),
      },
      gstatus: {
        saveBeforeOpen: config.get<boolean>('gstatus.saveBeforeOpen', false)
      },
      virtualTextSrcId: this.virtualTextSrcId,
      conflictSrcId: this.conflictSrcId
    }
    this.config = Object.assign(this.config || {}, obj)
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

  public async toggleGutters(): Promise<void> {
    let enabled = this.enableGutters
    let config = workspace.getConfiguration('git')
    config.update('enableGutters', !enabled, true)
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
    let line = await nvim.call('line', '.')
    return buf.getChunk(line)
  }

  public async chunkInfo(): Promise<void> {
    let buf = await this.buffer
    if (buf) await buf.chunkInfo()
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
    let line = await this.nvim.call('line', '.')
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
      buf.refresh()
    }
  }

  // push code
  public async push(args: string[]): Promise<void> {
    let bufnr = await workspace.nvim.call('bufnr', '%')
    let root = await this.resolveGitRootFromBufferOrCwd(bufnr)
    let extra = this.config.pushArguments
    if (!root) {
      window.showMessage(`not belongs to git repository.`, 'warning')
      return
    }
    if (args && args.length) {
      await window.runTerminalCommand(`git push ${[...args, ...extra].join(' ')}`, root, true)
      return
    }
    let repo = this.service.getRepoFromRoot(root)
    // resolve remote
    let output = await repo.safeRun(['remote'])
    let remote = output.trim().split(/\r?\n/)[0]
    if (!remote) {
      window.showMessage(`remote not found`, 'warning')
      return
    }
    // resolve current branch
    output = await repo.safeRun(['rev-parse', '--abbrev-ref', 'HEAD'])
    if (!output) {
      window.showMessage(`current branch not found`, 'warning')
      return
    }
    await window.runTerminalCommand(`git push ${remote} ${output}${extra.length ? ' ' + extra.join(' ') : ''}`, root, true)
  }

  private get buffer(): Promise<GitBuffer> {
    return workspace.nvim.call('bufnr', '%').then(bufnr => {
      let buf = this.buffers.get(bufnr)
      if (!buf) window.showMessage(`Cant't resolve git repository for current buffer.`, 'warning')
      return buf
    })
  }

  public getBuffer(bufnr: number): GitBuffer | undefined {
    return this.buffers.get(bufnr)
  }

  public dispose(): void {
    this.gitStatus.dispose()
    this.service.dispose()
    for (let buf of this.buffers.values()) {
      buf.dispose()
    }
    this.buffers.clear()
    disposeAll(this.disposables)
  }
}
