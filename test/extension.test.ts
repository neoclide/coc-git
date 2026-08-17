import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { commands, window, workspace } from 'coc.nvim'
import * as extension from '../src/index'
import manifest from '../package.json'

const gitCommands = [
  'git.refresh',
  'git.nextChunk',
  'git.prevChunk',
  'git.keepCurrent',
  'git.keepIncoming',
  'git.keepBoth',
  'git.chunkInfo',
  'git.allChunkInfo',
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

  it('declares every registered git command in the extension manifest', () => {
    const declared = new Set(manifest.contributes.commands.map(item => item.command))
    for (const name of gitCommands) {
      assert.equal(declared.has(name), true, `command ${name} missing from package.json`)
    }
  })

  it('uses runtime-compatible configuration defaults', () => {
    const properties = manifest.contributes.configuration.properties
    assert.deepEqual(properties['git.pushArguments'].default, [])
    assert.equal(properties['git.gstatus.saveBeforeOpen'].default, false)
    assert.equal(manifest['coc-test'].entryFile, 'src/index.ts')
  })

  it('communicates with the editor', async () => {
    assert.equal(await workspace.nvim.eval('1 + 1'), 2)
  })

  it('shows a corrected warning for a buffer outside a git repository', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coc-git-warning-'))
    const file = path.join(dir, 'plain.txt')
    fs.writeFileSync(file, 'hello\n')
    try {
      const document = await workspace.openTextDocument(file)
      await workspace.nvim.command(`buffer ${document.bufnr}`)
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
