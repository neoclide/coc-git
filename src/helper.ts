import { Uri, workspace } from 'coc.nvim'

export function getUrl(remote: string, branch: string, filepath: string, line?: number): string {
  let uri = remote.replace(/\.git$/, '')
  if (uri.startsWith('git')) {
    let str = uri.slice(4)
    let parts = str.split(':', 2)
    uri = `https://${parts[0]}/${parts[1]}`
  }
  let u = Uri.parse(uri)
  if (u.authority.startsWith('github.com')) {
    return uri + '/blob/' + branch + '/' + filepath + (line ? '#L' + line : '')
  }
  workspace.showMessage(`Can't get url form: ${u.authority}`)
  return ''
}
