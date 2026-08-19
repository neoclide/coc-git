import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { CommitComparison, loadCommitComparison, mergeChanges, parseNameStatus, parseNumstat } from '../src/model/commit'
import { parseCommitDocumentPatch } from '../src/model/commitDocument'
import { Git } from '../src/model/git'
import { buildCommitTree, CommitFilesProvider } from '../src/tree/commitFiles'

const tempDirs: string[] = []
const channel = { append: () => undefined, appendLine: () => undefined } as any

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function createRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coc-git-commit-'))
  tempDirs.push(dir)
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'test')
  return dir
}

function commitAll(dir: string, message: string): string {
  git(dir, 'add', '--all')
  git(dir, 'commit', '-q', '-m', message)
  return git(dir, 'rev-parse', 'HEAD').trim()
}

describe('commit output parsers', () => {
  it('parses added, replaced and deleted commit document hunks', () => {
    const hunks = parseCommitDocumentPatch([
      'diff --git a/file.ts b/file.ts',
      '@@ -2,2 +2,2 @@',
      '-old two',
      '-old three',
      '+new two',
      '+new three',
      '@@ -8,0 +9,2 @@',
      '+new nine',
      '+new ten',
      '@@ -15,2 +16,0 @@',
      '-removed sixteen',
      '-removed seventeen'
    ].join('\n'))
    assert.deepEqual(JSON.parse(JSON.stringify(hunks)), [
      { start: 2, end: 3, addedStart: 2, addedCount: 2, deleted: ['old two', 'old three'], deletedLine: 1, deletedAlign: 'above' },
      { start: 9, end: 10, addedStart: 9, addedCount: 2, deleted: [], deletedLine: 8, deletedAlign: 'above' },
      { start: 16, end: 16, addedStart: 16, addedCount: 0, deleted: ['removed sixteen', 'removed seventeen'], deletedLine: 15, deletedAlign: 'below' }
    ])
  })

  it('parses status records without losing special paths', () => {
    const output = [
      'A', 'space name.txt',
      'M', 'tab\tname\n中文.txt',
      'R92', 'old\tname.txt', 'new\nname.txt',
      'C100', 'copy source.txt', 'copy target.txt'
    ].join('\0') + '\0'
    assert.deepEqual(JSON.parse(JSON.stringify(parseNameStatus(output))), [
      { status: 'A', path: 'space name.txt' },
      { status: 'M', path: 'tab\tname\n中文.txt' },
      { status: 'R', score: 92, oldPath: 'old\tname.txt', path: 'new\nname.txt' },
      { status: 'C', score: 100, oldPath: 'copy source.txt', path: 'copy target.txt' }
    ])
  })

  it('parses text, binary and rename numstat records', () => {
    const output = [
      '12\t3\tspace\tname.txt',
      '-\t-\tbinary.dat',
      '2\t1\t', 'old\tname.txt', 'new\tname.txt'
    ].join('\0') + '\0'
    assert.deepEqual(JSON.parse(JSON.stringify(parseNumstat(output))), [
      { path: 'space\tname.txt', additions: 12, deletions: 3, binary: false },
      { path: 'binary.dat', binary: true },
      { oldPath: 'old\tname.txt', path: 'new\tname.txt', additions: 2, deletions: 1, binary: false }
    ])
  })

  it('rejects malformed or mismatched machine-readable output', () => {
    assert.throws(() => parseNameStatus('Rbad\0old\0new\0'), /Invalid Git name-status output/)
    assert.throws(() => parseNameStatus('R\0old\0new\0'), /missing similarity score/)
    assert.throws(() => parseNumstat('1\t-\tpath\0'), /Invalid Git numstat output/)
    assert.throws(() => mergeChanges('A\0one\0', '1\t0\ttwo\0'), /without name-status/)
    assert.throws(() => mergeChanges('A\0one\0A\0one\0', '1\t0\tone\0'), /duplicate status key/)
  })
})

