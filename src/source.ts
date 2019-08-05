import { CompleteResult, Document, ExtensionContext, IList, ListContext, ListItem, listManager, SourceConfig, sources, workspace } from 'coc.nvim'
import colors from 'colors/safe'
import { configure as configureHttpRequests, xhr } from 'request-light'
import Resolver from './resolver'
import { safeRun } from './util'

interface Issue {
  id: number
  title: string
  createAt: Date
  creator: string
  body: string
  repo: string
}

const issuesMap: Map<number, Issue[]> = new Map()

function configure(): void {
  let httpConfig = workspace.getConfiguration('http')
  configureHttpRequests(httpConfig.get<string>('proxy', undefined), httpConfig.get<boolean>('proxyStrictSSL', undefined))
}

function issuesFiletypes(): string[] {
  return workspace.getConfiguration().get<string[]>('coc.source.issues.filetypes')
}

export default function addSource(context: ExtensionContext, resolver: Resolver): void {
  let { subscriptions, logger } = context
  let statusItem = workspace.createStatusBarItem(0, { progress: true })
  statusItem.text = 'loading issues'

  function onError(err): void {
    logger.error(err)
  }

  async function loadGitLabIssues(res: string, host: string): Promise<Issue[]> {
    const token = process.env['GITLAB_PRIVATE_TOKEN']
    if (!token) {
      return []
    }

    let repo: string
    if (res.startsWith('https')) {
      const re = new RegExp(`^https:\\/\\/${host}\\/(.*)`)
      let ms = res.match(re)
      repo = ms ? ms[1].replace(/\.git$/, '') : null
    } else if (res.startsWith('git')) {
      const re = new RegExp(`git@${host}:(.*)`)
      let ms = res.match(re)
      repo = ms ? ms[1].replace(/\.git$/, '') : null
    }
    if (!repo) {
      return []
    }

    const headers = {
      'Private-Token': token,
      'Accept-Encoding': 'gzip, deflate',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/74.0.3729.169 Safari/537.36'
    }
    const uri = `http://${host}/api/v4/projects/${encodeURIComponent(repo)}/issues`
    statusItem.show()
    let issues: Issue[] = []
    try {
      let response = await xhr({ url: uri, followRedirects: 5, headers })
      let { responseText } = response
      let info = JSON.parse(responseText)
      for (let i = 0, len = info.length; i < len; i++) {
        issues.push({
          id: info[i].id,
          title: info[i].title,
          createAt: new Date(info[i].created_at),
          creator: info[i].author.username,
          body: info[i].description,
          repo
        })
      }
    } catch (e) {
      logger.error(`Request GitLab ${host} issues error:`, e)
    }
    statusItem.hide()
    return issues
  }

  async function loadGitHubIssues(res: string): Promise<Issue[]> {
    let repo: string
    if (res.startsWith('https')) {
      let ms = res.match(/^https:\/\/github\.com\/(.*)/)
      repo = ms ? ms[1].replace(/\.git$/, '') : null
    } else if (res.startsWith('git')) {
      let ms = res.match(/git@github\.com:(.*)/)
      repo = ms ? ms[1].replace(/\.git$/, '') : null
    }
    if (!repo) {
      return []
    }

    const headers = {
      'Accept-Encoding': 'gzip, deflate',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/74.0.3729.169 Safari/537.36'
    }
    const uri = `https://api.github.com/repos/${repo}/issues`
    statusItem.show()
    let issues: Issue[] = []
    try {
      let response = await xhr({ url: uri, followRedirects: 5, headers })
      let { responseText } = response
      let info = JSON.parse(responseText)
      for (let i = 0, len = info.length; i < len; i++) {
        issues.push({
          id: info[i].number,
          title: info[i].title,
          createAt: new Date(info[i].created_at),
          creator: info[i].user.login,
          body: info[i].body,
          repo
        })
      }
    } catch (e) {
      logger.error(`Request github issues error:`, e)
    }
    statusItem.hide()
    return issues
  }

  async function loadIssues(root: string): Promise<Issue[]> {
    let config = workspace.getConfiguration('git')
    let remoteName = config.get<string>('remoteName', 'origin')
    let res = await safeRun(`git remote get-url ${remoteName}`, { cwd: root })
    res = res.trim()
    if (res.indexOf('github.com') > 0) {
      return loadGitHubIssues(res)
    }

    let host = ''
    let hosts = config.get<string[]>('gitlab.hosts', [])
    hosts.forEach(item => {
      if (res.indexOf(item) > 0) {
        host = item
      }
    })

    if (host && host.length > 0) {
      return loadGitLabIssues(res, host)
    }

    return []
  }

  configure()
  const loadIssuesFromDocument = (doc: Document) => {
    resolver.resolveGitRoot(doc).then(async root => {
      if (root) {
        let issues = await loadIssues(root)
        issuesMap.set(doc.bufnr, issues)
      }
    }).catch(onError)
  }
  workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('http')) {
      configure()
    }
  }, null, subscriptions)
  for (let doc of workspace.documents) {
    if (issuesFiletypes().includes(doc.filetype)) {
      loadIssuesFromDocument(doc)
    }
  }
  workspace.onDidOpenTextDocument(async e => {
    if (issuesFiletypes().includes(e.languageId)) {
      let doc = workspace.getDocument(e.uri)
      loadIssuesFromDocument(doc)
    }
  }, null, subscriptions)

  let source: SourceConfig = {
    name: 'issues',
    filetypes: ['gitcommit', 'gina-commit'],
    triggerCharacters: ['#'],
    async doComplete(opt): Promise<CompleteResult> {
      if (opt.triggerCharacter && opt.triggerCharacter == '#') {
        let issues = issuesMap.get(opt.bufnr)
        if (!issues || issues.length == 0) return null
        return {
          startcol: opt.col - 1,
          items: issues.map(i => {
            return {
              word: `#${i.id}`,
              menu: `${i.title} ${this.shortcut}`,
              filterText: '#' + i.id + i.title,
              sortText: String.fromCharCode(65535 - i.id)
            }
          })
        }
      }
      return {
        items: ['BREAK CHANGE: ', 'Closes'].map(s => {
          return { word: s }
        })
      }
    }
  }
  subscriptions.push(sources.createSource(source))

  let list: IList = {
    name: 'issues',
    actions: [{
      name: 'open',
      execute: async (item: ListItem) => {
        let { id, repo } = item.data
        let url = `https://github.com/${repo}/issues/${id}`
        await workspace.openResource(url)
      },
      multiple: false
    }, {
      name: 'preview',
      execute: async (item: ListItem, context: ListContext) => {
        let winid = context.listWindow.id
        let { body, id } = item.data
        let lines = body.split(/\r?\n/)
        let mod = context.options.position == 'top' ? 'below' : 'above'
        let { nvim } = workspace
        nvim.pauseNotification()
        nvim.command('pclose', true)
        nvim.command(`${mod} ${lines.length}sp +setl\\ previewwindow [issue ${id}]`, true)
        nvim.command('setl winfixheight buftype=nofile foldmethod=syntax foldenable', true)
        nvim.command('setl nobuflisted bufhidden=wipe', true)
        nvim.command('setf markdown', true)
        nvim.call('append', [0, lines], true)
        nvim.command('normal! Gdd', true)
        nvim.command(`exe 1`, true)
        nvim.call('win_gotoid', [winid], true)
        await nvim.resumeNotification()
      },
      multiple: false
    }],
    defaultAction: 'open',
    description: 'issues on github',
    loadItems: async (context): Promise<ListItem[]> => {
      let buf = await context.window.buffer
      let root = await resolver.resolveGitRoot(workspace.getDocument(buf.id))
      if (!root) return []
      let issues = await loadIssues(root)
      return issues.map(o => {
        return {
          label: `${colors.red('#' + o.id.toFixed(0))} ${o.title} (${colors.green(o.createAt.toUTCString())}) <${colors.blue(o.creator)}>`,
          data: { id: o.id, repo: o.repo, body: o.body }
        } as ListItem
      })
    }
  }
  subscriptions.push(listManager.registerList(list))
}
