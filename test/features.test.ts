import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
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
