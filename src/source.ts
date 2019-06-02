import { Document, sources, ExtensionContext, workspace, SourceConfig, CompleteResult } from 'coc.nvim'
import { configure as configureHttpRequests, xhr } from 'request-light'
import Resolver from './resolver'
import { safeRun } from './util'

interface Issue {
  id: number
  title: string
  createAt: Date
}

const issuesMap: Map<number, Issue[]> = new Map()

function configure(): void {
  let httpConfig = workspace.getConfiguration('http')
  configureHttpRequests(httpConfig.get<string>('proxy', undefined), httpConfig.get<boolean>('proxyStrictSSL', undefined))
}

export default function addSource(context: ExtensionContext, resolver: Resolver): void {
  let { subscriptions, logger } = context
  let statusItem = workspace.createStatusBarItem(0, { progress: true })
  statusItem.text = 'loading issues'

  function onError(err): void {
    logger.error(err)
  }

  async function loadIssues(doc: Document): Promise<void> {
    let root = await resolver.resolveGitRoot(doc)
    if (!root) return
    let config = workspace.getConfiguration('git')
    let remoteName = config.get<string>('remoteName', 'origin')
    let res = await safeRun(`git remote get-url ${remoteName}`, { cwd: root })
    res = res.trim()
    if (res.indexOf('github.com') == -1) return
    let repo: string
    if (res.startsWith('https')) {
      let ms = res.match(/^https:\/\/github\.com\/(.*)\.git/)
      repo = ms ? ms[1] : null
    } else if (res.startsWith('git')) {
      let ms = res.match(/git@github\.com:(.*)\.git/)
      repo = ms ? ms[1] : null
    }
    if (!repo) return
    const headers = {
      'Accept-Encoding': 'gzip, deflate',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/74.0.3729.169 Safari/537.36'
    }
    const uri = `https://api.github.com/repos/${repo}/issues`
    statusItem.show()
    try {
      let response = await xhr({ url: uri, followRedirects: 5, headers })
      let { responseText } = response
      let info = JSON.parse(responseText)
      let issues: Issue[] = []
      for (let i = 0, len = info.length; i < len; i++) {
        issues.push({
          id: info[i].number,
          title: info[i].title,
          createAt: new Date(info[i].created_at)
        })
      }
      issuesMap.set(doc.bufnr, issues)
    } catch (e) {
      logger.error(`Request github issues error:`, e)
    }
    statusItem.hide()
  }

  configure()
  workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('http')) {
      configure()
    }
  }, null, subscriptions)
  for (let doc of workspace.documents) {
    if (doc.filetype == 'gitcommit') {
      loadIssues(doc).catch(onError)
    }
  }
  workspace.onDidOpenTextDocument(async e => {
    if (e.languageId == 'gitcommit') {
      loadIssues(workspace.getDocument(e.uri)).catch(onError)
    }
  }, null, subscriptions)

  let source: SourceConfig = {
    name: 'github',
    shortcut: "I",
    filetypes: ['gitcommit'],
    priority: 99,
    triggerOnly: true,
    triggerCharacters: ['#'],
    async doComplete(opt): Promise<CompleteResult> {
      let issues = issuesMap.get(opt.bufnr)
      if (!issues || issues.length == 0) return null
      return {
        items: issues.map(i => {
          return {
            word: `${i.id}`,
            abbr: `#${i.id} ${i.title}`,
            filterText: i.id + i.title,
            sortText: String.fromCharCode(65535 - i.id)
          }
        })
      }
    }
  }
  subscriptions.push(sources.createSource(source))
}
