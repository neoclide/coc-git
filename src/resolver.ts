import { Document, Uri, workspace } from 'coc.nvim'
import { promisify } from 'util'
import path from 'path'
import Git from './git'
import fs from 'fs'

async function getRealPath(fullpath: string): Promise<string> {
  try {
    let res = await promisify(fs.realpath)(fullpath, 'utf8')
    return res
  } catch (e) {
    // noop
  }
  return fullpath
}

export default class Resolver {
  private resolvedRoots: Map<string, string> = new Map()
  constructor(private git: Git) {
  }

  private getGitRoot(dir: string): string | null {
    if (process.platform == 'win32') {
      dir = path.win32.normalize(dir)
    }
    return this.resolvedRoots.get(dir)
  }

  public async resolveGitRoot(doc?: Document): Promise<string> {
    let dir: string
    if (!doc || doc.buftype != '' || doc.schema != 'file') {
      dir = await getRealPath(workspace.cwd)
    } else {
      let fullpath = await getRealPath(Uri.parse(doc.uri).fsPath)
      dir = path.dirname(fullpath)
    }
    if (process.platform == 'win32') {
      dir = path.win32.normalize(dir)
    }
    let root = this.getGitRoot(dir)
    if (root) return root
    let parts = dir.split(path.sep)
    let idx = parts.indexOf('.git')
    if (idx !== -1) {
      let root = parts.slice(0, idx).join(path.sep)
      this.resolvedRoots.set(dir, root)
      return root
    }
    try {
      let res = await this.git.getRepositoryRoot(dir)
      if (path.isAbsolute(res)) {
        this.resolvedRoots.set(dir, res)
        return res
      }
    } catch (e) {
      return null
    }
  }
}
