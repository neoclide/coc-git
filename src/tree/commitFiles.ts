import fs from 'fs'
import path from 'path'
import { CancellationTokenSource, Command, commands, Disposable, Emitter, Neovim, TreeDataProvider, TreeItem, TreeItemAction, TreeItemCollapsibleState, TreeItemIcon, TreeView, Uri, window, workspace } from 'coc.nvim'
import Manager from '../manager'
import { assertParentAvailable, CommitChange, CommitComparison, loadComparisonForCommit, resolveCommit } from '../model/commit'
import { feedTreeToggleKey } from '../util'

interface CommitTreeAggregate {
  fileCount: number
  additions: number
  deletions: number
  binaryCount: number
}

export interface CommitRootNode extends CommitTreeAggregate {
  kind: 'root'
  id: string
  name: string
  relativePath: ''
  parent: undefined
  comparison: CommitComparison
  children: Array<CommitDirectoryNode | CommitFileNode>
}

export interface CommitDirectoryNode extends CommitTreeAggregate {
  kind: 'directory'
  id: string
  name: string
  relativePath: string
  parent: CommitRootNode | CommitDirectoryNode
  children: Array<CommitDirectoryNode | CommitFileNode>
}

export interface CommitFileNode {
  kind: 'file'
  id: string
  name: string
  relativePath: string
  parent: CommitRootNode | CommitDirectoryNode
  change: CommitChange
  comparison: CommitComparison
}

export type CommitTreeNode = CommitRootNode | CommitDirectoryNode | CommitFileNode

interface CommitFilesOpenOptions {
  showCurrentFile?: boolean
  line?: number
}

function emptyAggregate(): CommitTreeAggregate {
  return { fileCount: 0, additions: 0, deletions: 0, binaryCount: 0 }
}

function addAggregate(target: CommitTreeAggregate, source: CommitTreeAggregate): void {
  target.fileCount += source.fileCount
  target.additions += source.additions
  target.deletions += source.deletions
  target.binaryCount += source.binaryCount
}

function addFileAggregate(target: CommitTreeAggregate, change: CommitChange): void {
  target.fileCount++
  if (change.binary) {
    target.binaryCount++
  } else {
    target.additions += change.additions ?? 0
    target.deletions += change.deletions ?? 0
  }
}

function treeKey(comparison: CommitComparison): string {
  return `${comparison.commit.sha}\0${comparison.baseSha ?? 'root'}`
}

function compareNodes(left: CommitTreeNode, right: CommitTreeNode): number {
  if (left.kind === 'directory' && right.kind !== 'directory') return -1
  if (left.kind !== 'directory' && right.kind === 'directory') return 1
  return left.relativePath.localeCompare(right.relativePath)
}

export function buildCommitTree(comparison: CommitComparison): CommitRootNode {
  const key = treeKey(comparison)
  const root: CommitRootNode = {
    ...emptyAggregate(),
    kind: 'root',
    id: `${key}\0root`,
    name: comparison.commit.subject,
    relativePath: '',
    parent: undefined,
    comparison,
    children: []
  }
  const directories = new Map<string, CommitDirectoryNode>()

  const ensureDirectory = (segments: string[]): CommitDirectoryNode | CommitRootNode => {
    if (!segments.length) return root
    const relativePath = segments.join('/')
    const existing = directories.get(relativePath)
    if (existing) return existing
    const parent = ensureDirectory(segments.slice(0, -1))
    const directory: CommitDirectoryNode = {
      ...emptyAggregate(),
      kind: 'directory',
      id: `${key}\0directory\0${relativePath}`,
      name: segments[segments.length - 1],
      relativePath,
      parent,
      children: []
    }
    directories.set(relativePath, directory)
    parent.children.push(directory)
    return directory
  }

  for (const change of comparison.changes) {
    const segments = change.path.split('/')
    const name = segments.pop()
    if (!name) throw new Error(`Invalid empty Git path in ${comparison.commit.shortSha}`)
    const parent = ensureDirectory(segments)
    const file: CommitFileNode = {
      kind: 'file',
      id: `${key}\0file\0${change.path}`,
      name,
      relativePath: change.path,
      parent,
      change,
      comparison
    }
    parent.children.push(file)
  }

  const aggregate = (node: CommitRootNode | CommitDirectoryNode): void => {
    const own = emptyAggregate()
    for (const child of node.children) {
      if (child.kind === 'file') addFileAggregate(own, child.change)
      else {
        aggregate(child)
        addAggregate(own, child)
      }
    }
    node.fileCount = own.fileCount
    node.additions = own.additions
    node.deletions = own.deletions
    node.binaryCount = own.binaryCount
    node.children.sort(compareNodes)
  }
  aggregate(root)
  return root
}

