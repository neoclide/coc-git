import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { workspace } from 'coc.nvim'
import { formatBlameText } from '../lib/index.js'

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
