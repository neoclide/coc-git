import { OutputChannel, Uri, workspace } from 'coc.nvim'
import fs from 'fs'
import path from 'path'
import { promisify } from 'util'
import Git from './git'

export interface GitDocument {
  uri: string
  buftype: string
  schema: string
}

async function getRealPath(fullpath: string): Promise<string> {
  let resolved: string
  try {
    resolved = await promisify(fs.realpath)(fullpath, 'utf8')
  } catch (e) {
    if (e.message.includes('ENOENT')) {
      try {
        resolved = await workspace.nvim.call('expand', [fullpath]) as string
      } catch (e) {
        // noop
      }
    }
  }
  return resolved || fullpath
}

export default class Resolver {
  private resolvedRoots: Map<string, string> = new Map()
  private relativePaths: Map<string, string> = new Map()
  constructor(private git: Git, private channel: OutputChannel) {
  }

  public delete(uri: string): void {
    this.resolvedRoots.delete(uri)
    this.relativePaths.delete(uri)
  }

  public clear(): void {
    this.resolvedRoots.clear()
    this.relativePaths.clear()
  }

  public getRelativePath(uri: string): string | undefined {
    return this.relativePaths.get(uri)
  }

  public async resolveGitRoot(doc?: GitDocument): Promise<string | null> {
    if (!doc) return null

    let root: string
    const { uri } = doc

    root = this.resolvedRoots.get(uri)
    if (root) return root

    // Support using `acwrite` with `BufWriteCmd` to create gitcommit, e.g. gina.vim
    if (doc.buftype == 'acwrite') {
      root = await this.resolveRootFromCwd()
      this.resolvedRoots.set(uri, root)
      return root
    }

    if (doc.buftype != '' || doc.schema != 'file') {
      return null
    }
    let fullpath = await getRealPath(Uri.parse(uri).fsPath)
    if (process.platform == 'win32') {
      fullpath = path.win32.normalize(fullpath)
    }
    if (!root) {
      let parts = fullpath.split(path.sep)
      let idx = parts.indexOf('.git')
      if (idx !== -1) {
        root = parts.slice(0, idx).join(path.sep)
        this.resolvedRoots.set(uri, root)
      } else {
        try {
          root = await this.git.getRepositoryRoot(path.dirname(fullpath))
          if (path.isAbsolute(root)) {
            this.resolvedRoots.set(uri, root)
          } else {
            root = undefined
          }
        } catch (e) {
          // Noop
        }
      }
    }
    if (root) {
      this.relativePaths.set(uri, path.relative(root, fullpath))
    }
    this.channel.appendLine(`resolved root of ${fullpath}: ${root}`)
    return root
  }

  public async resolveRootFromCwd(): Promise<string | null> {
    let parts = workspace.cwd.split(path.sep)
    let idx = parts.indexOf('.git')
    if (idx !== -1) return parts.slice(0, idx).join(path.sep)
    try {
      return await this.git.getRepositoryRoot(workspace.cwd)
    } catch (e) {
      // Noop
    }
    return null
  }

  public dispose(): void {
    this.resolvedRoots.clear()
    this.relativePaths.clear()
  }
}