function escapeDisplay(value: string): string {
  return value.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t')
}

function countDescription(node: CommitTreeAggregate): string {
  const binary = node.binaryCount ? ` · ${node.binaryCount} binary` : ''
  return `${node.fileCount} file${node.fileCount === 1 ? '' : 's'} · +${node.additions} -${node.deletions}${binary}`
}

export function comparisonDescription(comparison: CommitComparison): string {
  const parent = comparison.baseSha
    ? `parent ${(comparison.parentIndex ?? 0) + 1}/${comparison.commit.parents.length}`
    : 'root'
  return `${comparison.commit.shortSha} · ${parent}`
}

function statusIcon(status: CommitChange['status']): TreeItemIcon {
  if (status === 'A') return { text: '+', hlGroup: 'DiffAdd' }
  if (status === 'M') return { text: '~', hlGroup: 'DiffChange' }
  if (status === 'D') return { text: '-', hlGroup: 'DiffDelete' }
  if (status === 'R') return { text: 'R', hlGroup: 'DiffChange' }
  if (status === 'C') return { text: 'C', hlGroup: 'DiffAdd' }
  return { text: status, hlGroup: 'WarningMsg' }
}

function fileDescription(change: CommitChange): string {
  const status = change.status === 'R' || change.status === 'C'
    ? `${change.status}${change.score ?? ''}`
    : change.status
  if (change.binary) return `${status} · binary`
  const stats = `+${change.additions ?? 0} -${change.deletions ?? 0}`
  if (change.oldPath) return `${status} · ${escapeDisplay(change.oldPath)} → ${escapeDisplay(change.path)} · ${stats}`
  return `${status} · ${stats}`
}

function fileTooltip(change: CommitChange): string {
  const current = `new path: ${escapeDisplay(change.path)}`
  const old = change.oldPath ? `\nold path: ${escapeDisplay(change.oldPath)}\nsimilarity: ${change.score ?? 0}%` : ''
  return `${current}${old}`
}

function nodeCommand(node: CommitTreeNode, title: string): Command {
  return {
    command: 'git.commitFiles.toggle',
    title,
    arguments: [node]
  }
}

export interface CommitTreeActions {
  showCommit(node: CommitRootNode): Promise<void>
  copyCommitHash(node: CommitRootNode): Promise<void>
  selectParent(node: CommitRootNode): Promise<void>
  copyDirectoryPath(node: CommitDirectoryNode): Promise<void>
  showCode(node: CommitFileNode): Promise<void>
  openVersion(node: CommitFileNode, before: boolean): Promise<void>
  openWorkingTree(node: CommitFileNode): Promise<void>
  copyRelativePath(node: CommitFileNode): Promise<void>
}

export class CommitFilesProvider implements TreeDataProvider<CommitTreeNode>, Disposable {
  private readonly emitter = new Emitter<CommitTreeNode | undefined>()
  private root: CommitRootNode
  public readonly onDidChangeTreeData = this.emitter.event

  constructor(
    comparison: CommitComparison,
    private readonly actions: CommitTreeActions
  ) {
    this.root = buildCommitTree(comparison)
  }

  public setComparison(comparison: CommitComparison): void {
    this.root = buildCommitTree(comparison)
    this.emitter.fire(undefined)
  }

  public get comparison(): CommitComparison {
    return this.root.comparison
  }

