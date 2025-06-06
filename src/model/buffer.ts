import { Disposable, Document, Documentation, FloatFactory, Mutex, OutputChannel, Position, Range, window, workspace } from 'coc.nvim'
import debounce from 'debounce'
import { format } from 'timeago.js'
import { URL } from 'url'
import { BlameInfo, ChangeType, Conflict, ConflictParseState, ConflictPart, Diff, FoldSettings, GitConfiguration, SignInfo, StageChunk } from '../types'
import { createUnstagePatch, equals, getRepoUrl, getUrl, toUnixSlash } from '../util'
import Git from './git'
import Repo from './repo'

const signGroup = 'CocGit'
const revPattern = '([0-9A-Za-z_.:/-]+)'
const startPattern = new RegExp(`^<{7} (${revPattern})(:? .+)?$`)
const sepPattern = new RegExp(`^={7}$`)
const endPattern = new RegExp(`^>{7} (${revPattern})(:? .+)?$`)
const commonPattern = /^\|{7}\smerged\scommon\sancestors/

export default class GitBuffer implements Disposable {
  private blameInfo: BlameInfo[] = []
  private diffs: Diff[] = []
  private conflicts: Conflict[] = []
  private currentSigns: SignInfo[] = []
  private gitStatus: string = ''
  private foldEnabled = false
  private foldSettings: FoldSettings
  private mutex: Mutex
  private _disposed = false
  public refresh: Function & { clear(): void }
  constructor(
    private doc: Document,
    private config: GitConfiguration,
    public readonly relpath: string,
    public readonly repo: Repo,
    private git: Git,
    private channel: OutputChannel,
    private floatFactory: FloatFactory | undefined,
    private hasConflicts: boolean
  ) {
    this.mutex = new Mutex()
    this.refresh = debounce(() => {
      this._refresh().catch(e => {
        channel.append(`[Error] ${e.message}`)
      })
    }, 200)
    this._refresh()
  }

  public get cachedDiffs(): Diff[] {
    return this.diffs
  }

  public async _refresh(): Promise<void> {
    if (this._disposed) return
    this.refresh.clear()
    let release = await this.mutex.acquire()
    let result = await Promise.allSettled([
      this.diffDocument(),
      this.loadBlames(),
      this.parseConflicts()
    ])
    result.forEach(res => {
      if (res.status === 'rejected') this.channel.append(`[Error] refresh error ${res.reason}`)
    })
    release()
  }

