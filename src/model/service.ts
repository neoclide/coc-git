import { Document, FloatFactory, OutputChannel, Uri, window, workspace } from 'coc.nvim'
import { GitConfiguration } from '../types'
import { IGit } from '../util'
import GitBuffer from './buffer'
import Git from './git'
import GitRepo from './repo'
import GitResolver from './resolver'

const uriToRoot: Map<string, string> = new Map()

export default class GitService {
  private _git: Git
  private _resolver: GitResolver
  private repos: Map<string, GitRepo> = new Map()
  private outputChannel: OutputChannel
  private floatFactory: FloatFactory | undefined
  constructor(gitInfo: IGit) {
    const outputChannel = this.outputChannel = window.createOutputChannel('git')
    this._git = new Git(gitInfo, outputChannel)
    this._resolver = new GitResolver(this._git, outputChannel)
    if (typeof window.createFloatFactory === 'function') {
      this.floatFactory = window.createFloatFactory({ modes: ['n'] })
    }
  }

  public getRepoFromRoot(root: string | undefined): GitRepo {
    if (!root) return undefined
    if (this.repos.has(root)) {
      return this.repos.get(root)
    }
    let gitRepo = new GitRepo(this._git, this.outputChannel, root)
    this.repos.set(root, gitRepo)
    return gitRepo
  }

  public async createBuffer(doc: Document, config: GitConfiguration): Promise<GitBuffer | undefined> {
    if (!doc || !doc.attached) return undefined
    let root = await this.resolver.resolveGitRoot(doc)
    if (!root) return undefined
    let repo = this.getRepoFromRoot(root)
    let relpath = this.resolver.getRelativePath(doc.uri)
    if (!relpath) return undefined
    let ignored = await repo.isIgnored(relpath)
    if (ignored) return undefined
    uriToRoot.set(doc.uri, root)
    let hasConflicts = await repo.hasConflicts(relpath)
    return new GitBuffer(doc, config, relpath, repo, this.git, this.outputChannel, this.floatFactory, hasConflicts)
  }

  public async getCurrentRepo(): Promise<GitRepo | undefined> {
    let editor = window.activeTextEditor
    let root: string | undefined
    if (editor) {
      let { uri } = editor.document
      root = uriToRoot.get(uri)
      if (!root) {
        root = await this.resolver.resolveGitRoot(editor.document)
      }
    } else {
      let cwd = workspace.cwd
      root = await this.resolver.resolveGitRoot({ uri: Uri.file(cwd).toString(), schema: 'file', buftype: '' })
    }
    if (root == null) return undefined
    return this.getRepoFromRoot(root)
  }

  public get resolver(): GitResolver {
    return this._resolver
  }

  public get git(): Git {
    return this._git
  }

  public log(text: string): void {
    this.outputChannel.appendLine(text)
  }

  public dispose(): void {
    this.floatFactory?.dispose()
    this._resolver.dispose()
    this.outputChannel.dispose()
    this.repos.clear()
  }
}