  public getTreeItem(element: CommitTreeNode): TreeItem {
    if (element.kind === 'root') {
      const item = new TreeItem(`${escapeDisplay(element.comparison.commit.shortSha)} ${escapeDisplay(element.name)}`, element.children.length ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.None)
      item.id = element.id
      item.description = countDescription(element)
      item.tooltip = `${element.comparison.commit.sha}\n${element.comparison.commit.author} · ${element.comparison.commit.authoredAt}`
      item.command = {
        command: 'git.commitFiles.invoke',
        title: 'Show commit',
        arguments: [element]
      }
      return item
    }
    if (element.kind === 'directory') {
      const item = new TreeItem(escapeDisplay(element.name), element.children.length ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None)
      item.id = element.id
      item.description = countDescription(element)
      item.tooltip = escapeDisplay(element.relativePath)
      item.command = nodeCommand(element, 'Toggle directory')
      return item
    }
    const item = new TreeItem(escapeDisplay(element.name), TreeItemCollapsibleState.None)
    item.id = element.id
    item.icon = statusIcon(element.change.status)
    item.description = fileDescription(element.change)
    item.tooltip = fileTooltip(element.change)
    item.command = {
      command: 'git.commitFiles.invoke',
      title: 'Show code',
      arguments: [element]
    } as Command
    return item
  }

  public getChildren(element?: CommitTreeNode): CommitTreeNode[] {
    if (!element) return [this.root]
    return element.kind === 'file' ? [] : element.children
  }

  public getParent(element: CommitTreeNode): CommitTreeNode | undefined {
    return element.parent
  }

  public findFile(relativePath: string): CommitFileNode | undefined {
    const pending: CommitTreeNode[] = [...this.root.children]
    while (pending.length) {
      const node = pending.pop()
      if (node.kind === 'file') {
        if (node.relativePath === relativePath) return node
      } else {
        pending.push(...node.children)
      }
    }
    return undefined
  }

  public resolveActions(_item: TreeItem, element: CommitTreeNode): TreeItemAction<CommitTreeNode>[] {
    if (element.kind === 'root') {
      const result: TreeItemAction<CommitTreeNode>[] = [
        { title: 'Show commit', handler: item => this.actions.showCommit(item as CommitRootNode) },
        { title: 'Copy commit hash', handler: item => this.actions.copyCommitHash(item as CommitRootNode) }
      ]
      if (element.comparison.commit.parents.length > 1) {
        result.push({ title: 'Select parent…', handler: item => this.actions.selectParent(item as CommitRootNode) })
      }
      return result
    }
    if (element.kind === 'directory') {
      return [{ title: 'Copy directory path', handler: item => this.actions.copyDirectoryPath(item as CommitDirectoryNode) }]
    }
    const result: TreeItemAction<CommitTreeNode>[] = [
      { title: 'Show code', handler: item => this.actions.showCode(item as CommitFileNode) }
    ]
    result.push(
      { title: 'Copy relative path', handler: item => this.actions.copyRelativePath(item as CommitFileNode) },
      { title: 'Open working tree file', handler: item => this.actions.openWorkingTree(item as CommitFileNode) }
    )
    if (element.change.status !== 'D') result.push({ title: 'Open after version', handler: item => this.actions.openVersion(item as CommitFileNode, false) })
    if (element.change.status !== 'A') result.push({ title: 'Open before version', handler: item => this.actions.openVersion(item as CommitFileNode, true) })
    return result
  }

  public dispose(): void {
    this.emitter.dispose()
  }
}

interface TreeEntry {
  mode: string
  type: string
  oid: string
  path: string
}

function parseTreeEntry(output: string): TreeEntry | undefined {
  if (!output) return undefined
  const end = output.indexOf('\0')
  const record = end < 0 ? output : output.slice(0, end)
  const tab = record.indexOf('\t')
  if (tab < 0) throw new Error('Invalid Git tree entry')
  const fields = record.slice(0, tab).split(' ')
  if (fields.length !== 3 || !fields[0] || !fields[1] || !fields[2]) throw new Error('Invalid Git tree entry')
  return { mode: fields[0], type: fields[1], oid: fields[2], path: record.slice(tab + 1) }
}

