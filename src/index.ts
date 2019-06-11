import { listManager, languages, commands, events, ExtensionContext, workspace } from 'coc.nvim'
import { CompletionItem, CompletionItemKind, InsertTextFormat } from 'vscode-languageserver-types'
import which from 'which'
import Manager from './manager'
import Resolver from './resolver'
import GStatus from './lists/gstatus'
import Branches from './lists/branches'
import Commits from './lists/commits'
import Bcommits from './lists/bcommits'
import Gfiles from './lists/gfiles'
import addSource from './source'
import { DEFAULT_TYPES } from './constants'

function emptyFn(): void {
  // noop
}

export async function activate(context: ExtensionContext): Promise<void> {
  const { subscriptions } = context
  try {
    which.sync('git')
  } catch (e) {
    workspace.showMessage('git command required for coc-git', 'error')
    return
  }
  const { nvim } = workspace
  const resolver = new Resolver()
  const manager = new Manager(nvim, resolver)
  addSource(context, resolver)
  subscriptions.push(manager)

  Promise.all(workspace.documents.map(doc => {
    return resolver.resolveGitRoot(doc)
  })).then(() => {
    manager.refreshStatus().catch(emptyFn)
    for (let doc of workspace.documents) {
      manager.diffDocument(doc, true).catch(emptyFn)
    }
  }, emptyFn)

  workspace.onDidOpenTextDocument(async e => {
    let doc = workspace.getDocument(e.uri)
    await resolver.resolveGitRoot(doc)
    await Promise.all([manager.refreshStatus(), manager.diffDocument(doc, true)])
  }, null, subscriptions)

  workspace.onDidChangeTextDocument(async e => {
    let doc = workspace.getDocument(e.textDocument.uri)
    await manager.diffDocument(doc)
  }, null, subscriptions)
  // focusGained, BufEnter,ShellCmdPost

  async function refresh(bufnr: number): Promise<void> {
    let doc = workspace.getDocument(bufnr)
    if (!doc || doc.buftype != '') return
    await Promise.all([manager.refreshStatus(bufnr), manager.diffDocument(doc)])
  }
  events.on('BufEnter', async bufnr => {
    await refresh(bufnr)
  }, null, subscriptions)
  events.on('FocusGained', async () => {
    let bufnr = await nvim.call('bufnr', '%')
    await refresh(bufnr)
  }, null, subscriptions)

  subscriptions.push(workspace.registerAutocmd({
    event: 'ShellCmdPost',
    request: false,
    arglist: [`+expand('<abuf>')`],
    callback: refresh
  }))

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
  subscriptions.push(languages.registerCompletionItemProvider('semantic-commit', 'Commit', ['gitcommit'], {
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
}
