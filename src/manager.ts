import { Document, events, Uri, Disposable, Documentation, FloatFactory, Neovim, workspace, WorkspaceConfiguration, disposeAll } from 'coc.nvim'
import { gitStatus } from './status'
import path from 'path'
import { getUrl } from './helper'
import { getDiff } from './diff'
import Resolver from './resolver'
import { ChangeType, Diff, SignInfo } from './types'
import { runCommandWithData, safeRun, spawnCommand, shellescape, equals } from './util'

interface FoldSettings {
  foldmethod: string
  foldlevel: number
  foldenable: boolean
}

export default class DocumentManager {
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
  private curseMoveTs: number
  constructor(
    private nvim: Neovim,
    private resolver: Resolver
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
      events.on('CursorHold', this.showBlameInfo, this, this.disposables)
      events.on('CursorMoved', () => {
        this.curseMoveTs = Date.now()
      }, null, this.disposables)
      events.on('InsertEnter', async bufnr => {
        let { virtualTextSrcId } = this
        if (virtualTextSrcId) {
          let buffer = nvim.createBuffer(bufnr)
          await nvim.request('nvim_buf_clear_namespace', [buffer, virtualTextSrcId, 0, -1])
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

  private async showBlameInfo(bufnr: number): Promise<void> {
    let { virtualTextSrcId, nvim } = this
    if (!virtualTextSrcId || !this.showBlame) return
    let ts = Date.now()
    let virtualText = this.config.get<boolean>('addGlameToVirtualText', false)
    let blameVar = this.config.get<boolean>('addGlameToBufferVar', false)
    let doc = workspace.getDocument(bufnr)
    if (!doc || doc.schema != 'file' || doc.isIgnored) return
    let root = await this.resolveGitRoot(bufnr)
    if (!root || this.curseMoveTs > ts) return
    let lnum = await nvim.call('line', '.')
    let filepath = Uri.parse(doc.uri).fsPath
    let relpath = shellescape(path.relative(root, filepath))
    let res = await safeRun(`git --no-pager blame -b --root -L${lnum},${lnum} --date relative ${relpath}`, { cwd: root })
    if (!res) return
    let match = res.split(/\r?\n/)[0].match(/^\w+\s\((.+?)\s*\d+\)/)
    if (!match) return
    if (workspace.insertMode || this.curseMoveTs > ts) return
    let buffer = nvim.createBuffer(bufnr)
    let modified = await buffer.getOption('modified')
    if (modified) return
    const blameInfo = match[1]
    if (blameVar) {
      doc.buffer.setVar('coc_git_blame', blameInfo, true)
      await this.autocmdNotification()
    }
    if (virtualText) {
      await nvim.request('nvim_buf_clear_namespace', [buffer, virtualTextSrcId, 0, -1])
      const prefix = this.config.get<string>('virtualTextPrefix', '     ')
      let logRes = await safeRun(`git --no-pager blame -b -p --root -L${lnum},${lnum} --date relative ${relpath}`, { cwd: root })
      if (!logRes) logRes = ''
      let line = logRes.split(/\r?\n/).find(l => l.startsWith('summary ')) || ''
      const commitMsg = blameInfo.includes('Not Committed Yet') ? '' : line.replace('summary ', '')
      const blameText = `${prefix}${blameInfo}${commitMsg ? ` · ${commitMsg}` : ''}`
      await buffer.setVirtualText(virtualTextSrcId, lnum - 1, [[blameText, 'CocCodeLens']])
    }
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

  public async refreshStatus(bufnr?: number): Promise<void> {
    const { nvim } = this
    const buf = bufnr ? nvim.createBuffer(bufnr) : await nvim.buffer
    const doc = workspace.getDocument(buf.id)
    let root: string
    if (doc && doc.schema == 'file') {
      root = this.resolver.getGitRoot(Uri.parse(doc.uri).fsPath)
    } else {
      root = await this.resolver.resolveGitRoot()
    }
    let character = this.config.get<string>('branchCharacter', '')
    if (!root) {
      nvim.setVar('coc_git_status', '', true)
      await this.autocmdNotification()
    } else {
      const changedDecorator = this.config.get<string>('changedDecorator', '*')
      const conflictedDecorator = this.config.get<string>('conflictedDecorator', 'x')
      const stagedDecorator = this.config.get<string>('stagedDecorator', '●')
      const untrackedDecorator = this.config.get<string>('untrackedDecorator', '…')
      let status = await gitStatus(root, character, {
        changedDecorator,
        conflictedDecorator,
        stagedDecorator,
        untrackedDecorator,
      })
      if (workspace.bufnr != buf.id) return
      nvim.setVar('coc_git_status', status, true)
      await this.autocmdNotification()
    }
  }

  public async resolveGitRoot(bufnr: number): Promise<string> {
    let doc = workspace.getDocument(bufnr)
    return this.resolver.resolveGitRoot(doc)
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
    if (!doc || doc.buftype !== '' || doc.schema !== 'file') return
    let root = this.resolver.getRootOfDocument(doc)
    if (!root) return
    const diffs = await getDiff(root, doc)
    const { bufnr } = doc
    let changedtick = this.cachedChangeTick.get(bufnr)
    if (changedtick == doc.changedtick
      && equals(diffs, this.cachedDiffs.get(bufnr))) {
      return
    }
    this.cachedDiffs.set(bufnr, diffs || [])
    this.cachedChangeTick.set(bufnr, doc.changedtick)
    const cached = this.cachedSigns.get(bufnr)
    if (!diffs || diffs.length == 0) {
      let buf = doc.buffer
      buf.setVar('coc_git_status', '', true)
      await this.autocmdNotification()
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
          add += add - min
          remove += remove - min
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
      doc.buffer.setVar('coc_git_status', status, true)
      await this.autocmdNotification()
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

  private async autocmdNotification(): Promise<void> {
    const nvim = this.nvim
    const exists = await nvim.call('exists', '#User#CocGitStatusChange')
    if (exists) {
      nvim.command('doautocmd User CocGitStatusChange', true)
    }
  }

  public async chunkStage(): Promise<void> {
    let bufnr = await this.nvim.call('bufnr', '%')
    let doc = workspace.getDocument(bufnr)
    if (!doc) return
    let diff = await this.getCurrentChunk()
    if (!diff) return
    let root = this.resolver.getRootOfDocument(doc)
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
      await runCommandWithData('git', ['apply', '--cached', '--unidiff-zero', '-'], root, lines.join('\n'))
      this.diffDocument(doc, true).catch(_e => {
        // noop
      })
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
    let res = await safeRun(`git ls-files -- ${shellescape(relpath)}`, { cwd: root })
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
      await this.showDoc('not committed yet!', 'txt')
      return
    }
    await nvim.command('keepalt above sp')

    let hasFugitive = await nvim.getVar('loaded_fugitive')
    if (hasFugitive) {
      await nvim.command(`Gedit ${commit}`)
    } else {
      let content = await safeRun(`git --no-pager show ${commit}`, { cwd: root })
      if (content == null) return
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
    let output = await safeRun('git remote', { cwd: root })
    if (!output.trim()) {
      workspace.showMessage(`No remote found`, 'warning')
      return
    }
    let head = await safeRun('git symbolic-ref --short -q HEAD', { cwd: root })
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
      let uri = await safeRun(`git remote get-url ${name}`, { cwd: root })
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
    let res = await safeRun(`git diff --cached`, { cwd: root })
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

  public dispose(): void {
    disposeAll(this.disposables)
  }
}
