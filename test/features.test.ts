import assert from 'node:assert/strict'
import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { commands, window, workspace } from 'coc.nvim'
import { formatBlameText } from '../src/index'

describe('git blame format', () => {
  it('formats blame text with the default placeholders', () => {
    const info = { sha: 'abcdef012345', author: 'You', time: '3 days ago', summary: 'fix typo' }
    assert.equal(formatBlameText(info), '(You 3 days ago) fix typo')
  })

  it('supports custom placeholders and percent escaping', () => {
    const info = { sha: 'abcdef012345', author: 'Alice', time: '2026-08-16', summary: 'feat: x' }
    assert.equal(
      formatBlameText(info, '%S %a|%t|%s 100%%'),
      'abcdef0 Alice|2026-08-16|feat: x 100%'
    )
  })

  it('tolerates missing fields', () => {
    assert.equal(formatBlameText({} as any), '( ) ')
  })

  it('registers a blameFormat default', () => {
    assert.equal(workspace.getConfiguration('git').get('blameFormat'), '(%a %t) %s')
  })
})

describe('git chunk info', () => {
  it('renders staged-only changes with a staged sign when enabled', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coc-git-staged-sign-'))
    const config = workspace.getConfiguration('git')
    try {
      execSync('git init -q', { cwd: dir })
      execSync('git config user.email test@example.com', { cwd: dir })
      execSync('git config user.name test', { cwd: dir })
      const file = path.join(dir, 'staged.txt')
      fs.writeFileSync(file, 'one\ntwo\nthree\nfour\nfive\nsix\n')
      execSync('git add staged.txt && git commit -q -m init', { cwd: dir })
      fs.writeFileSync(file, 'one\nSTAGED\nthree\nfour\nSTAGED FIVE\nsix\n')
      execSync('git add staged.txt', { cwd: dir })
      await config.update('enableStagedGutters', true, true)
      const document = await workspace.openTextDocument(file)
      await workspace.nvim.command(`buffer ${document.bufnr}`)
      const placed = await waitForPlacedSigns(document.bufnr)
      assert.ok(placed.some(sign => sign.name === 'CocGitStagedChanged'))
      await workspace.nvim.call('cursor', [1, 1])
      await commands.executeCommand('git.nextChunk')
      assert.equal(await workspace.nvim.call('line', '.'), 2)
      await commands.executeCommand('git.nextChunk')
      assert.equal(await workspace.nvim.call('line', '.'), 5)
      await commands.executeCommand('git.prevChunk')
      assert.equal(await workspace.nvim.call('line', '.'), 2)
    } finally {
      await config.update('enableStagedGutters', false, true)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('git.allChunkInfo returns chunks for a modified file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coc-git-chunks-'))
    try {
      execSync('git init -q', { cwd: dir })
      execSync('git config user.email test@example.com', { cwd: dir })
      execSync('git config user.name test', { cwd: dir })
      const file = path.join(dir, 'a.txt')
      fs.writeFileSync(file, '1\n2\n3\n4\n5\n')
      execSync('git add a.txt && git commit -q -m init', { cwd: dir })
      fs.writeFileSync(file, '1\nchanged\n3\n4\n5\n')
      const document = await workspace.openTextDocument(file)
      await workspace.nvim.command(`buffer ${document.bufnr}`)
      const chunks = await waitForChunks()
      assert.ok(chunks.length >= 1)
      const chunk = chunks[0]
      assert.ok(typeof chunk.start === 'number' && chunk.start >= 1)
      assert.ok(typeof chunk.end === 'number' && chunk.end >= chunk.start)
      assert.ok(['add', 'changed', 'delete'].includes(chunk.changeType))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stages a pure addition at the end of a file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coc-git-stage-addition-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir })
      const file = path.join(dir, 'a.txt')
      fs.writeFileSync(file, 'one\ntwo\nthree\n')
      execFileSync('git', ['add', '--', 'a.txt'], { cwd: dir })
      execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
      fs.writeFileSync(file, 'one\ntwo\nthree\nfour\n')
      const document = await workspace.openTextDocument(file)
      await workspace.nvim.command(`buffer ${document.bufnr}`)
      await waitForChunks()
      await workspace.nvim.call('cursor', [4, 1])
      await commands.executeCommand('git.chunkStage')
      assert.equal(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: dir, encoding: 'utf8' }).trim(), 'a.txt')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('jumps to the blamed line when showing a commit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coc-git-show-commit-'))
    try {
      execSync('git init -q', { cwd: dir })
      execSync('git config user.email test@example.com', { cwd: dir })
      execSync('git config user.name test', { cwd: dir })
      const file = path.join(dir, 'a.ts')
      const targetLine = 105
      const lines = [
        ...Array<string>(5).fill(''),
        ...Array.from({ length: 100 }, (_, index) => `const line${index + 1} = ${index + 1}`)
      ]
      fs.writeFileSync(file, `${lines.join('\n')}\n`)
      execSync('git add a.ts && git commit -q -m init', { cwd: dir })
      lines[targetLine - 1] = 'const changed = true'
      fs.writeFileSync(file, `${lines.join('\n')}\n`)
      fs.writeFileSync(path.join(dir, 'other.ts'), 'export const other = true\n')
      execSync('git add a.ts other.ts && git commit -q -m change-last-line', { cwd: dir })
      lines[0] = 'const workingTreeChange = true'
      fs.writeFileSync(file, `${lines.join('\n')}\n`)
      const document = await workspace.openTextDocument(file)
      await workspace.nvim.command(`buffer ${document.bufnr}`)
      await waitForChunks()
      await workspace.nvim.call('cursor', [targetLine, 1])
      const messages: string[] = []
      const showWarningMessage = window.showWarningMessage
      window.showWarningMessage = ((message: string) => {
        messages.push(message)
        return Promise.resolve(undefined)
      }) as typeof window.showWarningMessage
      let bufferName: string
      try {
        await commands.executeCommand('git.showCommit')
        bufferName = await waitForCommitBuffer()
      } catch (e) {
        throw new Error(`${e.message}; warnings=${JSON.stringify(messages)}`)
      } finally {
        window.showWarningMessage = showWarningMessage
      }
      assert.match(bufferName, /^\[commit [0-9a-f]+\]$/)
      assert.match(await workspace.nvim.eval('getline(1)') as string, /^commit [0-9a-f]+$/)
      assert.equal(await workspace.nvim.eval('getline(".")'), '+const changed = true')
      assert.equal(await workspace.nvim.eval('&filetype'), 'git')
      const shownLines = await workspace.nvim.call('getline', [1, '$']) as string[]
      assert.ok(shownLines.includes('diff --git a/other.ts b/other.ts'))

      await workspace.nvim.command(`buffer ${document.bufnr}`)
      await workspace.nvim.call('cursor', [targetLine, 1])
      const commitLines = execSync('git --no-pager show HEAD', { cwd: dir, encoding: 'utf8' }).trim().split('\n')
      await workspace.nvim.setVar('coc_git_test_commit_lines', commitLines)
      await workspace.nvim.command([
        'function! CocGitTestGedit(arg) abort',
        'let g:coc_git_test_revision = a:arg',
        'enew',
        'call append(0, g:coc_git_test_commit_lines)',
        'normal! Gdd',
        'endfunction'
      ].join('\n'))
      await workspace.nvim.command('command! -nargs=1 Gedit call CocGitTestGedit(<q-args>)')
      await workspace.nvim.command('let g:loaded_fugitive = 1')
      try {
        await commands.executeCommand('git.showCommit')
        assert.match(await workspace.nvim.eval('g:coc_git_test_revision') as string, /^[0-9a-f]+$/)
        assert.equal(await workspace.nvim.eval('getline(".")'), '+const changed = true')
      } finally {
        await workspace.nvim.command('delcommand Gedit')
        await workspace.nvim.command('delfunction CocGitTestGedit')
        await workspace.nvim.command('unlet! g:coc_git_test_revision g:coc_git_test_commit_lines g:loaded_fugitive')
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('shows the commit associated with the current line in a TreeView', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coc-git-show-commit-tree-'))
    try {
      execSync('git init -q', { cwd: dir })
      execSync('git config user.email test@example.com', { cwd: dir })
      execSync('git config user.name test', { cwd: dir })
      fs.mkdirSync(path.join(dir, 'src', 'nested'), { recursive: true })
      const file = path.join(dir, 'src', 'nested', 'current.ts')
      fs.writeFileSync(file, 'const first = 1\nconst second = 2\nconst third = 3\n')
      execSync('git add src/nested/current.ts && git commit -q -m initial-line', { cwd: dir })
      const initial = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim()
      fs.writeFileSync(file, 'const prefix = 0\nconst first = 1\nconst second = 2\nconst third = 3\n')
      execSync('git add src/nested/current.ts && git commit -q -m later-line', { cwd: dir })
      fs.writeFileSync(file, 'const prefix = 0\nconst first = 1\nconst second = 2\nconst third = 4\n')
      const document = await workspace.openTextDocument(file)
      await workspace.nvim.command(`buffer ${document.bufnr}`)
      await waitForChunks()
      await workspace.nvim.call('cursor', [3, 1])

      await commands.executeCommand('git.showCommitTree')

      assert.equal(await workspace.nvim.eval('bufname("%")'), `coc-git://${initial}/src/nested/current.ts`)
      assert.equal(await workspace.nvim.call('line', ['.']), 2)
      assert.equal(await workspace.nvim.call('getline', ['.']), 'const second = 2')
      const buffers = await workspace.nvim.call('getbufinfo') as Array<{ bufnr: number; name: string }>
      const tree = buffers.find(item => /^CocTree\d+$/.test(path.basename(item.name)))
      assert.ok(tree)
      const treeLines = await workspace.nvim.call('getbufline', [tree.bufnr, 1, '$']) as string[]
      assert.ok(treeLines.some(line => line.includes(initial.slice(0, 7)) && line.includes('initial-line')))
      assert.ok(treeLines.some(line => line.includes('nested')))
      assert.ok(treeLines.some(line => line.includes('current.ts')))
      assert.equal(Boolean(await workspace.nvim.call('getbufvar', [tree.bufnr, '&winfixbuf'])), false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('opens commit file content with decorations and chunk navigation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coc-git-commit-document-'))
    try {
      execSync('git init -q', { cwd: dir })
      execSync('git config user.email test@example.com', { cwd: dir })
      execSync('git config user.name test', { cwd: dir })
      fs.mkdirSync(path.join(dir, 'src'))
      const file = path.join(dir, 'src', 'sample.ts')
      fs.writeFileSync(file, Array.from({ length: 10 }, (_, index) => `const line${index + 1} = ${index + 1}`).join('\n') + '\n')
      execSync('git add src/sample.ts && git commit -q -m initial', { cwd: dir })
      const baseSha = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim()
      const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n')
      lines[1] = 'const line2 = 20'
      lines.splice(4, 1)
      lines[7] = 'const line9 = 90'
      fs.writeFileSync(file, lines.join('\n') + '\n')
      execSync('git add src/sample.ts && git commit -q -m decorated', { cwd: dir })
      const commitSha = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim()
      await workspace.nvim.command('tabnew')
      const document = await workspace.openTextDocument(file)
      await workspace.nvim.command(`buffer ${document.bufnr}`)
      const comparison = {
        commit: { sha: commitSha, shortSha: commitSha.slice(0, 7), parents: [baseSha], author: 'test', authoredAt: '', subject: 'decorated' },
        baseSha,
        parentIndex: 0,
        changes: []
      }
      const change = { status: 'M', path: 'src/sample.ts', additions: 2, deletions: 3, binary: false }
      await commands.executeCommand('git.commitFiles.openDocument', dir, comparison, change)

      assert.equal(await workspace.nvim.eval('&buftype'), 'nofile')
      assert.equal(await workspace.nvim.eval('&filetype'), 'typescript')
      assert.equal(await workspace.nvim.eval('&modifiable'), 0)
      assert.equal(await workspace.nvim.eval('getline(2)'), 'const line2 = 20')
      assert.match(await workspace.nvim.eval('bufname("%")') as string, new RegExp(`^coc-git://${commitSha}/src/sample\\.ts$`))
      const commitDocument = workspace.getDocument(await workspace.nvim.call('bufnr', ['%']) as number)
      assert.ok(commitDocument)
      const highlights = await commitDocument.buffer.getHighlights('coc-git-commit-add')
      assert.deepEqual(highlights.map(item => item.lnum), [1, 7])
      const namespaces = await workspace.nvim.namespaces
      assert.equal(await workspace.nvim.call('coc#vtext#exists', [commitDocument.bufnr, namespaces['coc-git-commit-document']]), 1)

      await workspace.nvim.call('cursor', [1, 1])
      await commands.executeCommand('git.nextChunk')
      assert.equal(await workspace.nvim.call('line', ['.']), 2)
      await commands.executeCommand('git.nextChunk')
      assert.equal(await workspace.nvim.call('line', ['.']), 4)
      await commands.executeCommand('git.nextChunk')
      assert.equal(await workspace.nvim.call('line', ['.']), 8)
      await commands.executeCommand('git.prevChunk')
      assert.equal(await workspace.nvim.call('line', ['.']), 4)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

function waitForChunks(timeoutMs = 15000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('git.allChunkInfo did not return chunks in time')), timeoutMs)
    const interval = setInterval(async () => {
      try {
        const chunks = (await commands.executeCommand('git.allChunkInfo')) as any[]
        if (chunks.length > 0) {
          clearTimeout(timer)
          clearInterval(interval)
          resolve(chunks)
        }
      } catch (e) {
        clearTimeout(timer)
        clearInterval(interval)
        reject(e)
      }
    }, 100)
  })
}

function waitForPlacedSigns(bufnr: number, timeoutMs = 15000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('staged gutter sign did not appear in time')), timeoutMs)
    const interval = setInterval(async () => {
      try {
        const placed = await workspace.nvim.call('sign_getplaced', [bufnr, { group: 'CocGit' }]) as any[]
        const signs = placed?.[0]?.signs ?? []
        if (signs.length > 0) {
          clearTimeout(timer)
          clearInterval(interval)
          resolve(signs)
        }
      } catch (e) {
        clearTimeout(timer)
        clearInterval(interval)
        reject(e)
      }
    }, 100)
  })
}

function waitForCommitBuffer(timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('git.showCommit did not open a commit buffer')), timeoutMs)
    const interval = setInterval(async () => {
      try {
        const name = await workspace.nvim.eval('bufname("%")') as string
        if (/^\[commit [0-9a-f]+\]$/.test(name)) {
          clearTimeout(timer)
          clearInterval(interval)
          resolve(name)
        }
      } catch (e) {
        clearTimeout(timer)
        clearInterval(interval)
        reject(e)
      }
    }, 100)
  })
}
