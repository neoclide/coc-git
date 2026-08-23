import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { commitWithFugitive } from '../src/lists/gstatus'
import { parseBranchLine } from '../src/lists/branches'
import { isIssuePage } from '../src/source'
import { feedTreeToggleKey } from '../src/util'

describe('audit regressions', () => {
  it('rejects API error objects as issue pages', () => {
    assert.equal(isIssuePage([]), true)
    assert.equal(isIssuePage({ message: 'rate limited' }), false)
    assert.equal(isIssuePage(null), false)
  })

  it('filters symbolic and empty branch output', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(parseBranchLine('* main'))), { current: true, branch: 'main', remote: false })
    assert.deepEqual(JSON.parse(JSON.stringify(parseBranchLine('  remotes/origin/topic'))), { current: false, branch: 'origin/topic', remote: true })
    assert.equal(parseBranchLine('  remotes/origin/HEAD -> origin/main'), undefined)
    assert.equal(parseBranchLine(''), undefined)
  })

  it('feeds literal keys directly and resolves only safe special-key notation', async () => {
    const calls: Array<[string, unknown]> = []
    const nvim = {
      call: async (method: string, args: unknown): Promise<unknown> => {
        calls.push([method, args])
        return method === 'eval' ? '\n' : undefined
      }
    } as any

    await feedTreeToggleKey(nvim, 't')
    await feedTreeToggleKey(nvim, '<C-j>')
    await feedTreeToggleKey(nvim, 'x") | echoerr "unsafe')

    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
      ['feedkeys', ['t', 'in']],
      ['eval', ['"\\<C-j>"']],
      ['feedkeys', ['\n', 'in']],
      ['feedkeys', ['x") | echoerr "unsafe', 'in']]
    ])
  })

  it('restores the window cwd after the Fugitive commit action', async () => {
    const commands: string[] = []
    const nvim = {
      call: async (method: string, args?: string[]): Promise<unknown> => {
        if (method === 'getcwd') return '/original cwd'
        if (method === 'fnameescape') return `[${args[0]}]`
        return undefined
      },
      command: async (command: string): Promise<void> => {
        commands.push(command)
      }
    } as any
    await commitWithFugitive(nvim, [{
      label: 'file',
      data: { root: '/repository root', relative: 'changed file.ts' }
    }])

    assert.deepEqual(commands, [
      'lcd [/repository root]',
      'G commit -v -- [changed file.ts]',
      'lcd [/original cwd]'
    ])
  })
})
