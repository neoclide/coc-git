import { exec, spawn } from 'child_process'
import { Event, Neovim, window } from 'coc.nvim'
import { BlameInfo, StageChunk } from './types'
import path from 'path'
import which from 'which'

export interface IGit {
  path: string
  version: string
}

function reverseLine(line: string): string {
  if (line.startsWith('-')) return '+' + line.slice(1)
  if (line.startsWith('+')) return '-' + line.slice(1)
  return line
}

export function quoteGitPath(filepath: string): string {
  if (!/[\s"\\\x00-\x1f\x7f]/.test(filepath)) return filepath
  return `"${filepath.replace(/["\\\x00-\x1f\x7f]/g, character => {
    switch (character) {
      case '"': return '\\"'
      case '\\': return '\\\\'
      case '\t': return '\\t'
      case '\n': return '\\n'
      case '\r': return '\\r'
      default: return `\\${character.charCodeAt(0).toString(8).padStart(3, '0')}`
    }
  })}"`
}

export function createUnstagePatch(relpath: string, chunk: StageChunk): string {
  if (chunk.remove.count == 0 && chunk.add.count == 0) return ''
  let head = `@@ -${chunk.add.lnum},${chunk.add.count} +${chunk.remove.lnum},${chunk.remove.count} @@`
  if (!head) return ''
  const from = quoteGitPath(`a/${relpath}`)
  const to = quoteGitPath(`b/${relpath}`)
  const lines = [
    `diff --git ${from} ${to}`,
    `index 000000..000000 100644`,
    `--- ${from}`,
    `+++ ${to}`,
    head
  ]
  lines.push(...chunk.lines.map(s => reverseLine(s)))
  lines.push('')
  return lines.join('\n')
}

export function formatBlameText(info: BlameInfo, format = '(%a %t) %s'): string {
  let { author = '', time = '', summary = '', sha = '' } = info
  return format
    .replace(/%%/g, '\u0000')
    .replace(/%a/g, author)
    .replace(/%t/g, time)
    .replace(/%s/g, summary)
    .replace(/%S/g, sha.substring(0, 7))
    .replace(/\u0000/g, '%')
}

export function toUnixSlash(fsPath: string): string {
  if (process.platform == 'win32') {
    return fsPath.replace(/\\/g, '/')
  }
  return fsPath
}

export function spawnCommand(cmd: string, args: string[], cwd: string): Promise<string> {
  const cp = spawn(cmd, args, { cwd })
  let res = ''
  return new Promise((resolve, reject) => {
    cp.on('error', reject)
    cp.stdout.on('data', data => {
      res += data.toString()
    })
    cp.stderr.on('data', data => {
      window.showErrorMessage(`"${cmd} ${args.join(' ')}" error: ${data.toString()}`)
    })
    cp.on('close', code => {
      if (code != 0) {
        return reject(new Error(`${cmd} exited with code ${code}`))
      }
      resolve(res)
    })
  })
}

export function equals(one: any, other: any): boolean {
  if (one === other) {
    return true
  }
  if (
    one === null ||
    one === undefined ||
    other === null ||
    other === undefined
  ) {
    return false
  }
  if (typeof one !== typeof other) {
    return false
  }
  if (typeof one !== 'object') {
    return false
  }
  if (Array.isArray(one) !== Array.isArray(other)) {
    return false
  }

  let i: number
  let key: string

  if (Array.isArray(one)) {
    if (one.length !== other.length) {
      return false
    }
    for (i = 0; i < one.length; i++) {
      if (!equals(one[i], other[i])) {
        return false
      }
    }
  } else {
    const oneKeys: string[] = []

    for (key in one) { // tslint:disable-line
      oneKeys.push(key)
    }
    oneKeys.sort()
    const otherKeys: string[] = []
    for (key in other) { // tslint:disable-line
      otherKeys.push(key)
    }
    otherKeys.sort()
    if (!equals(oneKeys, otherKeys)) {
      return false
    }
    for (i = 0; i < oneKeys.length; i++) {
      if (!equals(one[oneKeys[i]], other[oneKeys[i]])) {
        return false
      }
    }
  }
  return true
}

export function getRepoUrl(remote: string): string | null {
  // Remote is local directory
  if (path.isAbsolute(remote)) return null
  let url = remote.replace(/\s+$/, '').replace(/\.git$/, '')
  if (url.startsWith('git@')) {
    let str = url.slice(4)
    let parts = str.split(':', 2)
    url = `https://${parts[0]}/${parts[1]}`
  } else if (url.startsWith('ssh://git@')) {
    url = url.replace(/^ssh:\/\/git@([^/]+)\//, 'https://$1/')
  } else if (url.startsWith('git://')) {
    url = url.replace(/^git:\/\//, 'https://')
  }
  return /^https?:\/\//.test(url) ? url : null
}

export function getUrl(fix: string, repoURL: string, name: string, filepath: string, lines?: number[] | string): string {
  let anchor = ''
  if (lines && Array.isArray(lines)) {
    anchor = lines ? lines.map(l => `L${l}`).join('-') : ''
  } else if (typeof lines == 'string') {
    anchor = lines
  }
  const encodePath = (value: string): string => value.split('/').map(encodeURIComponent).join('/')
  let url = repoURL + '/blob/' + encodePath(name) + '/' + encodePath(filepath) + (anchor ? '#' + encodeURIComponent(anchor) : '')
  const separator = fix.lastIndexOf('|')
  if (separator === -1) return url
  try {
    let match = RegExp(fix.slice(0, separator)), result = fix.slice(separator + 1)
    return url.replace(match, result)
  } catch (_e) {
    return url
  }
}

export async function feedTreeToggleKey(nvim: Neovim, configuredKey: string): Promise<void> {
  let key = configuredKey
  if (/^<[^"\\\r\n]+>$/.test(configuredKey)) {
    key = await nvim.call('eval', [`"\\${configuredKey}"`]) as string
  }
  await nvim.call('feedkeys', [key, 'in'])
}

function parseVersion(raw: string): string {
  return raw.replace(/^git version /, '')
}

function findSystemGitWin32(base: string, onLookup: (path: string) => void): Promise<IGit> {
  if (!base) {
    return Promise.reject<IGit>('Not found')
  }

  return findSpecificGit(path.join(base, 'Git', 'cmd', 'git.exe'), onLookup)
}

function findGitWin32InPath(onLookup: (path: string) => void): Promise<IGit> {
  const whichPromise = new Promise<string>((c, e) => which('git.exe', (err, path) => err ? e(err) : c(path)))
  return whichPromise.then(path => findSpecificGit(path, onLookup))
}

function findGitWin32(onLookup: (path: string) => void): Promise<IGit> {
  return findSystemGitWin32(process.env['ProgramW6432'] as string, onLookup)
    .then(undefined, () => findSystemGitWin32(process.env['ProgramFiles(x86)'] as string, onLookup))
    .then(undefined, () => findSystemGitWin32(process.env['ProgramFiles'] as string, onLookup))
    .then(undefined, () => findSystemGitWin32(path.join(process.env['LocalAppData'] as string, 'Programs'), onLookup))
    .then(undefined, () => findGitWin32InPath(onLookup))
}

function findSpecificGit(path: string, onLookup: (path: string) => void): Promise<IGit> {
  return new Promise<IGit>((c, e) => {
    onLookup(path)
    const buffers: Buffer[] = []
    const child = spawn(path, ['--version'])
    child.stdout.on('data', (b: Buffer) => buffers.push(b))
    child.on('error', cpErrorHandler(e))
    child.on('exit', code => code ? e(new Error('Not found')) : c({ path, version: parseVersion(Buffer.concat(buffers).toString('utf8').trim()) }))
  })
}

export function cpErrorHandler(cb: (reason?: any) => void): (reason?: any) => void {
  return err => {
    if (/ENOENT/.test(err.message)) {
      err = new Error('Failed to execute git (ENOENT)')
    }
    cb(err)
  }
}

function findGitDarwin(onLookup: (path: string) => void): Promise<IGit> {
  return new Promise<IGit>((c, e) => {
    exec('which git', (err, gitPathBuffer) => {
      if (err) {
        return e('git not found')
      }
      const path = gitPathBuffer.toString().replace(/^\s+|\s+$/g, '')
      if (path !== '/usr/bin/git') {
        findSpecificGit(path, onLookup).then(c, e)
        return
      }
      // must check if XCode is installed
      exec('xcode-select -p', (err: any) => {
        if (err && err.code === 2) {
          // git is not installed, and launching /usr/bin/git
          // will prompt the user to install it
          e('git not found')
          return
        }
        findSpecificGit(path, onLookup).then(c, e)
      })
    })
  })
}

export function findGit(hint: string | undefined, onLookup: (path: string) => void): Promise<IGit> {
  const first = hint ? findSpecificGit(hint, onLookup) : Promise.reject<IGit>(null)

  return first
    .then(undefined, () => {
      switch (process.platform) {
        case 'darwin': return findGitDarwin(onLookup)
        case 'win32': return findGitWin32(onLookup)
        default: return findSpecificGit('git', onLookup)
      }
    })
    .then(null, () => Promise.reject(new Error('Git installation not found.')))
}

export function onceEvent<T>(event: Event<T>): Event<T> {
  return (listener, thisArgs = null, disposables?) => {
    const result = event(e => {
      result.dispose()
      return listener.call(thisArgs, e)
    }, null, disposables)

    return result
  }
}
