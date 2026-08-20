import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TreeItemCollapsibleState } from 'coc.nvim'
import { buildStatusTree, StatusFilesProvider } from '../src/tree/statusFiles'

describe('Git status tree', () => {
  it('groups files by directory and aggregates staged, unstaged and conflict states', () => {
    const root = buildStatusTree('/repo', [
      { index: 'A', tree: ' ', relative: 'src/added.ts' },
      { index: ' ', tree: 'M', relative: 'src/nested/changed.ts' },
      { index: 'M', tree: 'M', relative: 'mixed.ts' },
      { index: '?', tree: '?', relative: 'new.txt' },
      { index: 'U', tree: 'U', relative: 'conflict.txt' }
    ])
    assert.deepEqual(JSON.parse(JSON.stringify(root.children.map(node => node.relativePath))), ['src', 'conflict.txt', 'mixed.ts', 'new.txt'])
    assert.deepEqual({
      files: root.fileCount,
      staged: root.stagedCount,
      unstaged: root.unstagedCount,
      untracked: root.untrackedCount,
      conflicts: root.conflictCount
    }, { files: 5, staged: 3, unstaged: 3, untracked: 1, conflicts: 1 })
    const src = root.children[0]
    assert.equal(src.kind, 'directory')
    assert.deepEqual(JSON.parse(JSON.stringify(src.children.map(node => node.relativePath))), ['src/nested', 'src/added.ts'])
    const provider = new StatusFilesProvider('/repo', [
      { index: 'A', tree: ' ', relative: 'src/added.ts' },
      { index: ' ', tree: 'M', relative: 'src/nested/changed.ts' }
    ], {
      refresh: async () => undefined,
      openFile: async () => undefined,
      addFile: async () => undefined,
      restoreStagedFile: async () => undefined,
      restoreWorkingTreeFile: async () => undefined,
      copyPath: async () => undefined
    })
    const treeRoot = provider.getChildren()[0]
    const directory = provider.getChildren(treeRoot).find(node => node.kind === 'directory')
    assert.ok(directory && directory.kind === 'directory')
    assert.equal(provider.getTreeItem(treeRoot).collapsibleState, TreeItemCollapsibleState.Expanded)
    assert.equal(provider.getTreeItem(directory).collapsibleState, TreeItemCollapsibleState.Expanded)
    provider.dispose()
  })

  it('shows the two-column Git status and opens files by default', () => {
    const noop = async (): Promise<void> => undefined
    const provider = new StatusFilesProvider('/repo', [
      { index: 'M', tree: 'M', relative: 'mixed.ts' },
      { index: '?', tree: '?', relative: 'new.txt' }
    ], { refresh: noop, openFile: noop, addFile: noop, restoreStagedFile: noop, restoreWorkingTreeFile: noop, copyPath: noop })
    const root = provider.getChildren()[0]
    const files = provider.getChildren(root)
    const mixed = files.find(node => node.kind === 'file' && node.relativePath === 'mixed.ts')
    const untracked = files.find(node => node.kind === 'file' && node.relativePath === 'new.txt')
    assert.ok(mixed && mixed.kind === 'file')
    assert.ok(untracked && untracked.kind === 'file')
    const mixedItem = provider.getTreeItem(mixed)
    assert.equal(mixedItem.description, '[MM] · staged: Modified · unstaged: Modified')
    assert.equal(mixedItem.command?.command, 'git.statusFiles.open')
    assert.equal(mixedItem.command?.title, 'Open file')
    const untrackedItem = provider.getTreeItem(untracked)
    assert.equal(untrackedItem.description, '[??] · Untracked')
    assert.deepEqual(JSON.parse(JSON.stringify(provider.resolveActions(mixedItem, mixed).map(action => action.title))), ['Open file', 'Copy relative path', 'Add', 'Restore staged changes', 'Restore working tree changes'])
    assert.deepEqual(JSON.parse(JSON.stringify(provider.resolveActions(untrackedItem, untracked).map(action => action.title))), ['Open file', 'Copy relative path', 'Add'])
    provider.dispose()
  })
})
