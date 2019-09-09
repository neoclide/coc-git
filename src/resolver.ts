import { Document, Uri, workspace } from 'coc.nvim'
import path from 'path'
import Git from './git'
import fs from 'fs'

function getRealPath(fullpath: string): string {
  try {
    let res = fs.realpathSync(fullpath, 'utf8')
    return res
  } catch (e) {
    // noop
  }
  return fullpath
}

export default class Resolver {
  private resolvedRoots: Set<string> = new Set()
  constructor(private git: Git) {
  }

  public getGitRoot(fullpath: string): string | null {
    fullpath = getRealPath(fullpath)
    if (process.platform == 'win32') {
      fullpath = path.win32.normalize(fullpath)
    }
    for (let p of this.resolvedRoots) {
      let rel = path.relative(p, fullpath)
      if (!rel.startsWith('..')) return p
    }
    return null
  }

  public getRootOfDocument(document: Document): string | null {
    if (document.schema != 'file' || document.buftype != '') return null
    let fullpath = Uri.parse(document.uri).fsPath
    return this.getGitRoot(fullpath)
  }

  public async resolveGitRoot(doc?: Document): Promise<string> {
    let dir: string
    if (!doc || doc.buftype != '' || doc.schema != 'file') {
      dir = workspace.cwd
    } else {
      let fullpath = Uri.parse(doc.uri).fsPath
      dir = path.dirname(getRealPath(fullpath))
    }
    let root = this.getGitRoot(dir)
    if (root) return root
    let parts = dir.split(path.sep)
    let idx = parts.indexOf('.git')
    if (idx !== -1) {
      let root = parts.slice(0, idx).join(path.sep)
      this.resolvedRoots.add(root)
      return root
    }
    try {
      let res = await this.git.getRepositoryRoot(dir)
      if (path.isAbsolute(res)) {
        this.resolvedRoots.add(res)
        return res
      }
    } catch (e) {
      return
    }
  }
}
