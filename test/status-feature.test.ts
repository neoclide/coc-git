import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { commands, workspace } from 'coc.nvim'

describe('Git status TreeView', () => {
  it('shows status details and jumps to the first changed line', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coc-git-status-tree-'))
    try {
      execSync('git init -q', { cwd: dir })
      execSync('git config user.email test@example.com', { cwd: dir })
      execSync('git config user.name test', { cwd: dir })
      fs.mkdirSync(path.join(dir, 'src'))
      const file = path.join(dir, 'src', 'changed.ts')
      const deleted = path.join(dir, 'deleted.ts')
      fs.writeFileSync(file, 'one\ntwo\nthree\nfour\n')
      fs.writeFileSync(deleted, 'content from HEAD\nsecond line\n')
      execSync('git add src/changed.ts deleted.ts && git commit -q -m init', { cwd: dir })
      fs.writeFileSync(file, 'one\ntwo\nCHANGED\nfour\n')
      fs.unlinkSync(deleted)
      fs.writeFileSync(path.join(dir, 'staged.txt'), 'staged\n')
      execSync('git add staged.txt', { cwd: dir })
      fs.writeFileSync(path.join(dir, 'staged.txt'), 'staged and unstaged\n')
      fs.writeFileSync(path.join(dir, 'untracked.txt'), 'untracked\n')
      const document = await workspace.openTextDocument(file)
      await workspace.nvim.command(`buffer ${document.bufnr}`)

      await commands.executeCommand('git.statusTree')

      const buffers = await workspace.nvim.call('getbufinfo') as Array<{ bufnr: number; name: string }>
      const tree = buffers.find(item => /^CocTree\d+$/.test(path.basename(item.name)))
      assert.ok(tree)
      const treeLines = await workspace.nvim.call('getbufline', [tree.bufnr, 1, '$']) as string[]
      assert.match(await workspace.nvim.eval('getline(".")') as string, /changed\.ts/)
      assert.ok(treeLines.some(line => line.includes('src') && line.includes('1 unstaged')), JSON.stringify(treeLines))
      assert.ok(treeLines.some(line => line.includes('deleted.ts') && line.includes('[ D]') && line.includes('unstaged: Deleted')), JSON.stringify(treeLines))
      assert.ok(treeLines.some(line => line.includes('staged.txt') && line.includes('[AM]') && line.includes('staged: Added') && line.includes('unstaged: Modified')), JSON.stringify(treeLines))
      assert.ok(treeLines.some(line => line.includes('untracked.txt') && line.includes('[??]') && line.includes('Untracked')), JSON.stringify(treeLines))

      await commands.executeCommand('git.statusFiles.open', {
        kind: 'file',
        relativePath: 'deleted.ts',
        entry: { index: ' ', tree: 'D', relative: 'deleted.ts' }
      })
      assert.match(await workspace.nvim.eval('bufname("%")') as string, /^coc-git:\/\/[0-9a-f]+\/deleted\.ts$/)
      assert.equal(await workspace.nvim.eval('getline(1)'), 'content from HEAD')
      assert.equal(await workspace.nvim.eval('&buftype'), 'nofile')
      assert.equal(await workspace.nvim.eval('&modifiable'), 0)

      await commands.executeCommand('git.statusFiles.open', {
        kind: 'file',
        relativePath: 'src/changed.ts',
        entry: { index: ' ', tree: 'M', relative: 'src/changed.ts' }
      })
      assert.equal(path.resolve(await workspace.nvim.eval('expand("%:p")') as string), file)
      assert.equal(await workspace.nvim.call('line', ['.']), 3)

      const stagedNode = { kind: 'file', relativePath: 'staged.txt', entry: { index: 'A', tree: 'M', relative: 'staged.txt' } }
      await commands.executeCommand('git.statusFiles.add', stagedNode)
      assert.equal(execSync('git status --porcelain -- staged.txt', { cwd: dir, encoding: 'utf8' }).trim(), 'A  staged.txt')
      await commands.executeCommand('git.statusFiles.restoreStaged', stagedNode)
      assert.equal(execSync('git status --porcelain -- staged.txt', { cwd: dir, encoding: 'utf8' }).trim(), '?? staged.txt')

      const changedNode = { kind: 'file', relativePath: 'src/changed.ts', entry: { index: ' ', tree: 'M', relative: 'src/changed.ts' } }
      await commands.executeCommand('git.statusFiles.restoreWorkingTree', changedNode)
      assert.equal(execSync('git status --porcelain -- src/changed.ts', { cwd: dir, encoding: 'utf8' }), '')
    } finally {
      await commands.executeCommand('git.statusFiles.close')
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
