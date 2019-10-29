import { commands, events, ExtensionContext, languages, listManager, workspace } from 'coc.nvim'
import { CompletionItem, CompletionItemKind, InsertTextFormat } from 'vscode-languageserver-types'
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

function emptyFn(): void {
  // noop
}

export async function activate(context: ExtensionContext): Promise<void> {
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

  function updateAll(): void {
    manager.refreshStatus().catch(emptyFn)
    for (let doc of workspace.documents) {
      manager.diffDocument(doc, true).catch(emptyFn)
    }
  }

  Promise.all(workspace.documents.map(doc => {
    return resolver.resolveGitRoot(doc)
  })).then(updateAll, emptyFn)

  workspace.onDidOpenTextDocument(async e => {
    let doc = workspace.getDocument(e.uri)
    await resolver.resolveGitRoot(doc)
    await Promise.all([manager.refreshStatus(), manager.diffDocument(doc, true)])
  }, null, subscriptions)

  workspace.onDidChangeTextDocument(async e => {
    let doc = workspace.getDocument(e.textDocument.uri)
    await manager.diffDocument(doc)
  }, null, subscriptions)

  events.on('BufWritePost', bufnr => {
    let doc = workspace.getDocument(bufnr)
    if (doc.uri.startsWith('fugitive:') || doc.uri.endsWith("COMMIT_EDITMSG")) {
      updateAll()
    }
  }, null, subscriptions)

  events.on('CursorHold', async bufnr => {
    let doc = workspace.getDocument(bufnr)
    if (!doc || doc.buftype != '') return
    await Promise.all([manager.refreshStatus(bufnr), manager.diffDocument(doc)])
  }, null, subscriptions)
  events.on('BufEnter', async bufnr => {
    let doc = workspace.getDocument(bufnr)
    if (!doc || doc.buftype != '') return
    await Promise.all([manager.refreshStatus(bufnr), manager.diffDocument(doc)])
  }, null, subscriptions)

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

  subscriptions.push(commands.registerCommand('git.copyUrl', async () => {
    await manager.browser('copy')
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
    provideCompletionItems: async (_document, position): Promise<CompletionItem[]> => {
      if (position.line == 0 && position.character <= 1) {
        return DEFAULT_TYPES.map(o => {
          return {
            label: o.value,
            kind: CompletionItemKind.Snippet,
            documentation: { kind: 'plaintext', value: o.name },
            // detail: o.name,
            insertTextFormat: InsertTextFormat.Snippet,
            // tslint:disable-next-line: no-invalid-template-strings
            insertText: o.value + '(${1:scope}): ' + '${2:commit}\n\n'
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
}
