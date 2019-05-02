import { Document, Uri, Disposable, Documentation, FloatFactory, Neovim, workspace, WorkspaceConfiguration, disposeAll } from 'coc.nvim'
import { gitStatus } from './status'
import path from 'path'
import { getDiff } from './diff'
import Resolver from './resolver'
import { ChangeType, Diff, SignInfo } from './types'
import { runCommandWithData } from './util'

export default class DocumentManager {
  private cachedDiffs: Map<number, Diff[]> = new Map()
  private cachedSigns: Map<number, SignInfo[]> = new Map()
  private floatFactory: FloatFactory
  private config: WorkspaceConfiguration
  private disposables: Disposable[] = []
  constructor(
    private nvim: Neovim,
    private resolver: Resolver
  ) {
    this.floatFactory = new FloatFactory(nvim, workspace.env, false, 20, false, 300)
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

  public async refreshStatus(): Promise<void> {
    const { nvim, bufnr } = workspace
    const doc = workspace.getDocument(bufnr)
    let root: string
    if (doc && doc.schema == 'file') {
      root = this.resolver.getGitRoot(Uri.parse(doc.uri).fsPath)
    } else {
      root = await this.resolver.resolveGitRoot()
    }
    let character = this.config.get<string>('branchCharacter', '')
    if (!root) {
      nvim.setVar('coc_git_status', '', true)
    } else {
      let status = await gitStatus(root, character)
      if (workspace.bufnr != bufnr) return
      nvim.setVar('coc_git_status', status, true)
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

  public async chunkInfo(): Promise<void> {
    let diff = await this.getCurrentChunk()
    let { nvim } = this
    if (diff) {
      if (workspace.env.floating) {
        let docs: Documentation[] = [{ content: diff.head + '\n' + diff.lines.join('\n'), filetype: 'diff' }]
        await this.floatFactory.create(docs, false)
      } else {
        const lines = ['``` diff']
        lines.push(diff.head)
        lines.push(...diff.lines)
        lines.push('```')
        nvim.call('coc#util#preview_info', [lines], true)
      }
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

  public async diffDocument(doc: Document): Promise<void> {
    let { nvim } = workspace
    let root = this.resolver.getRootOfDocument(doc)
    if (!root) return
    const diffs = await getDiff(root, doc)
    const { bufnr } = doc
    this.cachedDiffs.set(bufnr, diffs || [])
    const cached = this.cachedSigns.get(bufnr)
    if (!diffs || diffs.length == 0) {
      let buf = doc.buffer
      buf.setVar('coc_git_status', '', true)
      if (cached && cached.length && this.enableGutters) {
        nvim.call('coc#util#unplace_signs', [bufnr, cached.map(o => o.signId)], true)
        this.cachedSigns.set(bufnr, [])
      }
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
      nvim.pauseNotification()
      doc.buffer.setVar('coc_git_status', status, true)
      if (this.enableGutters) {
        if (cached) nvim.call('coc#util#unplace_signs', [bufnr, cached.map(o => o.signId)], true)
        this.cachedSigns.set(bufnr, signs)
        for (let sign of signs) {
          let name = this.getSignName(sign.changeType)
          let cmd = `sign place ${sign.signId} line=${sign.lnum} name=${name} buffer=${bufnr}`
          nvim.command(cmd, true)
        }
      }
      await nvim.resumeNotification()
    }
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
    } catch (e) {
      // tslint:disable-next-line: no-console
      console.error(e)
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

  public dispose(): void {
    disposeAll(this.disposables)
  }
}
