import { Buffer, CancellationToken, Disposable, disposeAll, Document, ExtendedHighlightItem, Uri, window, workspace } from 'coc.nvim'
import Git from './git'
import { CommitChange, CommitComparison, patchArgs } from './commit'

export const COMMIT_DOCUMENT_SCHEME = 'coc-git'

export interface CommitDocumentHunk {
  start: number
  end: number
  addedStart: number
  addedCount: number
  deleted: string[]
  deletedLine: number
  deletedAlign: 'above' | 'below'
}

interface CommitDocumentResource {
  uri: Uri
  root: string
  comparison: CommitComparison
  change: CommitChange
  content?: string
  hunks?: CommitDocumentHunk[]
}

function count(value: string | undefined): number {
  return value === undefined ? 1 : Number(value)
}

function contentLineCount(content: string | undefined): number {
  return content ? content.split('\n').length : 1
}

export function parseCommitDocumentPatch(output: string): CommitDocumentHunk[] {
  const hunks: CommitDocumentHunk[] = []
  let current: CommitDocumentHunk | undefined
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (match) {
      const addedStart = Number(match[3])
      const addedCount = count(match[4])
      const start = Math.max(1, addedStart)
      current = {
        start,
        end: addedCount > 0 ? addedStart + addedCount - 1 : start,
        addedStart,
        addedCount,
        deleted: [],
        deletedLine: addedCount > 0 || addedStart === 0 ? Math.max(0, addedStart - 1) : addedStart - 1,
        deletedAlign: addedCount > 0 || addedStart === 0 ? 'above' : 'below'
      }
      hunks.push(current)
      continue
    }
    if (!current || line.startsWith('\\ No newline at end of file')) continue
    if (line.startsWith('-')) current.deleted.push(line.slice(1))
  }
  return hunks
}

function patchArguments(comparison: CommitComparison, change: CommitChange): string[] {
  const args = patchArgs(comparison, change)
  const separator = args.indexOf('--')
  args.splice(separator, 0, '--unified=0')
  return args
}

function commitUri(comparison: CommitComparison, relativePath: string): Uri {
  return Uri.from({
    scheme: COMMIT_DOCUMENT_SCHEME,
    authority: comparison.commit.sha,
    path: `/${relativePath}`
  })
}

export default class CommitDocumentProvider implements Disposable {
  private readonly resources = new Map<string, CommitDocumentResource>()
  private readonly disposables: Disposable[] = []

  constructor(
    private readonly git: Git,
    private readonly virtualTextSrcId: number
  ) {
    workspace.onDidCloseTextDocument(document => {
      if (Uri.parse(document.uri).scheme === COMMIT_DOCUMENT_SCHEME) this.resources.delete(document.uri)
    }, null, this.disposables)
  }

  public async provideTextDocumentContent(uri: Uri, token: CancellationToken): Promise<string> {
    const resource = this.resources.get(uri.toString())
    if (!resource) throw new Error(`Unknown coc-git commit document: ${uri.toString()}`)
    await this.load(resource, token)
    workspace.nvim.pauseNotification()
    workspace.nvim.command('setlocal buftype=nofile bufhidden=wipe noswapfile readonly', true)
    workspace.nvim.command('filetype detect', true)
    workspace.nvim.resumeNotification(true)
    return resource.content ?? ''
  }

  public async open(root: string, comparison: CommitComparison, change: CommitChange, targetWinId: number, line?: number): Promise<void> {
    const uri = commitUri(comparison, change.path)
    const resource: CommitDocumentResource = { uri, root, comparison, change }
    this.resources.set(uri.toString(), resource)
    const moved = await workspace.nvim.call('win_gotoid', [targetWinId]) as number
    if (!moved) await workspace.nvim.command('new')
    await workspace.openResource(uri.toString())
    const document = workspace.getDocument(uri.toString())
    if (document) {
      await this.load(resource)
      await this.finalizeDocument(document, resource)
      if (line != null) await workspace.nvim.call('cursor', [Math.max(1, Math.min(line, contentLineCount(resource.content))), 1])
    }
  }

  public async nextChunk(): Promise<boolean> {
    return await this.navigate(true)
  }

  public async prevChunk(): Promise<boolean> {
    return await this.navigate(false)
  }

  private async load(resource: CommitDocumentResource, token?: CancellationToken): Promise<void> {
    if (resource.content !== undefined && resource.hunks) return
    const options = token ? { cancellationToken: token } : undefined
    const object = `${resource.comparison.commit.sha}:${resource.change.path}`
    const [content, patch] = await Promise.all([
      this.git.exec(resource.root, ['cat-file', '-p', object], options),
      this.git.exec(resource.root, patchArguments(resource.comparison, resource.change), options)
    ])
    if (token?.isCancellationRequested) return
    resource.content = content.stdout.replace(/\r?\n$/, '')
    resource.hunks = parseCommitDocumentPatch(patch.stdout)
  }

  private async finalizeDocument(document: Document, resource: CommitDocumentResource): Promise<void> {
    await this.load(resource)
    const buffer = document.buffer
    await buffer.setOption('modifiable', false)
    this.decorate(buffer, resource.hunks ?? [])
  }

  private decorate(buffer: Buffer, hunks: CommitDocumentHunk[]): void {
    buffer.clearNamespace(this.virtualTextSrcId)
    const highlights: ExtendedHighlightItem[] = []
    for (const hunk of hunks) {
      for (let line = hunk.addedStart; line < hunk.addedStart + hunk.addedCount; line++) {
        highlights.push({ hlGroup: 'CocGitCommitAdd', lnum: line - 1, colStart: 0, colEnd: -1 })
      }
      for (const deleted of hunk.deleted) {
        buffer.setVirtualText(this.virtualTextSrcId, hunk.deletedLine, [[deleted || ' ', 'CocGitCommitDelete']], {
          text_align: hunk.deletedAlign,
          hl_mode: 'replace'
        })
      }
    }
    buffer.updateHighlights('coc-git-commit-add', highlights, { priority: 4096 })
  }

  private async navigate(forward: boolean): Promise<boolean> {
    const bufnr = await workspace.nvim.call('bufnr', ['%']) as number
    const document = workspace.getDocument(bufnr)
    if (!document || Uri.parse(document.uri).scheme !== COMMIT_DOCUMENT_SCHEME) return false
    const resource = this.resources.get(document.uri)
    if (!resource) return true
    await this.load(resource)
    const hunks = resource.hunks ?? []
    if (!hunks.length) return true
    const line = await workspace.nvim.call('line', ['.']) as number
    const ordered = forward ? hunks : hunks.slice().reverse()
    const target = ordered.find(hunk => forward ? hunk.start > line : hunk.end < line)
    if (target) {
      await window.moveTo({ line: target.start - 1, character: 0 })
    } else if (await workspace.nvim.getOption('wrapscan')) {
      const wrapped = forward ? hunks[0] : hunks[hunks.length - 1]
      await window.moveTo({ line: wrapped.start - 1, character: 0 })
    }
    return true
  }

  public dispose(): void {
    disposeAll(this.disposables)
    this.resources.clear()
  }
}
