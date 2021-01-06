import { OutputChannel, window, workspace, Uri, Document, FloatFactory } from 'coc.nvim'
import GitRepo from './repo'
import Git from './git'
import GitResolver from './resolver'
import GitBuffer from './buffer'
import { IGit } from '../util'
import path from 'path'
import { GitConfiguration } from '../types'

export default class GitService {
  private _git: Git
  private _resolver: GitResolver
  private repos: Map<string, GitRepo> = new Map()
  private outputChannel: OutputChannel
  private floatFactory: FloatFactory
  constructor(gitInfo: IGit) {
    const outputChannel = this.outputChannel = window.createOutputChannel('git')
    this._git = new Git(gitInfo, outputChannel)
    this._resolver = new GitResolver(this._git, outputChannel)
    this.floatFactory = new FloatFactory(workspace.nvim)
  }

  public getRepoFromRoot(root: string): GitRepo {
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
    return new GitBuffer(doc, config, relpath, repo, this.git, this.outputChannel, this.floatFactory)
  }

  public async getCurrentRepo(): Promise<GitRepo | undefined> {
    let { nvim } = workspace
    let [fullpath, buftype] = await nvim.eval('[expand("%:p"),&buftype]') as [string, string]
    if (!path.isAbsolute(fullpath) || buftype != '') return undefined
    let root = await this.resolver.resolveGitRoot({ uri: Uri.file(fullpath).toString(), schema: 'file', buftype: '' })
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
    this.floatFactory.dispose()
    this._resolver.dispose()
    this.outputChannel.dispose()
    this.repos.clear()
  }
}
