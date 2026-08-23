import fs from 'fs'
import path from 'path'
import { Command, Disposable, Emitter, Position, TreeDataProvider, TreeItem, TreeItemAction, TreeItemCollapsibleState, TreeItemIcon, TreeView, Uri, window, workspace } from 'coc.nvim'
import Manager from '../manager'
import CommitDocumentProvider from '../model/commitDocument'
import { StatusEntry, parseStatusEntries } from '../model/statusEntry'
import { DiffCategory } from '../types'
import { feedTreeToggleKey } from '../util'

interface StatusAggregate {
  fileCount: number
  stagedCount: number
  unstagedCount: number
  untrackedCount: number
  conflictCount: number
}

export interface StatusRootNode extends StatusAggregate {
  kind: 'root'
  id: string
  name: string
  relativePath: ''
  parent: undefined
  root: string
  children: Array<StatusDirectoryNode | StatusFileNode>
}

export interface StatusDirectoryNode extends StatusAggregate {
  kind: 'directory'
  id: string
  name: string
  relativePath: string
  parent: StatusRootNode | StatusDirectoryNode
  children: Array<StatusDirectoryNode | StatusFileNode>
}

export interface StatusFileNode {
  kind: 'file'
  id: string
  name: string
  relativePath: string
  parent: StatusRootNode | StatusDirectoryNode
  entry: StatusEntry
}

export type StatusTreeNode = StatusRootNode | StatusDirectoryNode | StatusFileNode

function emptyAggregate(): StatusAggregate {
  return { fileCount: 0, stagedCount: 0, unstagedCount: 0, untrackedCount: 0, conflictCount: 0 }
}

function isUntracked(entry: StatusEntry): boolean {
  return entry.index === '?' && entry.tree === '?'
}

function isConflict(entry: StatusEntry): boolean {
  return entry.index === 'U' || entry.tree === 'U' || entry.index + entry.tree === 'AA' || entry.index + entry.tree === 'DD'
}

function isStaged(entry: StatusEntry): boolean {
  return entry.index !== ' ' && entry.index !== '?' && entry.index !== '!'
}

function isUnstaged(entry: StatusEntry): boolean {
  return entry.tree !== ' ' && entry.tree !== '?' && entry.tree !== '!'
}

function addFileAggregate(target: StatusAggregate, entry: StatusEntry): void {
  target.fileCount++
  if (isStaged(entry)) target.stagedCount++
  if (isUnstaged(entry)) target.unstagedCount++
  if (isUntracked(entry)) target.untrackedCount++
  if (isConflict(entry)) target.conflictCount++
}

function addAggregate(target: StatusAggregate, source: StatusAggregate): void {
  target.fileCount += source.fileCount
  target.stagedCount += source.stagedCount
  target.unstagedCount += source.unstagedCount
  target.untrackedCount += source.untrackedCount
  target.conflictCount += source.conflictCount
}

function compareNodes(left: StatusTreeNode, right: StatusTreeNode): number {
  if (left.kind === 'directory' && right.kind !== 'directory') return -1
  if (left.kind !== 'directory' && right.kind === 'directory') return 1
  return left.relativePath.localeCompare(right.relativePath)
}

export function buildStatusTree(rootPath: string, entries: readonly StatusEntry[]): StatusRootNode {
  const root: StatusRootNode = {
    ...emptyAggregate(),
    kind: 'root',
    id: `${rootPath}\0root`,
    name: path.basename(rootPath) || rootPath,
    relativePath: '',
    parent: undefined,
    root: rootPath,
    children: []
  }
  const directories = new Map<string, StatusDirectoryNode>()
  const ensureDirectory = (segments: string[]): StatusRootNode | StatusDirectoryNode => {
    if (!segments.length) return root
    const relativePath = segments.join('/')
    const existing = directories.get(relativePath)
    if (existing) return existing
    const parent = ensureDirectory(segments.slice(0, -1))
    const directory: StatusDirectoryNode = {
      ...emptyAggregate(),
      kind: 'directory',
      id: `${rootPath}\0directory\0${relativePath}`,
      name: segments[segments.length - 1],
      relativePath,
      parent,
      children: []
    }
    directories.set(relativePath, directory)
    parent.children.push(directory)
    return directory
  }

  for (const entry of entries) {
    const segments = entry.relative.split('/')
    const name = segments.pop()
    if (!name) continue
    const parent = ensureDirectory(segments)
    parent.children.push({
      kind: 'file',
      id: `${rootPath}\0file\0${entry.relative}`,
      name,
      relativePath: entry.relative,
      parent,
      entry
    })
  }

  const aggregate = (node: StatusRootNode | StatusDirectoryNode): void => {
    const own = emptyAggregate()
    for (const child of node.children) {
      if (child.kind === 'file') addFileAggregate(own, child.entry)
      else {
        aggregate(child)
        addAggregate(own, child)
      }
    }
    Object.assign(node, own)
    node.children.sort(compareNodes)
  }
  aggregate(root)
  return root
}

