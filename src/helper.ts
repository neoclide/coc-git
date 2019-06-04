import { Uri, workspace } from 'coc.nvim'

export function getUrl(remote: string, branch: string, filepath: string, lines?: number[] | string): string {
  let uri = remote.replace(/\.git$/, '')
  if (uri.startsWith('git')) {
    let str = uri.slice(4)
    let parts = str.split(':', 2)
    uri = `https://${parts[0]}/${parts[1]}`
  }
  let u = Uri.parse(uri)
  if (u.authority.startsWith('github.com')) {
    let anchor = ''
    if (lines && Array.isArray(lines)) {
      anchor = lines ? lines.map(l => `L${l}`).join('-') : ''
    } else if (typeof lines == 'string') {
      anchor = lines
    }
    return uri + '/blob/' + branch + '/' + filepath + (anchor ? '#' + anchor : '')
  }
  workspace.showMessage(`Can't get url form: ${u.authority}`, 'warning')
  return ''
}
