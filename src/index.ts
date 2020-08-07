import { commands, events, ExtensionContext, languages, listManager, workspace } from 'coc.nvim'
import { CompletionItem, CompletionItemKind, InsertTextFormat, Range, Position } from 'vscode-languageserver-types'
import { DEFAULT_TYPES } from './constants'
import Bcommits from './lists/bcommits'
import Branches from './lists/branches'
import Commits from './lists/commits'
import Gfiles from './lists/gfiles'
import GStatus from './lists/gstatus'
import Manager from './manager'
import Git from './git'
import Resolver from './resolver'
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
  const outputChannel = workspace.createOutputChannel('git')
  let gitInfo: IGit
  try {
    let pathHint = config.get<string>('command')
    gitInfo = await findGit(pathHint, path => outputChannel.appendLine(`Looking for git in: ${path}`))
  } catch (e) {
    workspace.showMessage('git command required for coc-git', 'error')
    return
  }
  const { nvim } = workspace
  const git = new Git(gitInfo, outputChannel)
  const resolver = new Resolver(git)
  const manager = new Manager(nvim, resolver, git, outputChannel)
  addSource(context, resolver)
  subscriptions.push(manager)

  subscriptions.push(commands.registerCommand('git.refresh', () => {
    manager.updateAll()
  }))

  events.on('BufWritePost', bufnr => {
    let doc = workspace.getDocument(bufnr)
    if (!doc) return
    if (doc.uri.startsWith('fugitive:') || doc.uri.endsWith("COMMIT_EDITMSG")) {
      let timer = setTimeout(() => {
        manager.updateAll()
      }, 300)
      subscriptions.push({
        dispose: () => {
          clearTimeout(timer)
        }
      })
    }
  }, null, subscriptions)
  events.on('FocusGained', () => {
    manager.updateAll()
  })
  events.on('BufEnter', bufnr => {
    manager.updateAll(bufnr)
  })

  subscriptions.push(workspace.registerKeymap(['n'], 'git-nextchunk', async () => {
    await manager.nextChunk()
  }, { sync: false }))

  subscriptions.push(workspace.registerKeymap(['n'], 'git-prevchunk', async () => {
    await manager.prevChunk()
  }, { sync: false }))

  subscriptions.push(workspace.registerKeymap(['n'], 'git-chunkinfo', async () => {
    await manager.chunkInfo()
  }, { sync: false }))

  subscriptions.push(workspace.registerKeymap(['n'], 'git-commit', async () => {
    await manager.showCommit()
  }, { sync: false }))

  subscriptions.push(commands.registerCommand('git.chunkInfo', async () => {
    await manager.chunkInfo()
  }))

  subscriptions.push(commands.registerCommand('git.chunkStage', async () => {
    await manager.chunkStage()
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

  subscriptions.push(commands.registerCommand('git.diffCached', async () => {
    await manager.diffCached()
  }))

  subscriptions.push(commands.registerCommand('git.toggleGutters', async () => {
    await manager.toggleGutters()
  }))

  subscriptions.push(commands.registerCommand('git.foldUnchanged', async () => {
    await manager.toggleFold()
  }))

  subscriptions.push(listManager.registerList(new GStatus(nvim, manager)))
  subscriptions.push(listManager.registerList(new Branches(nvim, manager)))
  subscriptions.push(listManager.registerList(new Commits(nvim, manager)))
  subscriptions.push(listManager.registerList(new Bcommits(nvim, manager)))
  subscriptions.push(listManager.registerList(new Gfiles(nvim, manager)))
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

  subscriptions.push(workspace.registerKeymap(['o', 'x'] as any, 'git-chunk-inner', async () => {
    let diff = await manager.getCurrentChunk()
    if (!diff) return
    // diff.start
    await nvim.command(`normal! ${diff.start}GV${diff.end}G`)
  }, { sync: true, silent: true }))

  subscriptions.push(workspace.registerKeymap(['o', 'x'] as any, 'git-chunk-outer', async () => {
    let diff = await manager.getCurrentChunk()
    if (!diff) return
    let total = await nvim.call('line', ['$']) as number
    let start = Math.max(1, diff.start - 1)
    let end = Math.min(diff.end + 1, total)
    await nvim.command(`normal! ${start}GV${end}G`)
  }, { sync: true, silent: true }))

  return {
    git,
    resolver,
    manager
  }
}