function firstFile(node: StatusRootNode | StatusDirectoryNode): StatusFileNode | undefined {
  for (const child of node.children) {
    if (child.kind === 'file') return child
    const file = firstFile(child)
    if (file) return file
  }
  return undefined
}

function escapeDisplay(value: string): string {
  return value.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t')
}

const STATUS_NAMES: Record<string, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  T: 'Type changed',
  U: 'Unmerged'
}

function aggregateDescription(value: StatusAggregate): string {
  const parts = [`${value.fileCount} file${value.fileCount === 1 ? '' : 's'}`]
  if (value.stagedCount) parts.push(`${value.stagedCount} staged`)
  if (value.unstagedCount) parts.push(`${value.unstagedCount} unstaged`)
  if (value.untrackedCount) parts.push(`${value.untrackedCount} untracked`)
  if (value.conflictCount) parts.push(`${value.conflictCount} conflicted`)
  return parts.join(' · ')
}

function fileDescription(entry: StatusEntry): string {
  const code = `[${entry.index}${entry.tree}]`
  if (isUntracked(entry)) return `${code} · Untracked`
  if (entry.index === '!' && entry.tree === '!') return `${code} · Ignored`
  const parts = [code]
  if (isStaged(entry)) parts.push(`staged: ${STATUS_NAMES[entry.index] ?? entry.index}`)
  if (isUnstaged(entry)) parts.push(`unstaged: ${STATUS_NAMES[entry.tree] ?? entry.tree}`)
  if (isConflict(entry) && !parts.some(part => part.includes('Unmerged'))) parts.push('conflicted')
  return parts.join(' · ')
}

function statusIcon(entry: StatusEntry): TreeItemIcon {
  if (isConflict(entry)) return { text: '!', hlGroup: 'Error' }
  if (isUntracked(entry)) return { text: '?', hlGroup: 'Comment' }
  const status = entry.tree !== ' ' ? entry.tree : entry.index
  if (status === 'A' || status === 'C') return { text: '+', hlGroup: 'DiffAdd' }
  if (status === 'D') return { text: '-', hlGroup: 'DiffDelete' }
  if (status === 'R') return { text: 'R', hlGroup: 'DiffChange' }
  return { text: '~', hlGroup: 'DiffChange' }
}

function toggleCommand(node: StatusRootNode | StatusDirectoryNode): Command {
  return { command: 'git.statusFiles.toggle', title: 'Toggle directory', arguments: [node] }
}

interface StatusTreeActions {
  refresh(): Promise<void>
  openFile(node: StatusFileNode): Promise<void>
  addFile(node: StatusFileNode): Promise<void>
  restoreStagedFile(node: StatusFileNode): Promise<void>
  restoreWorkingTreeFile(node: StatusFileNode): Promise<void>
  copyPath(node: StatusDirectoryNode | StatusFileNode): Promise<void>
}

export class StatusFilesProvider implements TreeDataProvider<StatusTreeNode>, Disposable {
  private readonly emitter = new Emitter<StatusTreeNode | undefined>()
  private root: StatusRootNode
  public readonly onDidChangeTreeData = this.emitter.event

  constructor(rootPath: string, entries: readonly StatusEntry[], private readonly actions: StatusTreeActions) {
    this.root = buildStatusTree(rootPath, entries)
  }

  public setEntries(entries: readonly StatusEntry[]): void {
    this.root = buildStatusTree(this.root.root, entries)
    this.emitter.fire(undefined)
  }