describe('commit tree builder', () => {
  it('sorts directories first and aggregates text and binary changes', () => {
    const comparison: CommitComparison = {
      commit: { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', parents: [], author: 'test', authoredAt: '', subject: 'subject' },
      changes: [
        { status: 'M', path: 'z.txt', additions: 1, deletions: 2, binary: false },
        { status: 'A', path: 'src/a.txt', additions: 3, deletions: 0, binary: false },
        { status: 'A', path: 'src/data.bin', binary: true },
        { status: 'D', path: 'old\nname.txt', additions: 0, deletions: 4, binary: false }
      ]
    }
    const root = buildCommitTree(comparison)
    assert.deepEqual(JSON.parse(JSON.stringify(root.children.map(node => node.relativePath))), ['src', 'old\nname.txt', 'z.txt'])
    const src = root.children[0]
    assert.equal(src.kind, 'directory')
    assert.equal(src.fileCount, 2)
    assert.equal(src.additions, 3)
    assert.equal(src.binaryCount, 1)
    assert.equal(root.fileCount, 4)
    assert.equal(root.additions, 4)
    assert.equal(root.deletions, 6)
  })

  it('uses Show code as the file default and primary action', () => {
    const comparison: CommitComparison = {
      commit: { sha: 'b'.repeat(40), shortSha: 'bbbbbbb', parents: [], author: 'test', authoredAt: '', subject: 'subject' },
      changes: [
        { status: 'A', path: 'src/file.ts', additions: 1, deletions: 0, binary: false },
        { status: 'D', path: 'removed.ts', additions: 0, deletions: 1, binary: false }
      ]
    }
    const noop = async (): Promise<void> => undefined
    const provider = new CommitFilesProvider(comparison, {
      showCommit: noop,
      copyCommitHash: noop,
      selectParent: noop,
      copyDirectoryPath: noop,
      showCode: noop,
      openVersion: noop,
      openWorkingTree: noop,
      copyRelativePath: noop
    })
    const root = provider.getChildren()[0]
    const directory = provider.getChildren(root)[0]
    const file = provider.getChildren(directory)[0]
    const command = provider.getTreeItem(file).command
    const titles = provider.resolveActions(provider.getTreeItem(file), file).map(action => action.title)
    assert.equal(command?.command, 'git.commitFiles.invoke')
    assert.equal(command?.title, 'Show code')
    assert.deepEqual(JSON.parse(JSON.stringify(titles.slice(0, 2))), ['Show code', 'Copy relative path'])
    assert.equal(titles.includes('Show diff'), false)
    const deleted = provider.findFile('removed.ts')
    assert.ok(deleted)
    assert.equal(provider.getTreeItem(deleted).command?.title, 'Show code')
    assert.equal(provider.resolveActions(provider.getTreeItem(deleted), deleted)[0].title, 'Show code')
    provider.dispose()
  })

  it('uses Show commit as the root default action', () => {
    const comparison: CommitComparison = {
      commit: { sha: 'c'.repeat(40), shortSha: 'ccccccc', parents: [], author: 'test', authoredAt: '', subject: 'subject' },
      changes: []
    }
    const noop = async (): Promise<void> => undefined
    const provider = new CommitFilesProvider(comparison, {
      showCommit: noop,
      copyCommitHash: noop,
      selectParent: noop,
      copyDirectoryPath: noop,
      showCode: noop,
      openVersion: noop,
      openWorkingTree: noop,
      copyRelativePath: noop
    })
    const root = provider.getChildren()[0]
    const command = provider.getTreeItem(root).command
    assert.equal(command?.command, 'git.commitFiles.invoke')
    assert.equal(command?.title, 'Show commit')
    assert.equal(command?.arguments?.[0], root)
    provider.dispose()
  })

  it('finds a changed file by repository-relative path', () => {
    const comparison: CommitComparison = {
      commit: { sha: 'd'.repeat(40), shortSha: 'ddddddd', parents: [], author: 'test', authoredAt: '', subject: 'subject' },
      changes: [{ status: 'M', path: 'src/nested/file.ts', additions: 1, deletions: 1, binary: false }]
    }
    const noop = async (): Promise<void> => undefined
    const provider = new CommitFilesProvider(comparison, {
      showCommit: noop,
      copyCommitHash: noop,
      selectParent: noop,
      copyDirectoryPath: noop,
      showCode: noop,
      openVersion: noop,
      openWorkingTree: noop,
      copyRelativePath: noop
    })
    assert.equal(provider.findFile('src/nested/file.ts')?.relativePath, 'src/nested/file.ts')
    assert.equal(provider.findFile('src/missing.ts'), undefined)
    provider.dispose()
  })
})

describe('Git commit comparison loader', () => {
  it('loads initial, normal and empty commits from a real repository', async () => {
    const dir = createRepo()
    fs.mkdirSync(path.join(dir, 'nested'))
    fs.writeFileSync(path.join(dir, 'root.txt'), 'one\n')
    fs.writeFileSync(path.join(dir, 'nested', 'file.txt'), 'before\n')
    fs.writeFileSync(path.join(dir, 'binary.dat'), Buffer.from([0, 1, 2, 3]))
    const rootSha = commitAll(dir, 'root')
    const model = new Git({ path: 'git', version: '' }, channel)
    const initial = await loadCommitComparison(model, dir, rootSha)
    assert.equal(initial.baseSha, undefined)
    assert.equal(initial.changes.length, 3)
    assert.equal(initial.changes.find(change => change.path === 'binary.dat')?.binary, true)

    fs.writeFileSync(path.join(dir, 'root.txt'), 'one\ntwo\n')
    fs.renameSync(path.join(dir, 'nested', 'file.txt'), path.join(dir, 'renamed file.txt'))
    fs.writeFileSync(path.join(dir, 'new 中文.txt'), 'new\n')
    const normalSha = commitAll(dir, 'normal')
    const normal = await loadCommitComparison(model, dir, 'HEAD')
    assert.equal(normal.commit.sha, normalSha)
    assert.equal(normal.baseSha, rootSha)
    assert.equal(normal.changes.find(change => change.path === 'root.txt')?.additions, 1)
    assert.equal(normal.changes.some(change => change.status === 'R' && change.oldPath === 'nested/file.txt' && change.path === 'renamed file.txt'), true)

    git(dir, 'commit', '--allow-empty', '-q', '-m', 'empty')
    const empty = await loadCommitComparison(model, dir, 'HEAD')
    assert.equal(empty.changes.length, 0)
  })

  it('compares a merge commit independently against each parent', async () => {
    const dir = createRepo()
    fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n')
    commitAll(dir, 'base')
    const baseBranch = git(dir, 'branch', '--show-current').trim()
    git(dir, 'checkout', '-q', '-b', 'feature')
    fs.writeFileSync(path.join(dir, 'feature.txt'), 'feature\n')
    commitAll(dir, 'feature')
    git(dir, 'checkout', '-q', baseBranch)
    fs.writeFileSync(path.join(dir, 'master.txt'), 'master\n')
    commitAll(dir, 'master')
    git(dir, 'merge', '--no-ff', '-q', 'feature', '-m', 'merge')

    const model = new Git({ path: 'git', version: '' }, channel)
    const firstParent = await loadCommitComparison(model, dir, 'HEAD', 0)
    const secondParent = await loadCommitComparison(model, dir, 'HEAD', 1)
    assert.equal(firstParent.commit.parents.length, 2)
    assert.deepEqual(JSON.parse(JSON.stringify(firstParent.changes.map(change => change.path))), ['feature.txt'])
    assert.deepEqual(JSON.parse(JSON.stringify(secondParent.changes.map(change => change.path))), ['master.txt'])
  })
})
