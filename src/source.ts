import { CompleteResult, fetch, Document, ExtensionContext, IList, ListContext, ListItem, listManager, SourceConfig, sources, workspace } from 'coc.nvim'
import colors from 'colors/safe'
import Resolver from './resolver'
import { safeRun } from './util'

interface Issue {
  id: number
  title: string
  createAt: Date
  creator: string
  body: string
  repo: string
  url: string
  shouldIncludeOrganizationNameAndRepoNameInAbbr?: boolean
}

const issuesMap: Map<number, Issue[]> = new Map()
function issuesFiletypes(): string[] {
  return workspace.getConfiguration().get<string[]>('coc.source.issues.filetypes')
}

function getOrganizationNameAndRepoNameFromGitHubRemoteUrl(remoteUrl: string): { organizationName: string, repoName: string } | null {
  try {
    const matchResult = remoteUrl.match(/github.com(:|\/)([^/]+)\/([^/]+)/)
    return {
      organizationName: matchResult[2],
      repoName: matchResult[3].replace(/\.git$/, ''),
    }
  } catch (e) {
    return null
  }
}

function renderWord(issue: Issue, issueFormat: string): string {
  return issueFormat.split(/(%i|%o|%r|%b|%t|%c|%a|%u)/).map(part => {
    switch (part) {
      case '%i': return issue.id
      case '%o': return issue.repo.split('/')[0]
      case '%r': return issue.repo.split('/')[1]
      case '%b': return issue.body
      case '%t': return issue.title
      case '%c': return issue.createAt
      case '%a': return issue.creator
      case '%u': return issue.url
      default: return part
    }
  }).join('')
}

export default function addSource(context: ExtensionContext, resolver: Resolver): void {
  let { subscriptions, logger } = context
  let statusItem = workspace.createStatusBarItem(0, { progress: true })
  statusItem.text = 'loading issues'
  let statusItemCounter = 0

  function onStartLoading(): void {
    statusItemCounter++
    if (statusItemCounter === 1) {
      statusItem.show()
    }
  }

  function onEndLoading(): void {
    statusItemCounter--
    if (statusItemCounter === 0) {
      statusItem.hide()
    }
  }

  function onError(err): void {
    logger.error(err)
  }

  async function loadGitLabIssues(res: string, host: string): Promise<Issue[]> {
    const token = process.env['GITLAB_PRIVATE_TOKEN']
    if (!token) return []

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

    const uri = `https://${host}/api/v4/projects/${encodeURIComponent(repo)}/issues`
    onStartLoading()
    let issues: Issue[] = []
    try {
      let info = await fetch(uri, { headers: { 'Private-Token': token } })
      for (let i = 0, len = info.length; i < len; i++) {
        issues.push({
          id: info[i].iid,
          title: info[i].title,
          createAt: new Date(info[i].created_at),
          creator: info[i].author.username,
          body: info[i].description,
          repo,
          url: `https://${host}/${repo}/issues/${info[i].iid}`
        })
      }
    } catch (e) {
      logger.error(`Request GitLab ${host} issues error:`, e)
    }
    onEndLoading()
    return issues
  }

  async function loadGitHubIssues(organizationName: string, repoName: string, shouldIncludeOrganizationNameAndRepoNameInAbbr = false): Promise<Issue[]> {
    const headers = {}
    if (process.env.GITHUB_API_TOKEN) {
      headers['Authorization'] = `token ${process.env.GITHUB_API_TOKEN}`
    }
    const repo = `${organizationName}/${repoName}`
    const uri = `https://api.github.com/repos/${repo}/issues?scope=all&per_page=100`
    onStartLoading()
    let issues: Issue[] = []
    let page_idx = 1
    while (true) {
      let page_uri = `${uri}&page=${page_idx}`
      page_idx++
      try {
        let info = await fetch(page_uri, { headers })
        console.log(JSON.stringify(info, null, 2))
        if (info.length == 0) {
          break
        }
        for (let i = 0, len = info.length; i < len; i++) {
          issues.push({
            id: info[i].number,
            title: info[i].title,
            createAt: new Date(info[i].created_at),
            creator: info[i].user.login,
            body: info[i].body,
            repo,
            url: `https://github.com/${repo}/issues/${info[i].number}`,
            shouldIncludeOrganizationNameAndRepoNameInAbbr,
          })
        }
      } catch (e) {
        logger.error(`Request github issues error:`, e)
        break
      }
    }
    onEndLoading()
    return issues
  }

  async function loadIssues(root: string): Promise<Issue[]> {
    let config = workspace.getConfiguration('git')
    const issueSources = (await safeRun(`git config --get coc-git.issuesources`, { cwd: root }) || '').trim()
    if (issueSources) {
      return Array.prototype.concat.apply([],
        await Promise.all(issueSources.split(',').map(issueSource => {
          const [issueProvider, organizationName, repoName] = (issueSource + '//').split('/').slice(0, 3)
          switch (issueProvider) {
            case 'github': return loadGitHubIssues(organizationName, repoName, true)
            default: return []
          }
        }))
      )
    }

    let remoteName = config.get<string>('remoteName', 'origin')
    let res = await safeRun(`git remote get-url ${remoteName}`, { cwd: root })
    res = res.trim()
    if (res.indexOf('github.com') > 0) {
      const organizationNameAndRepoName = getOrganizationNameAndRepoNameFromGitHubRemoteUrl(res)
      if (organizationNameAndRepoName === null) {
        return []
      }
      return loadGitHubIssues(organizationNameAndRepoName.organizationName, organizationNameAndRepoName.repoName)
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

  const loadIssuesFromDocument = (doc: Document) => {
    resolver.resolveGitRoot(doc).then(async root => {
      if (root) {
        let issues = await loadIssues(root)
        issuesMap.set(doc.bufnr, issues)
      }
    }).catch(onError)
  }
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
      const config = workspace.getConfiguration('git')
      const issueFormat = config.get<string>('issueFormat', '#%i')
      if (opt.triggerCharacter && opt.triggerCharacter == '#') {
        let issues = issuesMap.get(opt.bufnr)
        if (!issues || issues.length == 0) return null
        return {
          startcol: opt.col - 1,
          items: issues.map(i => {
            return {
              word: renderWord(i, issueFormat),
              menu: `${i.title} ${this.shortcut}`,
              abbr: `${i.shouldIncludeOrganizationNameAndRepoNameInAbbr ? i.repo : ''}#${i.id}`,
              info: i.body,
              filterText: '#' + i.id + i.title,
              sortText: String.fromCharCode(65535 - i.id)
            }
          })
        }
      }
      return {
        items: ['BREAKING CHANGE: ', 'Closes'].map(s => {
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
        let { url } = item.data
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
    description: 'issues on github/gitlab',
    loadItems: async (context): Promise<ListItem[]> => {
      let buf = await context.window.buffer
      let root = await resolver.resolveGitRoot(workspace.getDocument(buf.id))
      if (!root) return []
      let issues = await loadIssues(root)
      return issues.map(o => {
        return {
          label: `${colors.red('#' + o.id.toFixed(0))} ${o.title} (${colors.green(o.createAt.toUTCString())}) <${colors.blue(o.creator)}>`,
          data: { id: o.id, url: o.url, body: o.body }
        } as ListItem
      })
    }
  }
  subscriptions.push(listManager.registerList(list))
}