async function showScratch(nvim: Neovim, targetWinId: number, name: string, lines: string[], filetype: 'git' | 'detect' = 'git', line = 1): Promise<void> {
  const moved = await nvim.call('win_gotoid', [targetWinId]) as number
  if (!moved) await nvim.command('new')
  else await nvim.command('enew')
  const escapedName = await nvim.call('fnameescape', [name]) as string
  const content = lines.length ? lines : ['']
  nvim.pauseNotification()
  nvim.command('setlocal buftype=nofile bufhidden=wipe noswapfile nobuflisted modifiable', true)
  nvim.call('setline', [1, content], true)
  nvim.command(`file ${escapedName}`, true)
  if (filetype === 'git') nvim.command('setlocal filetype=git', true)
  else nvim.command('filetype detect', true)
  nvim.command('setlocal nomodifiable readonly', true)
  nvim.call('cursor', [Math.max(1, Math.min(line, content.length)), 1], true)
  await nvim.resumeNotification()
}

export default class CommitFilesController implements Disposable {
  private session?: {
    root: string
    comparison: CommitComparison
    provider: CommitFilesProvider
    view: TreeView<CommitTreeNode>
    targetWinId: number
    token?: CancellationTokenSource
    cache: Map<string, CommitComparison>
  }

  constructor(private readonly manager: Manager) {
  }

  public async invoke(node: unknown): Promise<void> {
    if (!node || typeof node !== 'object') return
    const element = node as CommitTreeNode
    if (element.kind === 'root') await this.showCommit(element)
    else if (element.kind === 'file') await this.showCode(element)
  }

  public async toggle(node: unknown): Promise<void> {
    if (!node || typeof node !== 'object') return
    const element = node as CommitTreeNode
    if (element.kind !== 'root' && element.kind !== 'directory') return
    const configuredKey = workspace.getConfiguration('tree').get<string>('key.toggle', 't')
    await feedTreeToggleKey(workspace.nvim, configuredKey)
  }

  public async open(revision?: string, requestedRoot?: string, options: CommitFilesOpenOptions = {}): Promise<void> {
    const value = revision === undefined ? await window.requestInput('Git commit revision', 'HEAD') : revision
    if (!value || !value.trim()) return
    let root = requestedRoot
    if (!root) root = await this.manager.resolveGitRootFromBufferOrCwd(await workspace.nvim.call('bufnr', ['%']) as number)
    if (!root) {
      window.showWarningMessage("Can't resolve git repository for current buffer or cwd.")
      return
    }
    try {
      root = await this.manager.git.getRepositoryRoot(root)
    } catch (_e) {
      window.showWarningMessage("Can't resolve git repository for current buffer or cwd.")
      return
    }
    let commit
    try {
      commit = await resolveCommit(this.manager.git, root, value.trim())
    } catch (_e) {
      window.showErrorMessage(`Invalid Git commit: ${value.trim()}`)
      return
    }
    let comparison: CommitComparison
    try {
      comparison = await loadComparisonForCommit(this.manager.git, root, commit)
    } catch (e) {
      window.showErrorMessage(`Failed to load commit ${commit.shortSha}: ${e.message}`)
      return
    }
    const targetWinId = await workspace.nvim.call('win_getid') as number
    const targetBufnr = await workspace.nvim.call('bufnr', ['%']) as number
    this.disposeSession()
    const provider = new CommitFilesProvider(comparison, this.actions)
    const view = window.createTreeView<CommitTreeNode>('git.commitFiles', {
      treeDataProvider: provider,
      enableFilter: true,
      winfixwidth: true,
      bufhidden: 'wipe',
      canSelectMany: false,
      autoWidth: true
    } as Parameters<typeof window.createTreeView<CommitTreeNode>>[1] & { autoWidth: boolean })
    view.title = 'Commit Files'
    view.description = comparisonDescription(comparison)
    this.session = { root, comparison, provider, view, targetWinId, cache: new Map([[comparison.baseSha ?? 'root', comparison]]) }
    try {
      await view.show(workspace.getConfiguration('git').get<string>('commitFiles.splitCommand', 'belowright 40vs'))
      const currentFile = this.currentFileNode(provider, root, targetBufnr)
      if (currentFile) {
        await view.reveal(currentFile, { focus: true })
        if (options.showCurrentFile) await this.showCode(currentFile, options.line)
      }
      view.onDidChangeVisibility(event => {
        if (!event.visible && this.session?.view === view) this.disposeSession()
      })
    } catch (e) {
      this.disposeSession()
      window.showErrorMessage(`Failed to open Commit Files: ${e.message}`)
    }
  }

