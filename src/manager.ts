import { Buffer, Disposable, disposeAll, Document, Documentation, events, FloatFactory, Neovim, OutputChannel, Uri, workspace, WorkspaceConfiguration } from 'coc.nvim'
import debounce from 'debounce'
import fs from 'fs'
import path from 'path'
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
  private enabledFolds: Set<number> = new Set()
  private floatFactory: FloatFactory
  private config: WorkspaceConfiguration
  private disposables: Disposable[] = []
  private virtualTextSrcId: number
  private gitStatus = ''
  private gitStatusMap: Map<number, string> = new Map()
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
      }
    }, null, this.disposables)
    this.init().catch(e => {
      // tslint:disable-next-line: no-console
      console.error(e)
    })
    if (this.showBlame && workspace.isNvim) {
      nvim.createNamespace('coc-git').then(srcId => {
        this.virtualTextSrcId = srcId
      }, _e => {
        // noop
      })
      events.on('BufEnter', bufnr => {
        if (!this.virtualText) return
        let doc = workspace.getDocument(bufnr)
        if (doc) doc.buffer.clearNamespace(this.virtualTextSrcId, 0, -1)
      }, null, this.disposables)
      events.on('CursorMoved', debounce(async (bufnr, cursor) => {
        await this.showBlameInfo(bufnr, cursor[0])
      }, 100), null, this.disposables)
      events.on('InsertEnter', async bufnr => {
        let { virtualTextSrcId } = this
        if (virtualTextSrcId) {
          let buffer = nvim.createBuffer(bufnr)
          await buffer.request('nvim_buf_clear_namespace', [virtualTextSrcId, 0, -1])
        }
      }, null, this.disposables)
    }
    events.on('BufWritePre', async bufnr => {
      if (!this.enableGutters || this.realtime) return
      await this.updateGutters(bufnr)
    }, null, this.disposables)
  }

  private get showBlame(): boolean {
    let blame = this.config.get<boolean>('addGlameToVirtualText', false)
    let blameVar = this.config.get<boolean>('addGlameToBufferVar', false)
    return blame || blameVar
  }

  private get realtime(): boolean {
    return this.config.get<boolean>('realtimeGutters', false)
  }

  private async showBlameInfo(bufnr: number, lnum: number): Promise<void> {
    let { virtualTextSrcId, nvim } = this
    if (!virtualTextSrcId || !this.showBlame) return
    let doc = workspace.getDocument(bufnr)
    if (!doc || doc.buftype != '' || doc.schema != 'file' || doc.isIgnored) return
    let root = await this.resolveGitRoot(bufnr)
    if (!root) return
    let filepath = Uri.parse(doc.uri).fsPath
    if (!fs.existsSync(filepath)) return
    let blameInfo = await this.getBlameInfo(path.relative(root, filepath), lnum, root)
    let buffer = nvim.createBuffer(bufnr)
    let modified = await buffer.getOption('modified')
    if (modified) blameInfo = {}
    let blameText = ''
    if (blameInfo.author) {
      if (blameInfo.author.includes('Not Committed Yet')) {
        blameText = `Not Committed Yet`
      } else {
        blameText = `(${blameInfo.author} ${blameInfo.time}) ${blameInfo.summary}`
      }
    }
    if (this.config.get<boolean>('addGlameToBufferVar', false)) {
      nvim.pauseNotification()
      doc.buffer.setVar('coc_git_blame', blameText, true)
      nvim.command('redraws', true)
      nvim.call('coc#util#do_autocmd', ['CocGitStatusChange'], true)
      await nvim.resumeNotification(false, true)
    }
    if (this.virtualText) {
      try {
        await buffer.request('nvim_buf_clear_namespace', [virtualTextSrcId, 0, -1])
        if (blameText) {
          const prefix = this.config.get<string>('virtualTextPrefix', '     ')
          await buffer.setVirtualText(virtualTextSrcId, lnum - 1, [[prefix + blameText, 'CocCodeLens']])
        }
      } catch (err) {
        // tslint:disable-next-line: no-console
        console.error(err)
      }
    }
  }

  private get virtualText(): boolean {
    return this.config.get<boolean>('addGlameToVirtualText', false) && workspace.isNvim
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
      await nvim.resumeNotification()
    }
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
    let enabled = this.enabledFolds.has(bufnr)
    if (enabled) {
      this.enabledFolds.delete(bufnr)
      let cursor = await nvim.eval('getpos(".")')
      for (let i = 1; i <= doc.lineCount; i++) {
        let foldend = Number(await nvim.eval(`foldclosedend("${i}}")`))
        if (foldend != -1) {
          await nvim.command(`${foldend}normal! zd`)
          i = foldend + 1
        }
      }
      await nvim.eval(`setpos(".", ${cursor})`)
      let settings = this.foldSettingsMap.get(bufnr)
      nvim.pauseNotification()
      win.setOption('foldmethod', settings.foldmethod, true)
      win.setOption('foldenable', settings.foldenable, true)
      win.setOption('foldlevel', settings.foldlevel, true)
      await nvim.resumeNotification()
    } else {
      this.enabledFolds.add(bufnr)
      let settings: FoldSettings = {
        foldmethod: await win.getOption('foldmethod') as string,
        foldenable: await win.getOption('foldenable') as boolean,
        foldlevel: await win.getOption('foldlevel') as number
      }
      this.foldSettingsMap.set(bufnr, settings)
      nvim.pauseNotification()
      win.setOption('foldmethod', 'manual', true)
      win.setOption('foldenable', true, true)
      win.setOption('foldlevel', 0, true)
      await nvim.resumeNotification()
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
      nvim.pauseNotification()
      for (let r of ranges) {
        nvim.command(`${r[0]},${r[1]}fold`, true)
      }
      await nvim.resumeNotification()
    }
  }

  private async getRepo(bufnr?: number): Promise<Repo> {
    let { nvim } = this
    const buf = bufnr ? nvim.createBuffer(bufnr) : await nvim.buffer
    const doc = workspace.getDocument(buf.id)
    if (!doc || doc.buftype != '') return null
    let root: string
    if (doc && doc.schema == 'file') {
      root = this.resolver.getGitRoot(Uri.parse(doc.uri).fsPath)
    } else {
      root = await this.resolver.resolveGitRoot()
    }
    this.channel.appendLine(`resolved root: ${root}`)
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
    return this.resolver.resolveGitRoot(doc)
  }

  private async setGitStatus(status: string): Promise<void> {
    if (this.gitStatus == status) return
    this.gitStatus = status
    let { nvim } = this
    nvim.pauseNotification()
    nvim.setVar('coc_git_status', status, true)
    nvim.command('redraws', true)
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
    nvim.command('redraws', true)
    nvim.call('coc#util#do_autocmd', ['CocGitStatusChange'], true)
    await nvim.resumeNotification(false, true)
  }

  private async getCurrentChunk(): Promise<Diff> {
    const { nvim } = this
    let bufnr = await nvim.call('bufnr', '%')
    let line = await nvim.call('line', '.')
    let diffs = this.cachedDiffs.get(bufnr)
    if (!diffs || diffs.length == 0) return
    return diffs.find(ch => {
      let { start, delta } = ch
      if (line == 1 && start == 0 && ch.end == 0) {
        return true
      }
      let end = delta && delta[0] > delta[1] ? ch.end + delta[0] - delta[1] : ch.end
      if (start <= line && end >= line) {
        return true
      }
      return false
    })
  }

  public async showDoc(content: string, filetype = 'diff'): Promise<void> {
    if (workspace.env.floating) {
      let docs: Documentation[] = [{ content, filetype }]
      await this.floatFactory.create(docs, false)
    } else {
      const lines = ['``` ' + filetype]
      lines.push(...content.split('\n'))
      lines.push('```')
      this.nvim.call('coc#util#preview_info', [lines], true)
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
  }

  public async diffDocument(doc: Document, init = false): Promise<void> {
    let { nvim } = workspace
    let repo = await this.getRepo(doc.bufnr)
    if (!repo) return
    const diffs = await repo.getDiff(doc)
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
          added += diff.lines.length
        } else if (diff.changeType == ChangeType.Delete) {
          removed += diff.lines.length
        } else if (diff.changeType == ChangeType.Change) {
          let [add, remove] = diff.delta
          let min = Math.min(add, remove)
          changed += min
          added += add - min
          removed += remove - min
        }
        let { start, end } = diff
        for (let i = start; i <= end; i++) {
          let topdelete = diff.changeType == ChangeType.Delete && i == 0
          let bottomdelete = diff.changeType == ChangeType.Change && diff.delta[1] > diff.delta[0] && i == end
          signs.push({
            signId,
            changeType: topdelete ? 'topdelete' : bottomdelete ? 'bottomdelete' : diff.changeType,
            lnum: topdelete ? 1 : i
          })
          signId = signId + 1
        }
        if (diff.changeType == ChangeType.Change) {
          let [add, remove] = diff.delta
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
      case 'bottomdelete':
        return 'CocGitChangeRemoved'
    }
    return ''
  }

  public async chunkStage(): Promise<void> {
    let bufnr = await this.nvim.call('bufnr', '%')
    let doc = workspace.getDocument(bufnr)
    if (!doc) return
    let diff = await this.getCurrentChunk()
    if (!diff) return
    let root = this.resolver.getRootOfDocument(doc)
    if (!root) return
    let filepath = path.relative(root, Uri.parse(doc.uri).fsPath)
    const lines = [
      `diff --git a/${filepath} b/${filepath}`,
      `index 000000..000000 100644`,
      `--- a/${filepath}`,
      `+++ b/${filepath}`,
      diff.head
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

  // show commit of current line in floating window
  public async showCommit(): Promise<void> {
    let { nvim } = this
    let bufnr = await nvim.call('bufnr', '%')
    let root = await this.resolveGitRoot(bufnr)
    if (!root) {
      workspace.showMessage(`not a git repository.`, 'warning')
      return
    }
    let fullpath = await nvim.eval('expand("%:p")') as string
    let relpath = path.relative(root, fullpath)
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
    await nvim.command('keepalt above sp')

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

  public async browser(action = 'open'): Promise<void> {
    let { nvim } = this
    let bufnr = await nvim.call('bufnr', '%')
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
    const mode = await nvim.call('mode') as string

    let lines: any = (mode.toLowerCase() === 'v') ? [
      await nvim.eval(`line("'<")`) as number,
      await nvim.eval(`line(">'")`) as number,
    ] : [await nvim.eval('line(".")') as number]
    let doc = workspace.getDocument(bufnr)
    if (doc && doc.filetype == 'markdown') {
      let line = await nvim.call('getline', ['.']) as string
      if (line.startsWith('#')) {
        let words = line.replace(/^#+\s*/, '').split(/\s+/)
        lines = words.map(s => s.toLowerCase()).join('-')
      }
    }

    let fullpath = await nvim.eval('expand("%:p")') as string
    let relpath = path.relative(root, fullpath)
    let names = output.trim().split(/\r?\n/)
    let urls: string[] = []
    for (let name of names) {
      let uri = await this.safeRun(['remote', 'get-url', name], root)
      uri = uri.replace(/\s+$/, '')
      if (!uri.length) continue
      let url = getUrl(uri, head, relpath, lines)
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

  private async getBlameInfo(relpath: string, lnum: number, root: string): Promise<BlameInfo> {
    let info: BlameInfo = {}
    try {
      let res = await this.git.exec(root, ['--no-pager', 'blame', '-b', '-p', '--root', `-L${lnum},${lnum}`, '--date', 'relative', relpath])
      if (!res.stdout) return info
      for (let line of res.stdout.trim().split(/\r?\n/)) {
        let ms = line.match(/^(\S+)\s(.*)/)
        if (ms) {
          let [, field, text] = ms
          if (field == 'author') info.author = text
          if (field == 'author-time') info.time = format(parseInt(text, 10) * 1000, process.env.LANG)
          if (field == 'summary') info.summary = text
        }
      }
      return info
    } catch (e) {
      this.channel.appendLine(e.stack)
    }
    return info
  }

  public async safeRun(args: string[], root: string): Promise<string> {
    try {
      let res = await this.git.exec(root, args)
      return res ? res.stdout.trim() : ''
    } catch (e) {
      return ''
    }
  }

  public dispose(): void {
    disposeAll(this.disposables)
  }
}
