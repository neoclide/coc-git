import assert from 'node:assert/strict'
import { it } from 'node:test'
import { workspace } from 'coc.nvim'
const GStatus = require('../src/lists/gstatus').default
const Gfiles = require('../src/lists/gfiles').default
const Commits = require('../src/lists/commits').default
const Bcommits = require('../src/lists/bcommits').default

it('allows zc and zM to fold list diff previews', async () => {
  const nvim = workspace.nvim
  const lines = [
    'diff --git a/file.txt b/file.txt',
    'index 1234567..abcdef0 100644',
    '--- a/file.txt',
    '+++ b/file.txt',
    '@@ -1,3 +1,3 @@',
    ' one',
    '-two',
    '+changed',
    ' three'
  ]
  const manager = {
    diffOptions: [],
    git: { exec: async () => ({ stdout: lines.join('\n') }) }
  } as any
  const window = await nvim.window
  const context = { window, options: { position: 'bottom' } } as any
  const item = {
    label: 'file.txt',
    data: { root: '/tmp', relative: 'file.txt', filepath: 'file.txt',
      tree_symbol: 'M', index_symbol: ' ', sha: 'abcdef0', commit: 'abcdef0', branch: 'HEAD' }
  }
  for (const List of [GStatus, Gfiles, Commits, Bcommits]) {
    const list = new List(nvim, manager)
    try {
      await list.actions.find(action => action.name === 'preview')!.execute(item, context)
      const winid = await nvim.call('coc#list#get_preview') as number
      await nvim.call('win_gotoid', [winid])
      assert.equal(await nvim.eval('&foldmethod'), 'syntax', list.name)
      await nvim.command('normal! zR')
      await nvim.call('cursor', [7, 1])
      await nvim.command('normal! zc')
      assert.ok(await nvim.call('foldclosed', [7]) > 0, `${list.name}: zc`)
      await nvim.command('normal! zR')
      await nvim.command('normal! zM')
      assert.ok(await nvim.call('foldclosed', [7]) > 0, `${list.name}: zM`)
    } finally {
      await nvim.call('win_gotoid', [window.id])
      await nvim.call('coc#list#close_preview', [])
      list.dispose()
    }
  }
})
