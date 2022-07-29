import { commands, CompletionItem, CompletionItemKind, ExtensionContext, InsertTextFormat, languages, listManager, Position, Range, window, workspace } from 'coc.nvim'
import { DEFAULT_TYPES } from './constants'
import Bcommits from './lists/bcommits'
import Branches from './lists/branches'
import Commits from './lists/commits'
import Gfiles from './lists/gfiles'
import GStatus from './lists/gstatus'
import GChunks from './lists/gchunks'
import Manager from './manager'
import Git from './model/git'
import Resolver from './model/resolver'
import GitService from './model/service'
import addSource from './source'
import { findGit, IGit } from './util'

export interface ExtensionApi {
  git: Git
  resolver: Resolver
  manager: Manager
}

export async function activate(context: ExtensionContext): Promise<ExtensionApi | undefined> {
  const config = workspace.getConfiguration('git')
  const { subscriptions } = context
  let gitInfo: IGit
  try {
    let pathHint = config.get<string>('command')
    gitInfo = await findGit(pathHint, path => context.logger.info(`Looking for git in: ${path}`))
  } catch (e) {
    window.showMessage('git command required for coc-git', 'error')
    return
  }
  const virtualTextSrcId = await workspace.nvim.createNamespace('coc-git-virtual')
  const conflictSrcId = await workspace.nvim.createNamespace('coc-git-conflicts')
  const { nvim } = workspace
  const service = new GitService(gitInfo)
  const manager = new Manager(nvim, service, virtualTextSrcId, conflictSrcId)
  subscriptions.push(manager)
  addSource(context, service.resolver)

  subscriptions.push(commands.registerCommand('git.refresh', () => {
    manager.refresh()
  }))

  subscriptions.push(workspace.registerKeymap(['n'], 'git-nextchunk', async () => {
    await manager.nextChunk()
  }, { sync: false }))

  subscriptions.push(workspace.registerKeymap(['n'], 'git-prevchunk', async () => {
    await manager.prevChunk()
  }, { sync: false }))

  subscriptions.push(workspace.registerKeymap(['n'], 'git-nextconflict', async () => {
    await manager.nextConflict()
  }, { sync: false }))

  subscriptions.push(workspace.registerKeymap(['n'], 'git-prevconflict', async () => {
    await manager.prevConflict()
  }, { sync: false }))

  subscriptions.push(workspace.registerKeymap(['n'], 'git-keepcurrent', async () => {
    await manager.keepCurrent()
  }, { sync: false }))

  subscriptions.push(workspace.registerKeymap(['n'], 'git-keepincoming', async () => {
    await manager.keepIncoming()
  }, { sync: false }))

  subscriptions.push(workspace.registerKeymap(['n'], 'git-keepboth', async () => {
    await manager.keepBoth()
  }, { sync: false }))

  subscriptions.push(workspace.registerKeymap(['n'], 'git-chunkinfo', async () => {
    await manager.chunkInfo()
  }, { sync: false }))

  subscriptions.push(workspace.registerKeymap(['n'], 'git-commit', async () => {
    await manager.showCommit()
  }, { sync: false }))

  subscriptions.push(workspace.registerKeymap(['n'], 'git-showblamedoc', async () => {
    await manager.showBlameDoc()
  }, { sync: false }))

  subscriptions.push(commands.registerCommand('git.keepCurrent', async () => {
    await manager.keepCurrent()
  }))

  subscriptions.push(commands.registerCommand('git.keepIncoming', async () => {
    await manager.keepIncoming()
  }))

  subscriptions.push(commands.registerCommand('git.keepBoth', async () => {
    await manager.keepBoth()
  }))

  subscriptions.push(commands.registerCommand('git.chunkInfo', async () => {
    await manager.chunkInfo()
  }))

  subscriptions.push(commands.registerCommand('git.chunkStage', async () => {
    await manager.chunkStage()
  }))

  subscriptions.push(commands.registerCommand('git.chunkUnstage', async () => {
    await manager.chunkUnstage()
  }))

  subscriptions.push(commands.registerCommand('git.chunkUndo', async () => {
    await manager.chunkUndo()
  }))

  subscriptions.push(commands.registerCommand('git.showCommit', async () => {
    await manager.showCommit()
  }))

  subscriptions.push(commands.registerCommand('git.browserOpen', async () => {
    await manager.browser()
  }))

  subscriptions.push(commands.registerCommand('git.copyUrl', async (...args) => {
    await manager.browser('copy', args as [number, number])
  }))

  subscriptions.push(commands.registerCommand('git.copyPermalink', async (...args) => {
    await manager.browser('copy', args as [number, number], true)
  }))

  subscriptions.push(commands.registerCommand('git.push', async (...args) => {
    await manager.push(args)
  }))

  subscriptions.push(commands.registerCommand('git.diffCached', async () => {
    await manager.diffCached()
  }))

  subscriptions.push(commands.registerCommand('git.toggleGutters', async () => {
    await manager.toggleGutters()
  }))

  subscriptions.push(commands.registerCommand('git.foldUnchanged', async () => {
    await manager.toggleFold()
  }))

  subscriptions.push(commands.registerCommand('git.showBlameDoc', async () => {
    await manager.showBlameDoc()
  }))

  subscriptions.push(listManager.registerList(new GStatus(nvim, manager)))
  subscriptions.push(listManager.registerList(new Branches(nvim, manager)))
  subscriptions.push(listManager.registerList(new Commits(nvim, manager)))
  subscriptions.push(listManager.registerList(new Bcommits(nvim, manager)))
  subscriptions.push(listManager.registerList(new Gfiles(nvim, manager)))
  subscriptions.push(listManager.registerList(new GChunks(nvim, manager)))
  subscriptions.push(languages.registerCompletionItemProvider('semantic-commit', 'Commit', config.get<string[]>('semanticCommit.filetypes'), {
    provideCompletionItems: async (document, position): Promise<CompletionItem[]> => {
      if (position.line !== 0) {
        return []
      }
      const text = document.getText(
        Range.create(
          Position.create(position.line, 0),
          position
        )
      )
      if (/^[a-z]*$/.test(text)) {
        const scope = config.get('semanticCommit.scope') as boolean
        // tslint:disable-next-line: no-invalid-template-strings
        const text = scope ? '(${1:scope}): ${2:commit}' : ': ${1:commit}'
        return DEFAULT_TYPES.map(o => {
          return {
            label: o.value,
            kind: CompletionItemKind.Snippet,
            documentation: { kind: 'plaintext', value: o.name },
            // detail: o.name,
            insertTextFormat: InsertTextFormat.Snippet,
            // tslint:disable-next-line: no-invalid-template-strings
            insertText: o.value + text + '\n\n'
          } as CompletionItem
        })
      }
      return []
    }
  }))

  subscriptions.push(workspace.registerKeymap(['o', 'x'], 'git-chunk-inner', async () => {
    let diff = await manager.getCurrentChunk()
    if (!diff) return
    // diff.start
    await nvim.command(`normal! ${diff.start}GV${diff.end}G`)
  }, { sync: true, silent: true }))

  subscriptions.push(workspace.registerKeymap(['o', 'x'], 'git-chunk-outer', async () => {
    let diff = await manager.getCurrentChunk()
    if (!diff) return
    let total = await nvim.call('line', ['$']) as number
    let start = Math.max(1, diff.start - 1)
    let end = Math.min(diff.end + 1, total)
    await nvim.command(`normal! ${start}GV${end}G`)
  }, { sync: true, silent: true }))

  return {
    git: service.git,
    resolver: service.resolver,
    manager
  }
}