  private get actions(): CommitTreeActions {
    return {
      showCommit: node => this.showCommit(node),
      copyCommitHash: node => this.copy(node.comparison.commit.sha),
      selectParent: node => this.selectParent(node),
      copyDirectoryPath: node => this.copy(node.relativePath),
      showCode: node => this.showCode(node),
      openVersion: (node, before) => this.openVersion(node, before),
      openWorkingTree: node => this.openWorkingTree(node),
      copyRelativePath: node => this.copy(node.change.oldPath && node.change.status === 'D' ? node.change.oldPath : node.change.path)
    }
  }

  private currentFileNode(provider: CommitFilesProvider, root: string, bufnr: number): CommitFileNode | undefined {
    const buffer = this.manager.getBuffer(bufnr)
    if (!buffer) return undefined
    const absolute = path.resolve(buffer.repo.root, buffer.relpath)
    const relative = path.relative(root, absolute)
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined
    return provider.findFile(relative.split(path.sep).join('/'))
  }

  private async copy(value: string): Promise<void> {
    await workspace.nvim.call('setreg', ['+', value])
  }

  private async showCommit(node: CommitRootNode): Promise<void> {
    const session = this.session
    if (!session) return
    try {
      const content = await this.manager.git.exec(session.root, ['--no-pager', 'show', '--no-ext-diff', '--no-color', node.comparison.commit.sha])
      await showScratch(workspace.nvim, session.targetWinId, `[commit ${node.comparison.commit.shortSha}]`, content.stdout.replace(/\r?\n$/, '').split(/\r?\n/))
    } catch (e) {
      window.showErrorMessage(`Failed to show commit ${node.comparison.commit.shortSha}: ${e.message}`)
    }
  }

  private async showCode(node: CommitFileNode, line?: number): Promise<void> {
    const session = this.session
    if (!session) return
    if (node.change.status === 'D') {
      await this.openVersion(node, true, line)
      return
    }
    if (node.change.binary) {
      await this.openVersion(node, false)
      return
    }
    try {
      await commands.executeCommand('git.commitFiles.openDocument', session.root, node.comparison, node.change, session.targetWinId, line)
    } catch (e) {
      window.showErrorMessage(`Failed to show code for ${node.comparison.commit.shortSha}: ${e.message}`)
    }
  }

  private async openVersion(node: CommitFileNode, before: boolean, line?: number): Promise<void> {
    const session = this.session
    if (!session) return
    const comparison = node.comparison
    const revision = before ? comparison.baseSha : comparison.commit.sha
    const relativePath = before ? (node.change.oldPath ?? node.change.path) : node.change.path
    if (!revision) return
    try {
      const entry = parseTreeEntry((await this.manager.git.exec(session.root, ['ls-tree', '-z', revision, '--', relativePath])).stdout)
      if (!entry) {
        window.showWarningMessage(`Git path not found: ${escapeDisplay(relativePath)}`)
        return
      }
      if (node.change.binary || entry.type !== 'blob') {
        const size = entry.type === 'blob' ? (await this.manager.git.exec(session.root, ['cat-file', '-s', entry.oid])).stdout.trim() : 'n/a'
        await showScratch(workspace.nvim, session.targetWinId, `[version ${comparison.commit.shortSha} ${relativePath}]`, [
          `revision: ${revision}`,
          `path: ${escapeDisplay(relativePath)}`,
          `mode: ${entry.mode}`,
          `type: ${entry.type}`,
          `object: ${entry.oid}`,
          `size: ${size}`
        ])
        return
      }
      const content = await this.manager.git.exec(session.root, ['cat-file', '-p', entry.oid])
      await showScratch(workspace.nvim, session.targetWinId, `[version ${comparison.commit.shortSha} ${relativePath}]`, content.stdout.replace(/\r?\n$/, '').split(/\r?\n/), 'detect', line)
    } catch (e) {
      window.showErrorMessage(`Failed to open version for ${comparison.commit.shortSha}: ${e.message}`)
    }
  }

