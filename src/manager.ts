import { Buffer, Disposable, disposeAll, Document, Documentation, events, FloatFactory, Neovim, OutputChannel, workspace, WorkspaceConfiguration } from 'coc.nvim'
import debounce from 'debounce'
import { format } from 'timeago.js'
import Git from './git'
import Repo from './repo'
import Resolver from './resolver'
import { ChangeType, Diff, SignInfo } from './types'
import { equals, getUrl, spawnCommand } from './util'

interface FoldSettings {
  foldmethod: string
  foldlevel: number
  foldenable: boolean
}

interface BlameInfo {
  sha: string
  index: string
  startLnum: number
  endLnum: number
  author?: string
  time?: string
  summary?: string
}

export default class DocumentManager {
  private repoMap: Map<string, Repo> = new Map()
  private cachedDiffs: Map<number, Diff[]> = new Map()
  private cachedSigns: Map<number, SignInfo[]> = new Map()
  private cachedChangeTick: Map<number, number> = new Map()
  private currentSigns: Map<number, SignInfo[]> = new Map()
  private foldSettingsMap: Map<number, FoldSettings> = new Map()
  private blamesMap: Map<number, BlameInfo[]> = new Map()
  private enabledFolds: Set<number> = new Set()
  private floatFactory: FloatFactory
  private config: WorkspaceConfiguration
  private disposables: Disposable[] = []
  private virtualTextSrcId: number
  private gitStatus = ''
  private gitStatusMap: Map<number, string> = new Map()
  private userNames: Map<string, string> = new Map()
  constructor(
    private nvim: Neovim,
    private resolver: Resolver,
    public git: Git,
    private channel: OutputChannel
  ) {
    this.floatFactory = new FloatFactory(nvim, workspace.env, false, 20, 300)
    this.config = workspace.getConfiguration('git')
    workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('git')) {
        this.config = workspace.getConfiguration('git')
        this.updateAll()
      }
    }, null, this.disposables)

    // tslint:disable-next-line: no-floating-promises
    this.init()
    this.virtualTextSrcId = workspace.createNameSpace('coc-git-virtual')
    let initialized = false
    Promise.all(workspace.documents.map(doc => {
      return resolver.resolveGitRoot(doc)
    })).then(() => {
      initialized = true
      this.updateAll()
    }, emptyFn)
    workspace.onDidOpenTextDocument(async e => {
      let doc = workspace.getDocument(e.uri)
      if (!doc) return
      await resolver.resolveGitRoot(doc)
      await Promise.all([this.refreshStatus(), this.diffDocument(doc, true), this.loadBlames(doc)])
    }, null, this.disposables)
    workspace.onDidChangeTextDocument(async e => {
      let doc = workspace.getDocument(e.textDocument.uri)
      if (!doc) return
      // tslint:disable-next-line: no-floating-promises
      this.diffDocument(doc)
      // tslint:disable-next-line: no-floating-promises
      this.loadBlames(doc)
    }, null, this.disposables)
    workspace.onDidCloseTextDocument(e => {
      this.resolver.delete(e.uri)
    }, null, this.disposables)
    events.on('InsertEnter', bufnr => {
      if (!this.enableVirtualText) return
      this.nvim.call(`nvim_buf_clear_namespace`, [bufnr, this.virtualTextSrcId, 0, -1], true)
    }, null, this.disposables)
    events.on('CursorMoved', debounce((bufnr, cursor) => {
      // tslint:disable-next-line: no-floating-promises
      this.showBlameInfo(bufnr, cursor[0])
    }, 100), null, this.disposables)
    events.on('BufWritePre', async bufnr => {
      if (!this.enableGutters || this.realtime) return
      await this.updateGutters(bufnr)
    }, null, this.disposables)
    events.on('BufUnload', bufnr => {
      let signs = this.cachedSigns.get(bufnr)
      if (signs && signs.length) {
        this.nvim.call('coc#util#unplace_signs', [bufnr, signs.map(o => o.signId)], true)
      }
      this.cachedDiffs.delete(bufnr)
      this.cachedSigns.delete(bufnr)
      this.cachedChangeTick.delete(bufnr)
      this.currentSigns.delete(bufnr)
      this.blamesMap.delete(bufnr)
    }, null, this.disposables)
    events.on('FocusGained', () => {
      if (!initialized) return
      this.updateAll()
    }, null, this.disposables)
    events.on('BufEnter', bufnr => {
      if (initialized && workspace.getDocument(bufnr) != null) {
        this.updateAll(bufnr)
      }
    }, null, this.disposables)
  }

  private async getUsername(repositoryPath: string): Promise<string> {
    let userName = this.userNames.get(repositoryPath)
    if (userName) return userName
    try {
      userName = await this.git.getUsername(repositoryPath)
    } catch (e) {
      this.channel.appendLine(`Error on resolve user name: ${e.message}`)
      userName = ''
    }
    this.userNames.set(repositoryPath, userName)
    return userName
  }

  private getConfig<T>(key: string, defaultValue: T, deprecatedKey?: string): T {
    if (deprecatedKey) {
      let inspectDeprecated = this.config.inspect(deprecatedKey)
      if (inspectDeprecated.globalValue != null || inspectDeprecated.workspaceValue != null) {
        workspace.showMessage(`"${deprecatedKey}" is deprecated in favor of "${key}", please update your config file (:CocConfig)`, 'warning')
      }
    }
    return this.config.get<T>(key, defaultValue)
  }

  private get showBlame(): boolean {
    if (!workspace.nvim.hasFunction('nvim_buf_set_virtual_text')) return false
    let blame = this.getConfig<boolean>('addGBlameToVirtualText', false, 'addGlameToVirtualText')
    let blameVar = this.getConfig<boolean>('addGBlameToBufferVar', false, 'addGlameToBufferVar')
    return blame || blameVar
  }

  private get realtime(): boolean {
    return this.config.get<boolean>('realtimeGutters', false)
  }

  private get enableVirtualText(): boolean {
    if (!workspace.nvim.hasFunction('nvim_buf_set_virtual_text')) return false
    return this.getConfig<boolean>('addGBlameToVirtualText', false, 'addGlameToVirtualText')
  }

  private get signOffset(): number {
    return this.config.get<number>('signOffset', 99)
  }

  private get enableGutters(): boolean {
    return this.config.get<boolean>('enableGutters', true)
  }

  private async init(): Promise<void> {
    const { nvim, config } = this
    if (this.enableGutters) {
      let items = ['Changed', 'Added', 'Removed', 'TopRemoved', 'ChangeRemoved']
      nvim.pauseNotification()
      for (let item of items) {
        let section = item[0].toLowerCase() + item.slice(1) + 'Sign'
        let text = config.get<string>(`${section}.text`, '')
        let hlGroup = config.get<string>(`${section}.hlGroup`, '')
        nvim.command(`sign define CocGit${item} text=${text} texthl=CocGit${item}Sign`, true)
        nvim.command(`hi default link CocGit${item}Sign ${hlGroup}`, true)
      }
      await nvim.resumeNotification(false, true)
    }
  }

  // push code
  public async push(args: string[]): Promise<void> {
    let bufnr = await workspace.nvim.call('bufnr', '%')
    let root = await this.resolveGitRoot(bufnr)
    let extra = this.config.get<string[]>('pushArguments', [])
    if (!root) {
      workspace.showMessage(`not belongs to git repository.`, 'warning')
      return
    }
    if (args && args.length) {
      await workspace.runTerminalCommand(`git push ${[...args, ...extra].join(' ')}`, root, true)
      return
    }
    // resolve remote
    let output = await this.safeRun(['remote'], root)
    let remote = output.trim().split(/\r?\n/)[0]
    if (!remote) {
      workspace.showMessage(`remote not found`, 'warning')
      return
    }
    // resolve current branch
    output = await this.safeRun(['rev-parse', '--abbrev-ref', 'HEAD'], root)
    if (!output) {
      workspace.showMessage(`current branch not found`, 'warning')
      return
    }
    await workspace.runTerminalCommand(`git push ${remote} ${output}${extra.length ? ' ' + extra.join(' ') : ''}`, root, true)
  }

  public async toggleGutters(): Promise<void> {
    let enabled = this.enableGutters
    this.config.update('enableGutters', !enabled, true)
    if (enabled) {
      // disable
      this.nvim.pauseNotification()
      for (let [bufnr, cached] of this.cachedSigns.entries()) {
        this.nvim.call('coc#util#unplace_signs', [bufnr, cached.map(o => o.signId)], true)
        this.cachedSigns.clear()
      }
      await this.nvim.resumeNotification()
    } else {
      this.cachedChangeTick.clear()
      this.cachedDiffs.clear()
      this.cachedSigns.clear()
      // enable
      for (let doc of workspace.documents) {
        this.diffDocument(doc, true).catch(_e => {
          // noop
        })
      }
    }
  }

  public async toggleFold(): Promise<void> {
    let { nvim } = this
    let buf = await nvim.buffer
    let win = await nvim.window
    let bufnr = buf.id
    let doc = workspace.getDocument(bufnr)
    if (!doc) return
    let infos = this.cachedSigns.get(bufnr)
    if (!infos || infos.length == 0) {
      workspace.showMessage('No changes', 'warning')
      return
    }
    let lnums = infos.map(o => o.lnum)
    let ranges = []
    let start = null
    for (let i = 1; i <= doc.lineCount; i++) {
      let fold = lnums.indexOf(i) == -1
      if (fold && start == null) {
        start = i
        continue
      }
      if (start != null && !fold) {
        ranges.push([start, i - 1])
        start = null
      }
      if (start != null && fold && i == doc.lineCount) {
        ranges.push([start, i])
      }
    }
    let enabled = this.enabledFolds.has(bufnr)
    if (enabled) {
      this.enabledFolds.delete(bufnr)
      let cursor = await nvim.eval('getpos(".")') as number[]
      let lnums = ranges.map(o => o[0])
      let settings = this.foldSettingsMap.get(bufnr)
      nvim.pauseNotification()
      for (let lnum of lnums) {
        nvim.command(`${lnum}normal! zd`, true)
      }
      win.setOption('foldmethod', settings.foldmethod, true)
      win.setOption('foldenable', settings.foldenable, true)
      win.setOption('foldlevel', settings.foldlevel, true)
      nvim.call('setpos', ['.', cursor], true)
      await nvim.resumeNotification()
    } else {
      this.enabledFolds.add(bufnr)
      let [foldmethod, foldenable, foldlevel] = await nvim.eval('[&foldmethod,&foldenable,&foldlevel]') as [string, number, number]
      let settings: FoldSettings = {
        foldmethod,
        foldenable: foldenable !== 0,
        foldlevel
      }
      this.foldSettingsMap.set(bufnr, settings)
      nvim.pauseNotification()
      win.setOption('foldmethod', 'manual', true)
      win.setOption('foldenable', true, true)
      win.setOption('foldlevel', 0, true)
      await nvim.resumeNotification()
      nvim.pauseNotification()
      for (let r of ranges) {
        nvim.command(`${r[0]},${r[1]}fold`, true)
      }
      await nvim.resumeNotification()
    }
  }

  public async getRepo(bufnr?: number): Promise<Repo> {
    let { nvim } = this
    const buf = bufnr ? nvim.createBuffer(bufnr) : await nvim.buffer
    const doc = workspace.getDocument(buf.id)
    if (!doc || doc.buftype != '') return null
    let root = await this.resolver.resolveGitRoot(doc)
    if (!root) return null
    let repo = this.repoMap.get(root)
    if (repo) return repo
    repo = new Repo(this.git, this.channel, root)
    this.repoMap.set(root, repo)
    return repo
  }

  public async refreshStatus(bufnr?: number): Promise<void> {
    if (!this.config.get<boolean>('enableGlobalStatus', true)) return
    let repo = await this.getRepo(bufnr)
    if (bufnr && workspace.bufnr != bufnr) return
    if (!repo) {
      await this.setGitStatus('')
    } else {
      let character = this.config.get<string>('branchCharacter', '')
      let status = await repo.getStatus(character, {
        changedDecorator: this.config.get<string>('changedDecorator'),
        conflictedDecorator: this.config.get<string>('conflictedDecorator'),
        stagedDecorator: this.config.get<string>('stagedDecorator'),
        untrackedDecorator: this.config.get<string>('untrackedDecorator'),
      })
      if (bufnr && workspace.bufnr != bufnr) return
      await this.setGitStatus(status)
    }
  }

  public async resolveGitRoot(bufnr: number): Promise<string> {
    let doc = workspace.getDocument(bufnr)
    return await this.resolver.resolveGitRoot(doc)
  }

  public async resolveGitRootFromBufferOrCwd(bufnr: number): Promise<string | undefined> {
    let doc = workspace.getDocument(bufnr)
    let root: string
    if (doc) {
      root = await this.resolver.resolveGitRoot(doc)
    }
    if (!root) {
      root = await this.resolver.resolveRootFromCwd()
    }
    return root
  }

  public getRelativePath(uri: string): string {
    return this.resolver.getRelativePath(uri)
  }

  private async setGitStatus(status: string): Promise<void> {
    if (this.gitStatus == status) return
    this.gitStatus = status
    let { nvim } = this
    nvim.pauseNotification()
    nvim.setVar('coc_git_status', status, true)
    nvim.call('coc#util#do_autocmd', ['CocGitStatusChange'], true)
    await nvim.resumeNotification(false, true)
  }

  private async setBufferStatus(buffer: Buffer, status: string): Promise<void> {
    let exists = this.gitStatusMap.get(buffer.id) || ''
    if (exists == status) return
    this.gitStatusMap.set(buffer.id, status)
    let { nvim } = this
    nvim.pauseNotification()
    buffer.setVar('coc_git_status', status, true)
    nvim.call('coc#util#do_autocmd', ['CocGitStatusChange'], true)
    await nvim.resumeNotification(false, true)
  }

  public async getCurrentChunk(): Promise<Diff> {
    const { nvim } = this
    let bufnr = await nvim.call('bufnr', '%')
    let line = await nvim.call('line', '.')
    let diffs = this.cachedDiffs.get(bufnr)
    if (!diffs || diffs.length == 0) return
    return diffs.find(ch => {
      let { start, added, removed, changeType } = ch
      if (line == 1 && start == 0 && ch.end == 0) {
        return true
      }
      let end = changeType === ChangeType.Change && added.count > removed.count ?
        ch.end + added.count - removed.count : ch.end
      if (start <= line && end >= line) {
        return true
      }
      return false
    })
  }

  public async showDoc(content: string, filetype = 'diff'): Promise<void> {
    if (workspace.floatSupported) {
      let docs: Documentation[] = [{ content, filetype }]
      await this.floatFactory.create(docs, false)
    } else {
      const lines = content.split('\n')
      this.nvim.call('coc#util#preview_info', [lines, 'diff'], true)
    }
  }

  public async chunkInfo(): Promise<void> {
    let diff = await this.getCurrentChunk()
    if (diff) {
      let content = diff.head + '\n' + diff.lines.join('\n')
      await this.showDoc(content, 'diff')
    }
  }

  public async nextChunk(): Promise<void> {
    const { nvim } = this
    let bufnr = await nvim.call('bufnr', '%')
    let diffs = this.cachedDiffs.get(bufnr)
    if (!diffs || diffs.length == 0) return
    let line = await nvim.call('line', '.')
    for (let diff of diffs) {
      if (diff.start > line) {
        await workspace.moveTo({ line: Math.max(diff.start - 1, 0), character: 0 })
        return
      }
    }
    if (await nvim.getOption('wrapscan')) {
      await workspace.moveTo({ line: Math.max(diffs[0].start - 1, 0), character: 0 })
    }
  }

  public async prevChunk(): Promise<void> {
    const { nvim } = this
    let bufnr = await nvim.call('bufnr', '%')
    let line = await nvim.call('line', '.')
    let diffs = this.cachedDiffs.get(bufnr)
    if (!diffs || diffs.length == 0) return
    for (let diff of diffs.slice().reverse()) {
      if (diff.end < line) {
        await workspace.moveTo({ line: Math.max(diff.start - 1, 0), character: 0 })
        return
      }
    }
    if (await nvim.getOption('wrapscan')) {
      await workspace.moveTo({ line: Math.max(diffs[diffs.length - 1].start - 1, 0), character: 0 })
    }
  }

  public async diffDocument(doc: Document, init = false): Promise<void> {
    let { nvim } = workspace
    let repo = await this.getRepo(doc.bufnr)
    if (!repo) return
    let relpath = this.resolver.getRelativePath(doc.uri)
    if (!relpath) return
    let revision = this.config.get<string>('diffRevision', '')
    const diffs = await repo.getDiff(relpath, doc.getDocumentContent(), revision)
    const { bufnr } = doc
    let changedtick = this.cachedChangeTick.get(bufnr)
    if (changedtick == doc.changedtick
      && equals(diffs, this.cachedDiffs.get(bufnr))) {
      return
    }
    this.cachedDiffs.set(bufnr, diffs || null)
    this.cachedChangeTick.set(bufnr, doc.changedtick)
    const cached = this.cachedSigns.get(bufnr)
    if (!diffs || diffs.length == 0) {
      let buf = doc.buffer
      await this.setBufferStatus(buf, '')
      if (cached && cached.length && this.enableGutters) {
        nvim.call('coc#util#unplace_signs', [bufnr, cached.map(o => o.signId)], true)
        this.cachedSigns.set(bufnr, [])
      }
      this.currentSigns.set(bufnr, [])
    } else {
      let added = 0
      let changed = 0
      let removed = 0
      let signs: SignInfo[] = []
      let signId = this.signOffset
      for (let diff of diffs) {
        if (diff.changeType == ChangeType.Add) {
          added += diff.added.count
        } else if (diff.changeType == ChangeType.Delete) {
          removed += diff.removed.count
        } else if (diff.changeType == ChangeType.Change) {
          let [add, remove] = [diff.added.count, diff.removed.count]
          let min = Math.min(add, remove)
          changed += min
          added += add - min
          removed += remove - min
        }
        let { start, end } = diff
        for (let i = start; i <= end; i++) {
          let topdelete = diff.changeType == ChangeType.Delete && i == 0
          let changedelete = diff.changeType == ChangeType.Change && diff.removed.count > diff.added.count && i == end
          signs.push({
            signId,
            changeType: topdelete ? 'topdelete' : changedelete ? 'changedelete' : diff.changeType,
            lnum: topdelete ? 1 : i
          })
          signId = signId + 1
        }
        if (diff.changeType == ChangeType.Change) {
          let [add, remove] = [diff.added.count, diff.removed.count]
          if (add > remove) {
            for (let i = 0; i < add - remove; i++) {
              signs.push({
                signId,
                changeType: ChangeType.Add,
                lnum: diff.end + 1 + i
              })
              signId = signId + 1
            }
          }
        }
      }
      let items: string[] = []
      if (added) items.push(`+${added}`)
      if (changed) items.push(`~${changed}`)
      if (removed) items.push(`-${removed}`)
      let status = '  ' + `${items.join(' ')} `
      await this.setBufferStatus(doc.buffer, status)
      this.currentSigns.set(bufnr, signs)
      if (!this.realtime && !init) return
      await this.updateGutters(bufnr)
    }
  }

  // load blame texts of document
  public async loadBlames(doc: Document): Promise<void> {
    if (!this.showBlame) return
    if (!doc || doc.isIgnored) return
    let result: BlameInfo[] = []
    let root = await this.resolver.resolveGitRoot(doc)
    if (!root) return
    let relpath = this.resolver.getRelativePath(doc.uri)
    if (!relpath) return
    let indexed = await this.git.isIndexed(relpath, root)
    if (indexed) result = await this.getBlameInfo(relpath, root, doc.content)
    this.blamesMap.set(doc.bufnr, result)
  }

  public async showBlameInfo(bufnr: number, lnum: number): Promise<void> {
    let { nvim, virtualTextSrcId } = this
    if (!this.showBlame) return
    let infos = this.blamesMap.get(bufnr)
    if (!infos) return
    let blameText: string
    if (infos.length == 0) {
      blameText = 'File not indexed'
    } else {
      let info = infos.find(o => lnum >= o.startLnum && lnum <= o.endLnum)
      if (info && info.author && info.author != 'Not Committed Yet') {
        blameText = `(${info.author} ${info.time}) ${info.summary}`
      } else {
        blameText = 'Not committed yet'
      }
    }
    let buffer = nvim.createBuffer(bufnr)
    if (this.getConfig<boolean>('addGBlameToBufferVar', false, 'addGlameToBufferVar')) {
      nvim.pauseNotification()
      buffer.setVar('coc_git_blame', blameText, true)
      nvim.call('coc#util#do_autocmd', ['CocGitStatusChange'], true)
      await nvim.resumeNotification(false, true)
    }
    if (this.enableVirtualText) {
      const prefix = this.config.get<string>('virtualTextPrefix', '     ')
      await buffer.request('nvim_buf_clear_namespace', [virtualTextSrcId, 0, -1])
      await buffer.setVirtualText(virtualTextSrcId, lnum - 1, [[prefix + blameText, 'CocCodeLens']])
    }
  }

  private async updateGutters(bufnr: number): Promise<void> {
    if (!this.enableGutters) return
    let { nvim } = this
    nvim.pauseNotification()
    let signs = this.currentSigns.get(bufnr) || []
    const cached = this.cachedSigns.get(bufnr)
    if (cached) nvim.call('coc#util#unplace_signs', [bufnr, cached.map(o => o.signId)], true)
    this.cachedSigns.set(bufnr, signs)
    for (let sign of signs) {
      let name = this.getSignName(sign.changeType)
      let cmd = `sign place ${sign.signId} line=${sign.lnum} name=${name} buffer=${bufnr}`
      nvim.command(cmd, true)
    }
    await nvim.resumeNotification()
  }

  private getSignName(changeType: ChangeType | string): string {
    switch (changeType) {
      case ChangeType.Delete:
        return 'CocGitRemoved'
      case ChangeType.Add:
        return 'CocGitAdded'
      case ChangeType.Change:
        return 'CocGitChanged'
      case 'topdelete':
        return 'CocGitTopRemoved'
      case 'changedelete':
        return 'CocGitChangeRemoved'
    }
    return ''
  }

  public async chunkStage(): Promise<void> {
    let bufnr = await this.nvim.call('bufnr', '%')
    let doc = workspace.getDocument(bufnr)
    let root = await this.resolver.resolveGitRoot(doc)
    if (!root) return
    let relpath = this.resolver.getRelativePath(doc.uri)
    if (!relpath) return
    let diff = await this.getCurrentChunk()
    if (!diff) return
    let head: string
    if (diff.changeType === ChangeType.Add) {
      head = `@@ -${diff.removed.start + 1},0 +${diff.removed.start + 1},${diff.added.count} @@`
    } else if (diff.changeType === ChangeType.Delete) {
      head = `@@ -${diff.removed.start},${diff.removed.count} +${diff.removed.start},0 @@`
    } else if (diff.changeType === ChangeType.Change) {
      head = `@@ -${diff.removed.start},${diff.removed.count} +${diff.removed.start},${diff.added.count} @@`
    }
    const lines = [
      `diff --git a/${relpath} b/${relpath}`,
      `index 000000..000000 100644`,
      `--- a/${relpath}`,
      `+++ b/${relpath}`,
      head
    ]
    lines.push(...diff.lines)
    lines.push('')
    try {
      await this.git.exec(root, ['apply', '--cached', '--unidiff-zero', '-'], { input: lines.join('\n') })
      await this.diffDocument(doc, true)
    } catch (e) {
      // tslint:disable-next-line: no-console
      console.error(e.message)
    }
  }

  public async chunkUndo(): Promise<void> {
    let diff = await this.getCurrentChunk()
    if (!diff) return
    let { start, lines, changeType } = diff
    let added = lines.filter(s => s.startsWith('-')).map(s => s.slice(1))
    let removeCount = lines.filter(s => s.startsWith('+')).length
    let { nvim } = this
    let buf = await nvim.buffer
    if (changeType == ChangeType.Delete) {
      await buf.setLines(added, { start, end: start, strictIndexing: false })
    } else {
      await buf.setLines(added, {
        start: start - 1,
        end: start - 1 + removeCount,
        strictIndexing: false
      })
    }
  }

  // show commit of current line in split window
  public async showCommit(): Promise<void> {
    let { nvim } = this
    let bufnr = await nvim.call('bufnr', '%')
    let doc = workspace.getDocument(bufnr)
    let root = await this.resolver.resolveGitRoot(doc)
    let relpath = this.resolver.getRelativePath(doc.uri)
    if (!root || !relpath) return
    let res = await this.safeRun(['ls-files', '--', relpath], root)
    if (!res.length) {
      workspace.showMessage(`"${relpath}" not indexed.`, 'warning')
      return
    }
    let line = await nvim.eval('line(".")') as number
    let args = ['--no-pager', 'blame', '-l', '--root', '-t', `-L${line},${line}`, relpath]
    let output = await spawnCommand('git', args, root)
    output = output.trim()
    if (!output.length) return
    let commit = output.match(/^\S+/)[0]
    if (/^0+$/.test(commit)) {
      workspace.showMessage('not committed yet!', 'warning')
      return
    }
    let useFloating = this.config.get<boolean>('showCommitInFloating', false)
    if (useFloating) {
      let content = await this.safeRun(['--no-pager', 'show', commit], root)
      if (content == null) return
      let lines = content.trim()
      await this.showDoc(lines)
      return
    }
    let splitWindowCommand = this.config.get<string>('splitWindowCommand', 'above sp')
    await nvim.command(`keepalt above ${splitWindowCommand}`)

    let hasFugitive = await nvim.getVar('loaded_fugitive')
    if (hasFugitive) {
      await nvim.command(`Gedit ${commit}`)
    } else {
      let content = await this.safeRun(['--no-pager', 'show', commit], root)
      if (content == null) return
      let lines = content.trim().split('\n')
      nvim.pauseNotification()
      nvim.command(`edit +setl\\ buftype=nofile [commit ${commit}]`, true)
      nvim.command('setl foldmethod=syntax nobuflisted bufhidden=wipe', true)
      nvim.command('setf git', true)
      nvim.call('append', [0, lines], true)
      nvim.command('normal! Gdd', true)
      nvim.command(`exe 1`, true)
      await nvim.resumeNotification(false, true)
    }
  }

  public async browser(action = 'open', range?: [number, number]): Promise<void> {
    let { nvim } = this
    let bufnr = await nvim.call('bufnr', '%')
    let doc = workspace.getDocument(bufnr)
    let root = await this.resolveGitRoot(bufnr)
    if (!root) {
      workspace.showMessage(`not a git repository.`, 'warning')
      return
    }
    // get remote list
    let output = await this.safeRun(['remote'], root)
    if (!output.trim()) {
      workspace.showMessage(`No remote found`, 'warning')
      return
    }
    let head = await this.safeRun(['symbolic-ref', '--short', '-q', 'HEAD'], root)
    head = head.trim()
    if (!head.length) {
      workspace.showMessage(`Failed on git symbolic-ref`, 'warning')
      return
    }
    let lines: any = range && range.length == 2 ? [
      range[0],
      range[1]
    ] : [await nvim.eval('line(".")') as number]
    if (doc && doc.filetype == 'markdown') {
      let line = await nvim.call('getline', ['.']) as string
      if (line.startsWith('#')) {
        let words = line.replace(/^#+\s*/, '').split(/\s+/)
        lines = words.map(s => s.toLowerCase()).join('-')
      }
    }
    let relpath = this.resolver.getRelativePath(doc.uri)
    if (!relpath) return
    let names = output.trim().split(/\r?\n/)
    let urls: string[] = []
    for (let name of names) {
      let uri = await this.safeRun(['remote', 'get-url', name], root)
      uri = uri.replace(/\s+$/, '')
      if (!uri.length) continue
      let url = getUrl(uri, head, relpath.replace(/\\\\/g, '/'), lines)
      if (url) urls.push(url)
    }
    if (urls.length == 1) {
      if (action == 'open') {
        nvim.call('coc#util#open_url', [urls[0]], true)
      } else {
        nvim.command(`let @+ = '${urls[0]}'`, true)
        workspace.showMessage('Copied url to clipboard')
      }
    } else if (urls.length > 1) {
      let idx = await workspace.showQuickpick(urls, 'Select url:')
      if (idx >= 0) {
        if (action == 'open') {
          nvim.call('coc#util#open_url', [urls[idx]], true)
        } else {
          nvim.command(`let @+ = '${urls[idx]}'`, true)
          workspace.showMessage('Copied url to clipboard')
        }
      }
    }
  }

  public async diffCached(): Promise<void> {
    let { nvim } = this
    let bufnr = await nvim.call('bufnr', '%')
    let root = await this.resolveGitRoot(bufnr)
    if (!root) {
      workspace.showMessage(`not a git repository.`, 'warning')
      return
    }
    let res = await this.safeRun(['diff', '--cached'], root)
    if (!res.trim()) {
      workspace.showMessage('Empty diff')
      return
    }
    nvim.pauseNotification()
    nvim.command(`keepalt above new +setl\\ previewwindow`, true)
    nvim.call('append', [0, res.split(/\r?\n/)], true)
    nvim.command('normal! Gdd', true)
    nvim.command(`exe 1`, true)
    nvim.command('setfiletype git', true)
    nvim.command('setl buftype=nofile nomodifiable bufhidden=wipe nobuflisted', true)
    await nvim.resumeNotification()
  }

  private async getBlameInfo(relpath: string, root: string, input: string): Promise<BlameInfo[]> {
    let res: BlameInfo[] = []
    try {
      let currentAuthor = await this.getUsername(root)
      let r = await this.git.exec(root, ['--no-pager', 'blame', '-b', '-p', '--root', '--date', 'relative', '--contents', '-', relpath], {
        log: false,
        input
      })
      if (!r.stdout) return res
      let info: BlameInfo
      for (let line of r.stdout.trim().split(/\r?\n/)) {
        line = line.trim()
        let ms = line.match(/^([A-Za-z0-9]+)\s(\d+)\s(\d+)\s(\d+)/)
        if (ms) {
          let startLnum = parseInt(ms[3], 10)
          info = { startLnum, sha: ms[1], endLnum: startLnum + parseInt(ms[4], 10) - 1, index: ms[2] }
          if (!/^0+$/.test(ms[1])) {
            let find = res.find(o => o.sha == ms[1])
            if (find) {
              info.author = find.author
              info.time = find.time
              info.summary = find.summary
            }
          }
          res.push(info)
        } else if (info) {
          if (line.startsWith('author ')) {
            let author = line.replace(/^author/, '').trim()
            info.author = author == currentAuthor ? 'You' : author
          } else if (line.startsWith('author-time ')) {
            let text = line.replace(/^author-time/, '').trim()
            info.time = format(parseInt(text, 10) * 1000, process.env.LANG)
          } else if (line.startsWith('summary ')) {
            let text = line.replace(/^summary/, '').trim()
            info.summary = text
          }
        }
      }
      return res
    } catch (e) {
      this.channel.appendLine(e.stack)
    }
    return res
  }

  public updateAll(bufnr?: number): void {
    this.refreshStatus(bufnr).catch(emptyFn)
    for (let doc of workspace.documents) {
      this.diffDocument(doc, true).catch(emptyFn)
      if (!this.config.get<boolean>('addGBlameToVirtualText', false)) {
        doc.buffer.clearNamespace(this.virtualTextSrcId)
      }
      this.loadBlames(doc).then(async () => {
        let [bufnr, lnum] = await this.nvim.eval('[bufnr("%"),line(".")]') as [number, number]
        await this.showBlameInfo(bufnr, lnum)
      }, emptyFn)
    }
  }

  public async safeRun(args: string[], root: string): Promise<string> {
    try {
      let res = await this.git.exec(root, args)
      return res ? res.stdout.replace(/\s*$/, '') : ''
    } catch (e) {
      return ''
    }
  }

  public dispose(): void {
    this.resolver.clear()
    disposeAll(this.disposables)
  }
}

function emptyFn(): void {
  // noop
}