  public getTreeItem(element: StatusTreeNode): TreeItem {
    if (element.kind === 'root') {
      const item = new TreeItem(escapeDisplay(element.name), element.children.length ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.None)
      item.id = element.id
      item.description = aggregateDescription(element)
      item.tooltip = escapeDisplay(element.root)
      item.command = { command: 'git.statusFiles.refresh', title: 'Refresh Git status' }
      return item
    }
    if (element.kind === 'directory') {
      const item = new TreeItem(escapeDisplay(element.name), element.children.length ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.None)
      item.id = element.id
      item.description = aggregateDescription(element)
      item.tooltip = escapeDisplay(element.relativePath)
      item.command = toggleCommand(element)
      return item
    }
    const item = new TreeItem(escapeDisplay(element.name), TreeItemCollapsibleState.None)
    item.id = element.id
    item.icon = statusIcon(element.entry)
    item.description = fileDescription(element.entry)
    item.tooltip = `${escapeDisplay(element.relativePath)}\n${fileDescription(element.entry)}`
    item.command = { command: 'git.statusFiles.open', title: 'Open file', arguments: [element] }
    return item
  }

  public getChildren(element?: StatusTreeNode): StatusTreeNode[] {
    if (!element) return [this.root]
    return element.kind === 'file' ? [] : element.children
  }

  public getParent(element: StatusTreeNode): StatusRootNode | StatusDirectoryNode | undefined {
    return element.parent
  }

  public resolveActions(_item: TreeItem, element: StatusTreeNode): TreeItemAction<StatusTreeNode>[] {
    if (element.kind === 'root') return [{ title: 'Refresh', handler: () => this.actions.refresh() }]
    if (element.kind === 'directory') return [{ title: 'Copy directory path', handler: node => this.actions.copyPath(node as StatusDirectoryNode) }]
    const actions: TreeItemAction<StatusTreeNode>[] = [
      { title: 'Open file', handler: node => this.actions.openFile(node as StatusFileNode) },
      { title: 'Copy relative path', handler: node => this.actions.copyPath(node as StatusFileNode) }
    ]
    const entry = element.entry
    if (isUntracked(entry) || isUnstaged(entry)) actions.push({ title: 'Add', handler: node => this.actions.addFile(node as StatusFileNode) })
    if (isStaged(entry)) actions.push({ title: 'Restore staged changes', handler: node => this.actions.restoreStagedFile(node as StatusFileNode) })
    if (isUnstaged(entry) && !isUntracked(entry) && !isConflict(entry)) {
      actions.push({ title: 'Restore working tree changes', handler: node => this.actions.restoreWorkingTreeFile(node as StatusFileNode) })
    }
    return actions
  }

  public dispose(): void {
    this.emitter.dispose()
  }
}

export default class StatusFilesController implements Disposable {
  private session?: {
    root: string
    provider: StatusFilesProvider
    view: TreeView<StatusTreeNode>
    targetWinId: number
  }

  constructor(private readonly manager: Manager, private readonly commitDocuments: CommitDocumentProvider) {
  }

  public async open(requestedRoot?: string): Promise<void> {
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
    const targetWinId = await workspace.nvim.call('win_getid') as number
    this.disposeSession()
    try {
      const entries = await this.loadEntries(root)
      const provider = new StatusFilesProvider(root, entries, this.actions)
      const view = window.createTreeView<StatusTreeNode>('git.statusFiles', {
        treeDataProvider: provider,
        enableFilter: true,
        winfixwidth: true,
        bufhidden: 'wipe',
        canSelectMany: false,
        autoWidth: true
      } as Parameters<typeof window.createTreeView<StatusTreeNode>>[1] & { autoWidth: boolean })
      view.title = 'Git Status'
      view.description = aggregateDescription(buildStatusTree(root, entries))
      this.session = { root, provider, view, targetWinId }
      await view.show(workspace.getConfiguration('git').get<string>('statusTree.splitCommand', 'belowright 40vs'))
      const file = firstFile(provider.getChildren()[0] as StatusRootNode)
      if (file) await view.reveal(file, { select: true, focus: true, expand: true })
      view.onDidChangeVisibility(event => {
        if (!event.visible && this.session?.view === view) this.disposeSession()
      })
    } catch (e) {
      this.disposeSession()
      window.showErrorMessage(`Failed to open Git Status: ${e.message}`)
    }
  }

