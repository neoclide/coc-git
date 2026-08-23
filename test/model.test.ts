import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { getPreviousConflict } from '../src/model/buffer'
import { Git } from '../src/model/git'
import { parseDiffPath, Repo } from '../src/model/repo'
import { parseStatusEntries } from '../src/lists/gstatus'
import { parseTreeEntry } from '../src/lists/gfiles'
import { DiffCategory } from '../src/types'
import { createUnstagePatch, getUrl } from '../src/util'
import { createLineMapping, mapIndexChangesToBuffer, mergeGutterSigns } from '../src/model/staged'

const tempDirs: string[] = []
const channel = {
  append: () => undefined,
  appendLine: () => undefined
} as any

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function createRepo(): { dir: string, repo: Repo } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coc-git-model-'))
  tempDirs.push(dir)
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'test')
  const model = new Git({ path: 'git', version: '' }, channel)
  return { dir, repo: new Repo(model, channel, dir) }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function commitAll(dir: string): void {
  git(dir, 'add', '--all')
  git(dir, 'commit', '-q', '-m', 'test')
}

describe('repository model', () => {
  it('uses a configured Git executable whose path contains spaces', async () => {
    const { dir } = createRepo()
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'before\n')
    commitAll(dir)
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'after\n')
    const executable = path.join(dir, 'git wrapper')
    const logFile = path.join(dir, 'wrapper.log')
    fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('fs')
const { spawnSync } = require('child_process')
fs.appendFileSync(process.env.COC_GIT_WRAPPER_LOG, 'run\\n')
const result = spawnSync('git', process.argv.slice(2), { stdio: 'inherit', env: process.env })
process.exit(result.status == null ? 1 : result.status)
`)
    fs.chmodSync(executable, 0o755)
    process.env.COC_GIT_WRAPPER_LOG = logFile
    try {
      const model = new Git({ path: executable, version: '' }, channel)
      const repo = new Repo(model, channel, dir)
      const groups = await repo.getDiffAll(DiffCategory.Unstaged)
      assert.equal(groups.has('tracked.txt'), true)
      assert.match(fs.readFileSync(logFile, 'utf8'), /run/)
    } finally {
      delete process.env.COC_GIT_WRAPPER_LOG
    }
  })

  it('loads repository-wide diffs from the repository root', async () => {
    const { dir, repo } = createRepo()
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'before\n')
    commitAll(dir)
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'after\n')

    const groups = await repo.getDiffAll(DiffCategory.Unstaged)
    assert.equal(groups.has('tracked.txt'), true)
    assert.equal(groups.get('tracked.txt')?.length, 1)
  })

  it('detects changes when the committed file is empty', async () => {
    const { dir, repo } = createRepo()
    fs.writeFileSync(path.join(dir, 'empty.txt'), '')
    commitAll(dir)

    const diffs = await repo.getDiff('empty.txt', 'added\n')
    assert.equal(diffs.length, 1)
    assert.equal(diffs[0].added.count, 1)
  })

  it('preserves trailing spaces in diff content', async () => {
    const { dir, repo } = createRepo()
    fs.writeFileSync(path.join(dir, 'spaces.txt'), 'before\n')
    commitAll(dir)

    const diffs = await repo.getDiff('spaces.txt', '   \n')
    assert.equal(diffs.length, 1)
    assert.equal(diffs[0].lines.includes('+   '), true)
    fs.writeFileSync(path.join(dir, 'spaces.txt'), '   \n')
    const groups = await repo.getDiffAll(DiffCategory.Unstaged)
    assert.equal(groups.get('spaces.txt')?.[0].lines.includes('+   '), true)
  })

  it('returns an empty staged-chunk map when nothing is staged', async () => {
    const { dir, repo } = createRepo()
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'content\n')
    commitAll(dir)
    assert.equal(Object.keys(await repo.getStagedChunks('tracked.txt')).length, 0)
  })

  it('parses and unapplies diffs for paths with spaces, non-ASCII characters and newlines', async () => {
    const { dir, repo } = createRepo()
    const relative = 'sp ace-你好\nline.txt'
    fs.writeFileSync(path.join(dir, relative), 'before\n')
    commitAll(dir)
    fs.writeFileSync(path.join(dir, relative), 'after\n')
    git(dir, 'add', '--', relative)

    const chunks = (await repo.getStagedChunks(relative))[relative]
    assert.equal(chunks.length, 1)
    await repo.exec(['apply', '--cached', '--unidiff-zero', '-'], {
      input: createUnstagePatch(relative, chunks[0])
    })
    assert.equal(git(dir, 'diff', '--cached', '--name-only').trim(), '')
    const groups = await repo.getDiffAll(DiffCategory.Unstaged)
    assert.equal(groups.has(relative), true)
  })

  it('unapplies staged additions and deletions with their original hunk coordinates', async () => {
    const { dir, repo } = createRepo()
    const relative = 'tracked.txt'
    fs.writeFileSync(path.join(dir, relative), 'one\ntwo\nthree\n')
    commitAll(dir)

    fs.writeFileSync(path.join(dir, relative), 'one\ntwo\nthree\nfour\n')
    git(dir, 'add', '--', relative)
    let chunks = (await repo.getStagedChunks(relative))[relative]
    assert.equal(chunks.length, 1)
    await repo.exec(['apply', '--cached', '--unidiff-zero', '-'], {
      input: createUnstagePatch(relative, chunks[0])
    })
    assert.equal(git(dir, 'diff', '--cached', '--name-only').trim(), '')

    fs.writeFileSync(path.join(dir, relative), 'one\nthree\n')
    git(dir, 'add', '--', relative)
    chunks = (await repo.getStagedChunks(relative))[relative]
    assert.equal(chunks.length, 1)
    await repo.exec(['apply', '--cached', '--unidiff-zero', '-'], {
      input: createUnstagePatch(relative, chunks[0])
    })
    assert.equal(git(dir, 'diff', '--cached', '--name-only').trim(), '')
  })

  it('inverts staged hunk coordinates directly', () => {
    assert.match(createUnstagePatch('tracked.txt', {
      remove: { lnum: 3, count: 0 },
      add: { lnum: 4, count: 1 },
      lines: ['+four']
    }), /^@@ -4,1 \+3,0 @@$/m)
    assert.match(createUnstagePatch('tracked.txt', {
      remove: { lnum: 2, count: 1 },
      add: { lnum: 2, count: 2 },
      lines: ['-two', '+TWO', '+extra']
    }), /^@@ -2,2 \+2,1 @@$/m)
  })

  it('marks tracked deletions as working-tree changes', async () => {
    const { dir, repo } = createRepo()
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'content\n')
    commitAll(dir)
    fs.unlinkSync(path.join(dir, 'tracked.txt'))

    const status = await repo.getStatus('', {
      changedDecorator: '*',
      conflictedDecorator: 'x',
      stagedDecorator: '+',
      untrackedDecorator: '?'
    })
    assert.match(status, /\*$/)
  })

  it('reports untracked files without a fixed process timeout', async () => {
    const { dir, repo } = createRepo()
    fs.writeFileSync(path.join(dir, 'untracked.txt'), 'content\n')
    const status = await repo.getStatus('', {
      changedDecorator: '*',
      conflictedDecorator: 'x',
      stagedDecorator: '+',
      untrackedDecorator: '?'
    })
    assert.match(status, /\?$/)
  })

  it('recognizes ignored non-ASCII paths without parsing localized output', async () => {
    const { dir, repo } = createRepo()
    fs.writeFileSync(path.join(dir, '.gitignore'), '忽略.txt\n')
    assert.equal(await repo.isIgnored('忽略.txt'), true)
  })

  it('loads staged changes before the first commit', async () => {
    const { dir, repo } = createRepo()
    fs.writeFileSync(path.join(dir, 'first.txt'), 'first\n')
    git(dir, 'add', 'first.txt')
    fs.writeFileSync(path.join(dir, 'first.txt'), 'updated\n')
    const groups = await repo.getDiffAll(DiffCategory.All)
    assert.equal(groups.has('first.txt'), true)
    assert.equal(groups.get('first.txt')?.[0].lines.includes('+updated'), true)
  })
})

describe('edge-case parsing and navigation', () => {
  it('maps a staged line below an unstaged insertion', () => {
    const changes = [{ kind: 'add', layer: 'unstaged', line: 2, endLine: 2, sourceLine: 2, sourceCount: 0, targetCount: 1 } as const]
    const mapping = createLineMapping(['a', 'b', 'c'], ['a', 'new', 'b', 'c'], changes)
    const [mapped] = mapIndexChangesToBuffer([
      { kind: 'change', layer: 'staged', line: 3, endLine: 3 }
    ], mapping, 4)
    assert.equal(mapped.line, 4)
  })

  it('maps a staged deletion to a valid shared anchor', () => {
    const mapping = createLineMapping(['b', 'c'], ['b'], [
      { kind: 'delete', layer: 'unstaged', line: 2, endLine: 2, sourceLine: 2, sourceCount: 1, targetCount: 0 }
    ])
    const [mapped] = mapIndexChangesToBuffer([
      { kind: 'delete', layer: 'staged', line: 2, sourceLine: 2, sourceEndLine: 2 }
    ], mapping, 1)
    assert.equal(mapped.line, 1)
  })

  it('renders overlap as one mixed sign', () => {
    const signs = mergeGutterSigns(
      [{ line: 3, kind: 'change', layer: 'unstaged' }],
      [{ line: 3, kind: 'add', layer: 'staged' }]
    )
    assert.equal(signs.length, 1)
    assert.equal(signs[0].line, 3)
    assert.equal(signs[0].kind, 'mixed')
    assert.equal(signs[0].layer, 'mixed')
  })

  it('parses ls-tree entries whose filenames contain tabs', () => {
    assert.deepEqual(
      JSON.parse(JSON.stringify(parseTreeEntry('100644 blob abcdef\tpath\twith-tab.txt'))),
      { sha: 'abcdef', filepath: 'path\twith-tab.txt' }
    )
  })

  it('parses unquoted diff paths containing the separator text', () => {
    assert.equal(parseDiffPath('diff --git a/x b/y b/x b/y'), 'x b/y')
  })

  it('splits URL fixes at the final separator so regex alternation is preserved', () => {
    assert.equal(
      getUrl('(main|master)|branch', 'https://example.com/owner/repo', 'master', 'file.ts'),
      'https://example.com/owner/repo/blob/branch/file.ts'
    )
  })

  it('parses NUL-delimited rename records using the destination path', () => {
    const entries = JSON.parse(JSON.stringify(parseStatusEntries('R  new name\0old name\0?? 你好.txt\0')))
    assert.deepEqual(entries, [
      { index: 'R', tree: ' ', relative: 'new name' },
      { index: '?', tree: '?', relative: '你好.txt' }
    ])
  })

  it('finds the nearest previous conflict', () => {
    const conflicts = [
      { start: 2, sep: 4, end: 6, current: 'a', incoming: 'b' },
      { start: 10, sep: 12, end: 14, current: 'a', incoming: 'b' }
    ]
    assert.equal(getPreviousConflict(conflicts, 13)?.start, 10)
    assert.equal(getPreviousConflict(conflicts, 10)?.start, 2)
    assert.equal(getPreviousConflict(conflicts, 2), undefined)
  })
})
