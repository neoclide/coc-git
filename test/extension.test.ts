import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { commands, window, workspace } from 'coc.nvim'
import extension from '../lib/index.js'

const gitCommands = [
  'git.refresh',
  'git.chunkInfo',
  'git.chunkStage',
  'git.chunkUnstage',
  'git.chunkUndo',
  'git.showCommit',
  'git.browserOpen',
  'git.copyUrl',
  'git.copyPermalink',
  'git.push',
  'git.diffCached',
  'git.toggleGutters',
  'git.foldUnchanged',
  'git.showBlameDoc'
]

describe('coc-git extension', () => {
  it('loads the extension module', () => {
    assert.equal(typeof extension.activate, 'function')
  })

  it('registers git commands', () => {
    for (const name of gitCommands) {
      assert.equal(commands.has(name), true, `command ${name} not registered`)
    }
  })

  it('communicates with the editor', async () => {
    assert.equal(await workspace.nvim.eval('1 + 1'), 2)
  })

  it('shows a corrected warning for a buffer outside a git repository', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coc-git-warning-'))
    const file = path.join(dir, 'plain.txt')
    fs.writeFileSync(file, 'hello\n')
    try {
      await workspace.nvim.command(`edit ${file}`)
      const original = window.showWarningMessage
      const messages: string[] = []
      window.showWarningMessage = ((message: string) => {
        messages.push(message)
        return Promise.resolve(undefined)
      }) as unknown as typeof window.showWarningMessage
      try {
        await commands.executeCommand('git.chunkInfo')
      } finally {
        window.showWarningMessage = original
      }
      assert.ok(
        messages.includes("Can't resolve git repository for current buffer."),
        `expected corrected warning, got ${JSON.stringify(messages)}`
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