  private async openWorkingTree(node: CommitFileNode): Promise<void> {
    const session = this.session
    if (!session) return
    const relativePath = node.change.status === 'D' && node.change.oldPath ? node.change.oldPath : node.change.path
    const absolute = path.resolve(session.root, ...relativePath.split('/'))
    const relative = path.relative(session.root, absolute)
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      window.showWarningMessage(`Working tree path is outside repository: ${escapeDisplay(relativePath)}`)
      return
    }
    let stat: fs.Stats
    try {
      stat = await fs.promises.stat(absolute)
    } catch (_e) {
      window.showWarningMessage(`Working tree file not found: ${escapeDisplay(relativePath)}`)
      return
    }
    if (!stat.isFile()) {
      window.showWarningMessage(`Working tree path is not a file: ${escapeDisplay(relativePath)}`)
      return
    }
    const moved = await workspace.nvim.call('win_gotoid', [session.targetWinId]) as number
    if (!moved) await workspace.nvim.command('new')
    try {
      await workspace.openResource(Uri.file(absolute).toString())
    } catch (e) {
      window.showErrorMessage(`Failed to open working tree file for ${node.comparison.commit.shortSha}: ${e.message}`)
    }
  }

  private async selectParent(node: CommitRootNode): Promise<void> {
    const session = this.session
    if (!session || node.comparison.commit.parents.length < 2) return
    const choices = node.comparison.commit.parents.map((sha, index) => `${index + 1}/${node.comparison.commit.parents.length} ${sha.slice(0, 12)}`)
    const selected = await window.showQuickPick(choices, { placeHolder: 'Select parent commit' })
    if (!selected) return
    const parentIndex = choices.indexOf(selected)
    if (parentIndex < 0) return
    const parentSha = node.comparison.commit.parents[parentIndex]
    session.token?.cancel()
    session.token?.dispose()
    const token = new CancellationTokenSource()
    session.token = token
    try {
      await assertParentAvailable(this.manager.git, session.root, parentSha, token.token)
    } catch (e) {
      if (!token.token.isCancellationRequested) {
        window.showErrorMessage(`Parent commit is not available in this shallow repository: ${parentSha.slice(0, 12)}`)
      }
      token.dispose()
      if (session.token === token) session.token = undefined
      return
    }
    try {
      const key = parentSha
      let comparison = session.cache.get(key)
      if (!comparison) {
        comparison = await loadComparisonForCommit(this.manager.git, session.root, node.comparison.commit, parentIndex, token.token)
        session.cache.set(key, comparison)
      }
      if (token.token.isCancellationRequested || this.session !== session) return
      session.comparison = comparison
      session.provider.setComparison(comparison)
      session.view.description = comparisonDescription(comparison)
    } catch (e) {
      if (!token.token.isCancellationRequested) {
        const message = e?.message ?? ''
        window.showErrorMessage(`Failed to load parent ${parentSha.slice(0, 12)} for ${node.comparison.commit.shortSha}: ${message}`)
      }
    } finally {
      token.dispose()
      if (session.token === token) session.token = undefined
    }
  }

  private disposeSession(): void {
    const session = this.session
    if (!session) return
    this.session = undefined
    session.token?.cancel()
    session.token?.dispose()
    session.provider.dispose()
    session.view.dispose()
  }

  public dispose(): void {
    this.disposeSession()
  }
}
