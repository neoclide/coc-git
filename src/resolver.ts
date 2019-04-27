import { Document, workspace, Uri } from 'coc.nvim'
import path from 'path'
import { runCommand } from './util'

export default class Resolver {
  private resolvedRoots: Set<string> = new Set()

  public getGitRoot(fullpath: string): string | null {
    for (let p of this.resolvedRoots) {
      if (fullpath.toLowerCase().startsWith(p.toLowerCase())) return p
    }
    return null
  }

  public getRootOfDocument(document: Document): string | null {
    if (document.schema != 'file' || document.buftype != '') return null
    return this.getGitRoot(Uri.parse(document.uri).fsPath)
  }

  public async resolveGitRoot(doc?: Document): Promise<string> {
    let dir: string
    if (!doc || doc.buftype != '' || doc.schema != 'file') {
      dir = workspace.cwd
    } else {
      let u = Uri.parse(doc.uri)
      dir = path.dirname(u.fsPath)
    }
    let root = this.getGitRoot(dir)
    if (root) return root
    try {
      let res = await runCommand('git rev-parse --show-toplevel', { cwd: dir })
      if (path.isAbsolute(res.trim())) {
        this.resolvedRoots.add(res.trim())
        return res.trim()
      }
    } catch (e) {
      return
    }
  }
}