  public async toggle(node: unknown): Promise<void> {
    if (!node || typeof node !== 'object') return
    const element = node as StatusTreeNode
    if (element.kind !== 'root' && element.kind !== 'directory') return
    const configuredKey = workspace.getConfiguration('tree').get<string>('key.toggle', 't')
    await feedTreeToggleKey(workspace.nvim, configuredKey)
  }

  public async refresh(): Promise<void> {
    const session = this.session
    if (!session) return
    try {
      const entries = await this.loadEntries(session.root)
      if (this.session !== session) return
      session.provider.setEntries(entries)
      session.view.description = aggregateDescription(buildStatusTree(session.root, entries))
    } catch (e) {
      window.showErrorMessage(`Failed to refresh Git Status: ${e.message}`)
    }
  }

  public close(): void {
    this.disposeSession()
  }

  public async openFile(node: StatusFileNode): Promise<void> {
    const session = this.session
    if (!session) return
    const absolute = path.resolve(session.root, ...node.relativePath.split('/'))
    const relative = path.relative(session.root, absolute)
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      window.showWarningMessage(`Working tree path is outside repository: ${escapeDisplay(node.relativePath)}`)
      return
    }
    let stat: fs.Stats
    try {
      stat = await fs.promises.stat(absolute)
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        window.showErrorMessage(`Failed to inspect working tree path: ${escapeDisplay(node.relativePath)}`)
        return
      }
      try {
        await this.commitDocuments.openRevision(session.root, 'HEAD', node.relativePath, session.targetWinId)
      } catch (_error) {
        window.showWarningMessage(`File not found in working tree or HEAD: ${escapeDisplay(node.relativePath)}`)
      }
      return
    }
    if (!stat.isFile()) {
      window.showWarningMessage(`Working tree path is not a file: ${escapeDisplay(node.relativePath)}`)
      return
    }
    let line = 1
    try {
      const groups = await this.manager.getDiffAllForRoot(session.root, DiffCategory.All)
      line = Math.max(1, groups.get(node.relativePath)?.[0]?.start ?? 1)
    } catch (_e) {
      // Opening the file is still useful when Git cannot provide a diff position.
    }
    const moved = await workspace.nvim.call('win_gotoid', [session.targetWinId]) as number
    if (!moved) await workspace.nvim.command('new')
    try {
      await workspace.jumpTo(Uri.file(absolute), Position.create(line - 1, 0))
    } catch (e) {
      window.showErrorMessage(`Failed to open working tree file: ${e.message}`)
    }
  }

  public async addFile(node: StatusFileNode): Promise<void> {
    await this.updateFile(node, ['add', '--', node.relativePath])
  }

  public async restoreStagedFile(node: StatusFileNode): Promise<void> {
    await this.updateFile(node, ['reset', '--', node.relativePath])
  }

  public async restoreWorkingTreeFile(node: StatusFileNode): Promise<void> {
    await this.updateFile(node, ['checkout', '--', node.relativePath])
  }

  private get actions(): StatusTreeActions {
    return {
      refresh: () => this.refresh(),
      openFile: node => this.openFile(node),
      addFile: node => this.addFile(node),
      restoreStagedFile: node => this.restoreStagedFile(node),
      restoreWorkingTreeFile: node => this.restoreWorkingTreeFile(node),
      copyPath: node => workspace.nvim.call('setreg', ['+', node.relativePath]).then(() => undefined)
    }
  }

  private async updateFile(node: StatusFileNode, args: string[]): Promise<void> {
    const session = this.session
    if (!session) return
    try {
      await this.manager.git.exec(session.root, args)
      await this.refresh()
    } catch (e) {
      window.showErrorMessage(`Failed to update Git status for ${escapeDisplay(node.relativePath)}: ${e.message}`)
    }
  }

  private async loadEntries(root: string): Promise<StatusEntry[]> {
    const result = await this.manager.git.exec(root, ['status', '--porcelain=v1', '-z', '-uall'])
    return parseStatusEntries(result.stdout)
  }

  private disposeSession(): void {
    const session = this.session
    if (!session) return
    this.session = undefined
    session.provider.dispose()
    session.view.dispose()
  }

  public dispose(): void {
    this.close()
  }
}
