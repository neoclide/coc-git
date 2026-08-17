import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { commands, workspace } from 'coc.nvim'
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