  public getChunk(line: number): Diff | undefined {
    if (!this.diffs || this.diffs.length == 0) return undefined
    return this.diffs.find(ch => {
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

  public async chunkUndo(): Promise<void> {
    let line = await workspace.nvim.call('line', '.')
    let diff = this.getChunk(line)
    if (!diff) return
    let { start, lines, changeType } = diff
    let added = lines.filter(s => s.startsWith('-')).map(s => s.slice(1))
    let removeCount = lines.filter(s => s.startsWith('+')).length
    let buf = this.doc.buffer
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

  public async chunkStage(): Promise<void> {
    let relpath = toUnixSlash(this.relpath)
    let line = await workspace.nvim.call('line', '.')
    let diff = this.getChunk(line)
    if (!diff) {
      window.showErrorMessage('Not positioned in git chunk')
      return
    }
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
      await this.git.exec(this.repo.root, ['apply', '--cached', '--unidiff-zero', '-'], { input: lines.join('\n') })
      this.refresh()
    } catch (e) {
      this.channel.appendLine(`[Error] ${e.message}`)
    }
  }

  public async chunkUnstage(): Promise<void> {
    let { nvim } = workspace
    const { diffs } = this
    // find out staged line first.
    let line = await nvim.call('line', '.')
    let adjust = 0
    let invalid = false
    for (let diff of diffs) {
      if (diff.end >= line) {
        if (diff.start <= line && diff.changeType != ChangeType.Delete) {
          window.showErrorMessage(`Current line contains unstaged change.`)
          invalid = true
        }
        break
      }
      adjust -= diff.added.count
      adjust += diff.removed.count
    }
    if (invalid) return
    line = line + adjust
    let stagedDiff = await this.repo.getStagedChunks(this.relpath)
    let chunks: StageChunk[] = Object.values(stagedDiff)[0]
    if (!chunks.length) {
      window.showErrorMessage(`Staged chunk not found`)
      return
    }
    let chunk = chunks.find(o => o.add.lnum <= line && o.add.lnum + o.add.count >= line)
    if (!chunk) {
      window.showErrorMessage(`Unable to find staged chunk on current line`)
      return
    }
    this.channel.appendLine(`[Info] resolved chunk ${JSON.stringify(chunk, null, 2)}`)
    let patch = createUnstagePatch(this.relpath, chunk)
    if (!patch) return
    try {
      await this.git.exec(this.repo.root, ['apply', '--cached', '--unidiff-zero', '-'], { input: patch })
      this.refresh()
    } catch (e) {
      window.showErrorMessage(`Unable to apply patch: ${e.message}`)
      this.channel.appendLine(`[Error] ${e.message}`)
    }
  }

  public async nextChunk(): Promise<void> {
    const { diffs } = this
    let { nvim } = workspace
    if (!diffs || diffs.length == 0) return
    let line = await nvim.call('line', '.')
    for (let diff of diffs) {
      if (diff.start > line) {
        await window.moveTo({ line: Math.max(diff.start - 1, 0), character: 0 })
        return
      }
    }
    if (await nvim.getOption('wrapscan')) {
      await window.moveTo({ line: Math.max(diffs[0].start - 1, 0), character: 0 })
    }
  }

  public async prevChunk(): Promise<void> {
    const { nvim } = workspace
    let { diffs } = this
    let line = await nvim.call('line', '.')
    if (!diffs || diffs.length == 0) return
    for (let diff of diffs.slice().reverse()) {
      if (diff.end < line) {
        await window.moveTo({ line: Math.max(diff.start - 1, 0), character: 0 })
        return
      }
    }
    if (await nvim.getOption('wrapscan')) {
      await window.moveTo({ line: Math.max(diffs[diffs.length - 1].start - 1, 0), character: 0 })
    }
  }

  public async chunkInfo(): Promise<void> {
    let line = await workspace.nvim.call('line', '.')
    let diff = this.getChunk(line)
    if (diff) {
      let content = diff.head + '\n' + diff.lines.join('\n')
      await this.showDoc(content, 'diff')
    } else {
      let chunks: StageChunk[] = []
      try {
        let stagedDiff = await this.repo.getStagedChunks(this.relpath)
        chunks = Object.values(stagedDiff)[0]
      } catch (e) {
        // return
      }
      let adjust = 0
      for (let diff of this.diffs) {
        if (diff.end >= line) {
          break
        }
        adjust -= diff.added.count
        adjust += diff.removed.count
      }
      line = line + adjust
      let chunk = chunks.find(o => o.add.lnum <= line && o.add.lnum + o.add.count >= line)
      if (chunk) {
        let content = 'Staged changes' + '\n' + chunk.lines.join('\n')
        await this.showDoc(content, 'diff')
      } else {
        await this.showCommit(true)
      }
    }
  }

  public async showBlameInfo(lnum: number): Promise<void> {
    let { nvim } = workspace
    let { virtualTextSrcId, addGBlameToBufferVar, addGBlameToVirtualText } = this.config
    if (!this.showBlame) return
    let infos = this.blameInfo
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
    let buffer = nvim.createBuffer(this.doc.bufnr)
    let hide_blame = await nvim.getVar("coc_git_hide_blame_virtual_text")
    if (hide_blame) {
      buffer.clearNamespace(virtualTextSrcId)
    } else {
      if (addGBlameToBufferVar) {
        nvim.pauseNotification()
        buffer.setVar('coc_git_blame', blameText, true)
        nvim.call('coc#util#do_autocmd', ['CocGitStatusChange'], true)
        nvim.resumeNotification(false, true)
      }
      if (addGBlameToVirtualText) {
        const prefix = this.config.virtualTextPrefix
        nvim.pauseNotification()
        buffer.clearNamespace(virtualTextSrcId)
        buffer.setVirtualText(virtualTextSrcId, lnum - 1, [[prefix + blameText, 'CocCodeLens']])
        nvim.resumeNotification(true, true)
      }
    }
  }

  public async showBlameDoc(lnum: number): Promise<void> {
    let indexed = await this.repo.isIndexed(this.relpath)
    if (!indexed) {
      window.showWarningMessage('File not indexed')
    } else if (await this.repo.isShallow()) {
      window.showWarningMessage('Shallow repository, blame not available')
    } else {
      let infos = await this.getBlameInfo([lnum, lnum])
      let info = infos.find(o => lnum >= o.startLnum && lnum <= o.endLnum)
      if (info && info.author && info.author != 'Not Committed Yet') {
        let blameText: string[] = []
        blameText.push(`${info.author}, ${info.time}`)
        blameText.push(`${info.summary}`)
        blameText.push(`${info.sha.substring(0, 7)}`)
        await this.showDoc(blameText.join('\n\n'), 'text')
      } else {
        window.showWarningMessage('Not committed yet')
      }
    }
  }

  public async diffDocument(force = false): Promise<void> {
    let { nvim } = workspace
    let revision = this.config.diffRevision
    const { bufnr } = this.doc
    let content = this.doc.content
    let eol = this.doc.textDocument['eol']
    let encoding = await this.doc.buffer.getOption('fileencoding') as string
    const diffs = await this.repo.getDiff(this.relpath, eol ? content : content + '\n', revision, encoding || 'utf8')
    if (diffs == null) return
    if (diffs.length === 0) {
      this.currentSigns = []
      this.diffs = []
      this.setBufferStatus('')
      if (this.config.enableGutters) {
        nvim.call('sign_unplace', [signGroup, { buffer: bufnr }], true)
        nvim.redrawVim()
      }
      return
    }
    if (equals(diffs, this.diffs)) {
      return
    }
    this.diffs = diffs
    let added = 0
    let changed = 0
    let removed = 0
    let signs: SignInfo[] = []
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
          changeType: topdelete ? 'topdelete' : changedelete ? 'changedelete' : diff.changeType,
          lnum: topdelete ? 1 : i
        })
      }
      if (diff.changeType == ChangeType.Change) {
        let [add, remove] = [diff.added.count, diff.removed.count]
        if (add > remove) {
          for (let i = 0; i < add - remove; i++) {
            signs.push({
              changeType: ChangeType.Add,
              lnum: diff.end + 1 + i
            })
          }
        }
      }
    }
    let items: string[] = []
    if (added) items.push(`+${added}`)
    if (changed) items.push(`~${changed}`)
    if (removed) items.push(`-${removed}`)
    let status = '  ' + `${items.join(' ')} `
    this.setBufferStatus(status)
    this.currentSigns = signs
    if (!this.config.realtimeGutters && !force) return
    this.updateGutters()
  }

  public updateGutters(): void {
    if (this._disposed) return
    if (!this.config.enableGutters) return
    let { nvim } = workspace
    let { bufnr } = this.doc
    let { signPriority } = this.config
    let signs = this.currentSigns
    nvim.pauseNotification()
    nvim.call('sign_unplace', [signGroup, { buffer: bufnr }], true)
    for (let sign of signs) {
      let name = this.getSignName(sign.changeType)
      nvim.call('sign_place', [0, signGroup, name, bufnr, { lnum: sign.lnum, priority: signPriority }], true)
    }
    nvim.resumeNotification(true, true)
  }

  private async loadBlames(): Promise<void> {
    if (!this.showBlame) return
    let result: BlameInfo[] = []
    let indexed = await this.repo.isIndexed(this.relpath)
    if (indexed) result = await this.getBlameInfo()
    this.blameInfo = result
  }

  private async getBlameInfo(range?: [number, number]): Promise<BlameInfo[]> {
    let { relpath } = this
    let root = this.repo.root
    let res: BlameInfo[] = []
    const useRealTime = this.config.blameUseRealTime
    try {
      let currentAuthor = await this.repo.getUsername()
      const args: string[] = ['--no-pager', 'blame', '-w', '-b', '-p', '--incremental', '--root', '--date', 'relative', '--contents', '-', relpath]
      if (range) args.push('-L', range.join(','))
      let r = await this.git.exec(root, args, {
        log: false,
        input: this.doc.content
      })
      if (!r.stdout) return res
      let info: BlameInfo
      for (let line of r.stdout.trim().split(/\r?\n/)) {
        line = line.trim()
        if (/^(author |committer )?External file \(--contents\)/.test(line)) {
          line = 'Not committed yet.'
        }
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
            const timestamps = parseInt(text, 10) * 1000
            info.time = useRealTime ? new Date(timestamps).toLocaleString() : format(timestamps, process.env.LANG)
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

  public async diffCached(): Promise<void> {
    let res = await this.repo.safeRun(['diff', '--cached'])
    if (!res.trim()) {
      window.showWarningMessage('Empty diff')
      return
    }
    let { nvim } = workspace
    nvim.pauseNotification()
    nvim.command(`keepalt above new +setl\\ previewwindow`, true)
    nvim.call('append', [0, res.split(/\r?\n/)], true)
    nvim.command('normal! Gdd', true)
    nvim.command(`exe 1`, true)
    nvim.command('setfiletype git', true)
    nvim.command('setl buftype=nofile nomodifiable bufhidden=wipe nobuflisted', true)
    await nvim.resumeNotification()
  }

  public async nextConflict(): Promise<void> {
    let { nvim } = workspace
    if (!this.conflicts.length) {
      window.showWarningMessage('No conflicts detected')
      return
    }
    let line = await nvim.call('line', '.')
    for (let conflict of this.conflicts) {
      if (conflict.start > line) {
        await window.moveTo({ line: Math.max(conflict.start - 1, 0), character: 0 })
        return
      }
    }
    if (await nvim.getOption('wrapscan')) {
      await window.moveTo({ line: Math.max(this.conflicts[0].start - 1, 0), character: 0 })
    }
  }

  public async prevConflict(): Promise<void> {
    let { nvim } = workspace
    if (!this.conflicts.length) {
      window.showWarningMessage('No conflicts detected', 'warning')
      return
    }
    let line = await nvim.call('line', '.')
    for (let conflict of this.conflicts) {
      if (conflict.start > line) {
        await window.moveTo({ line: Math.max(conflict.start - 1, 0), character: 0 })
        return
      }
    }
    if (await nvim.getOption('wrapscan')) {
      await window.moveTo({ line: Math.max(this.conflicts[0].start - 1, 0), character: 0 })
    }
  }

  public async conflictKeepPart(part: ConflictPart) {
    const { nvim } = workspace
    let conflicts = this.conflicts
    if (!conflicts || conflicts.length == 0) {
      window.showWarningMessage('No conflicts detected')
      return
    }
    let line = await nvim.call('line', '.')
    for (let conflict of conflicts) {
      if (conflict.start <= line && conflict.end >= line) {
        switch (part) {
          case ConflictPart.Current:
            let start = conflict.common ? conflict.common : conflict.sep
            await nvim.command(`${start},${conflict.end}d | ${conflict.start}d`)
            return
          case ConflictPart.Incoming:
            await nvim.command(`${conflict.end}d | ${conflict.start},${conflict.sep}d`)
            return
          case ConflictPart.Both:
            if (conflict.common) {
              await nvim.command(`${conflict.end}d | ${conflict.common},${conflict.sep}d | ${conflict.start}d`)
            } else {
              await nvim.command(`${conflict.end}d | ${conflict.sep}d | ${conflict.start}d`)
            }
            return
        }
      }
    }
    window.showWarningMessage('Not positioned on a conflict')
  }

  public async browser(action = 'open', range?: [number, number], permalink = false): Promise<void> {
    let { nvim } = workspace
    let config = workspace.getConfiguration('git')
    let head = (await this.repo.safeRun(['rev-parse', 'HEAD'])).trim()
    let branch = config.get<string>('browserBranchName', '').trim()
    if (!branch.length) {
      branch = (await this.repo.safeRun(['symbolic-ref', '--short', '-q', 'HEAD'])).trim()
    }

    let lines: any = range && range.length == 2 ? [
      range[0],
      range[1]
    ] : [await nvim.eval('line(".")') as number]
    if (this.doc.filetype == 'markdown') {
      let line = await nvim.call('getline', ['.']) as string
      if (line.startsWith('#')) {
        let words = line.replace(/^#+\s*/, '').split(/\s+/)
        lines = words.map(s => s.toLowerCase()).join('-')
      }
    }

    // get remote list
    let output = await this.repo.safeRun(['remote'])
    if (!output.trim()) {
      window.showWarningMessage(`No remote found`)
      return
    }
    let names = output.trim().split(/\r?\n/)

    let browserRemoteName = config.get<string>('browserRemoteName', '').trim()
    if (browserRemoteName.length > 0) {
      if (names.includes(browserRemoteName)) {
        names = [browserRemoteName]
      } else {
        window.showWarningMessage('Configured git.browserRemoteName missing from remote list')
        return
      }
    }

    let urls: string[] = []
    for (let name of names) {
      let uri = await this.repo.safeRun(['config', '--get', `remote.${name}.url`])
      if (!uri.length) continue
      let repoURL = getRepoUrl(uri)
      if (!repoURL) continue
      let tmp = new URL(repoURL)
      let hostname = tmp.hostname
      let fix = "|"
      try {
        fix = config.get<object>("urlFix")[hostname][permalink ? 1 : 0]
      } catch (e) {}
      let url = getUrl(fix, repoURL, permalink ? head : branch, this.relpath.replace(/\\\\/g, '/'), lines)
      if (url) urls.push(url)
    }
    if (urls.length == 1) {
      if (action == 'open') {
        await workspace.openResource(urls[0])
      } else {
        nvim.command(`let @+ = '${urls[0]}'`, true)
        window.showInformationMessage('Copied url to clipboard')
      }
    } else if (urls.length > 1) {
      let url = await window.showQuickPick(urls, { canPickMany: false, title: 'Pick remote url' })
      if (url) {
        if (action == 'open') {
          await workspace.openResource(url)
        } else {
          nvim.command(`let @+ = '${url}'`, true)
          nvim.command(`let @* = '${url}'`, true)
          window.showInformationMessage('Copied url to clipboard')
        }
      }
    }
  }

  // show commit of current line in split window
  public async showCommit(useFloating = false): Promise<void> {
    let indexed = await this.repo.isIndexed(this.relpath)
    if (!indexed) {
      window.showWarningMessage(`"${this.relpath}" not indexed.`)
      return
    }
    let nvim = workspace.nvim
    let line = await nvim.eval('line(".")') as number
    let args = ['--no-pager', 'blame', '-w', '-l', '--root', '-t', `-L${line},${line}`, this.relpath]
    let res = await this.repo.exec(args)
    let output = res.stdout.trim()
    if (!output.length) return
    let commit = output.match(/^\S+/)[0]
    if (/^0+$/.test(commit)) {
      window.showWarningMessage('not committed yet!')
      return
    }
    if (!useFloating) useFloating = this.config.showCommitInFloating
    if (useFloating) {
      let content = await this.repo.safeRun(['--no-pager', 'show', commit])
      if (content == null) return
      await this.showDoc(content.trim())
      return
    }
    await nvim.command(`keepalt above ${this.config.splitWindowCommand}`)

    let hasFugitive = await nvim.getVar('loaded_fugitive')
    if (hasFugitive) {
      await nvim.command(`Gedit ${commit}`)
    } else {
      let content = await this.repo.safeRun(['--no-pager', 'show', commit])
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

  public async toggleFold(): Promise<void> {
    let { nvim } = workspace
    let buf = this.doc.buffer
    let win = await nvim.window
    let bufnr = buf.id
    let doc = workspace.getDocument(bufnr)
    if (!doc) return
    let infos = this.currentSigns
    if (!infos || infos.length == 0) {
      window.showWarningMessage('No changes')
      return
    }
    let lnums = infos.map(o => o.lnum)
    let foldContext = this.config.foldContext
    let max = this.doc.lineCount
    let ranges = []
    let start = null
    const addRange = (from: number, to: number) => {
      let s = plus(from, foldContext, max)
      let e = minus(to, foldContext, 0)
      if (e - s <= 0) return
      ranges.push([s, e])
    }
    for (let i = 1; i <= doc.lineCount; i++) {
      let fold = lnums.indexOf(i) == -1
      if (fold && start == null) {
        start = i
        continue
      }
      if (start != null && !fold) {
        addRange(start, i - 1)
        start = null
      }
      if (start != null && fold && i == doc.lineCount) {
        addRange(start, i)
      }
    }

    let enabled = this.foldEnabled
    if (enabled) {
      this.foldEnabled = false
      let cursor = await nvim.eval('getpos(".")') as number[]
      let lnums = ranges.map(o => o[0])
      let settings = this.foldSettings
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
      this.foldEnabled = true
      let [foldmethod, foldenable, foldlevel] = await nvim.eval('[&foldmethod,&foldenable,&foldlevel]') as [string, number, number]
      this.foldSettings = {
        foldmethod,
        foldenable: foldenable !== 0,
        foldlevel
      }
      nvim.pauseNotification()
      win.setOption('foldmethod', 'manual', true)
      nvim.command('silent! normal! zE', true)
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

  public async toggleGutters(enabled: boolean): Promise<void> {
    this.config.enableGutters = enabled
    let { nvim } = workspace
    if (!enabled) {
      nvim.call('sign_unplace', [signGroup, { buffer: this.doc.bufnr }], true)
      nvim.redrawVim()
    } else {
      this.diffs = []
      await this.diffDocument(true)
    }
  }

  private async parseConflicts(): Promise<void> {
    if (!this.hasConflicts || !this.config.conflict.enabled) return
    const lines = this.doc.textDocument.lines
    let conflicts: Conflict[] = []
    let conflict: Conflict = null
    let state = ConflictParseState.Initial
    let mkStartConflict = (index: number, current: string) => ({
      start: index + 1,
      sep: 0,
      end: 0,
      current,
      incoming: '',
    })
    lines.forEach((line, index) => {
      switch (state) {
        case ConflictParseState.Initial: {
          const match = line.match(startPattern)
          if (match) {
            conflict = mkStartConflict(index, match[1])
            state = ConflictParseState.MatchedStart
          }
          break
        }
        case ConflictParseState.MatchedCommon:
        case ConflictParseState.MatchedStart: {
          let match = line.match(sepPattern)
          if (match) {
            conflict.sep = index + 1
            state = ConflictParseState.MatchedSep
          } else {
            const startMatch = line.match(startPattern)
            if (startMatch) {
              conflict = mkStartConflict(index, startMatch[1])
              state = ConflictParseState.MatchedStart
            } else if (line.match(endPattern)) {
              conflict = null
              state = ConflictParseState.Initial
            } else if (line.match(commonPattern)) {
              conflict.common = index + 1
              state = ConflictParseState.MatchedCommon
            }
          }
          break
        }
        case ConflictParseState.MatchedSep: {
          const match = line.match(endPattern)
          if (match) {
            conflict.end = index + 1
            conflict.incoming = match[1]
            conflicts.push(conflict)
            conflict = null
            state = ConflictParseState.Initial
          } else {
            const startMatch = line.match(startPattern)
            if (startMatch) {
              conflict = mkStartConflict(index, startMatch[1])
              state = ConflictParseState.MatchedStart
            } else if (line.match(sepPattern)) {
              conflict = null
              state = ConflictParseState.Initial
            }
          }
          break
        }
      }
    })
    this.conflicts = conflicts
    this.highlightConflicts(conflicts)
    if (conflicts.length == 0) {
      this.hasConflicts = false
    }
  }

  private async highlightConflicts(conflicts: Conflict[]): Promise<void> {
    let buffer = this.doc.buffer
    let currentHlGroup = this.config.conflict.currentHlGroup
    let incomingHlGroup = this.config.conflict.incomingHlGroup
    let commonHlGroup = this.config.conflict.commonHlGroup
    let { nvim } = workspace
    nvim.pauseNotification()
    buffer.clearNamespace(this.config.conflictSrcId, 0, -1)
    const srcId = this.config.conflictSrcId
    conflicts.map(conflict => {
      let currEnd = conflict.common ? conflict.common - 1 : conflict.sep - 1
      let currRange = Range.create(Position.create(conflict.start - 1, 0), Position.create(currEnd, 0))
      let incomingRange = Range.create(Position.create(conflict.sep, 0), Position.create(conflict.end, 0))
      buffer.highlightRanges(srcId, currentHlGroup, [currRange])
      buffer.highlightRanges(srcId, incomingHlGroup, [incomingRange])
      if (conflict.common) {
        let range = Range.create(Position.create(conflict.common - 1, 0), Position.create(conflict.sep - 1, 0))
        buffer.highlightRanges(srcId, commonHlGroup, [range])
      }
    })
    nvim.resumeNotification(false, true)
  }

  public async showDoc(content: string, filetype = 'diff'): Promise<void> {
    if (this.floatFactory) {
      let docs: Documentation[] = [{ content, filetype }]
      await this.floatFactory.show(docs, this.config.floatConfig)
    } else {
      const lines = content.split('\n')
      workspace.nvim.call('coc#ui#preview_info', [lines, 'diff'], true)
    }
  }

  private setBufferStatus(status: string): void {
    let exists = this.gitStatus
    if (exists == status) return
    this.gitStatus = status
    let { nvim } = workspace
    let buffer = nvim.createBuffer(this.doc.bufnr)
    nvim.pauseNotification()
    buffer.setVar('coc_git_status', status, true)
    nvim.callTimer('coc#util#do_autocmd', ['CocGitStatusChange'], true)
    nvim.resumeNotification(false, true)
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

  private get showBlame(): boolean {
    return this.config.addGBlameToVirtualText || this.config.addGBlameToBufferVar
  }

  public dispose(): void {
    let { nvim } = workspace
    let { bufnr } = this.doc
    let buffer = nvim.createBuffer(bufnr)
    buffer.setVar('coc_git_status', '', true)
    buffer.clearNamespace(this.config.conflictSrcId, 0, -1)
    nvim.call('sign_unplace', [signGroup, { buffer: bufnr }], true)
    this.refresh.clear()
    if (this.config.addGBlameToBufferVar) {
      buffer.setVar('coc_git_blame', '', true)
    }
    if (this.config.addGBlameToVirtualText) {
      buffer.clearNamespace(this.config.virtualTextSrcId)
    }
    nvim.resumeNotification(false, true)
    this._disposed = true
    this.foldEnabled = false
    this.blameInfo = undefined
    this.diffs = undefined
    this.conflicts = undefined
    this.currentSigns = undefined
  }
}

function plus(val: number, count: number, max: number): number {
  if (!count) return val
  val = val + count
  return Math.min(max, val)
}

function minus(val: number, count: number, min: number): number {
  if (!count) return val
  val = val - count
  return Math.max(min, val)
}
