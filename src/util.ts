import { exec, ExecOptions, spawn } from 'child_process'
import path from 'path'
import { workspace, Event } from 'coc.nvim'
import which from 'which'
import fs from 'fs'

export interface IGit {
  path: string
  version: string
}

export function wait(ms: number): Promise<any> {
  return new Promise(resolve => {
    setTimeout(() => {
      resolve()
    }, ms)
  })
}

export function isDirectory(path: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    fs.stat(path, (err, stat) => {
      if (err) {
        return resolve(false)
      }
      resolve(stat.isDirectory())
    })
  })
}

export function shellescape(s: string): string {
  if (process.platform == 'win32') {
    return `"${s.replace(/"/g, '\\"')}"`
  }
  if (/[^A-Za-z0-9_\/:=-]/.test(s)) {
    s = "'" + s.replace(/'/g, "'\\''") + "'"
    s = s.replace(/^(?:'')+/g, '') // unduplicate single-quote at the beginning
      .replace(/\\'''/g, "\\'") // remove non-escaped single-quote if there are enclosed between 2 escaped
    return s
  }
  return s
}

export function toUnixSlash(fsPath: string): string {
  if (process.platform == 'win32') {
    return fsPath.replace(/\\/g, '/')
  }
  return fsPath
}

export async function safeRun(cmd: string, opts: ExecOptions = {}): Promise<string> {
  try {
    return await runCommand(cmd, opts, 5000)
  } catch (e) {
    // tslint:disable-next-line: no-console
    console.error(e.message)
    return null
  }
}

export function spawnCommand(cmd: string, args: string[], cwd: string): Promise<string> {
  const cp = spawn(cmd, args, { cwd })
  let res = ''
  return new Promise((resolve, reject) => {
    cp.stdout.on('data', data => {
      res += data.toString()
    })
    cp.stderr.on('data', data => {
      workspace.showMessage(`"${cmd} ${args.join(' ')}" error: ${data.toString()}`, 'error')
    })
    cp.on('close', code => {
      if (code != 0) {
        return reject(new Error(`${cmd} exited with code ${code}`))
      }
      resolve(res)
    })
  })
}

export function runCommand(cmd: string, opts: ExecOptions = {}, timeout?: number): Promise<string> {
  opts.maxBuffer = 500 * 1024
  return new Promise<string>((resolve, reject) => {
    let timer: NodeJS.Timer
    if (timeout) {
      timer = setTimeout(() => {
        reject(new Error(`timeout after ${timeout}s`))
      }, timeout * 1000)
    }
    exec(cmd, opts, (err, stdout, stderr) => {
      if (timer) clearTimeout(timer)
      if (err) {
        reject(new Error(`exited with ${err.code}\n${stderr}`))
        return
      }
      resolve(stdout)
    })
  })
}

export function getStdout(cmd: string, opts: ExecOptions = {}, timeout?: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let timer: NodeJS.Timer
    if (timeout) {
      timer = setTimeout(() => {
        reject(new Error(`timeout after ${timeout}s`))
      }, timeout * 1000)
    }
    opts.maxBuffer = 500 * 1024
    exec(cmd, opts, (_err, stdout) => {
      if (timer) clearTimeout(timer)
      if (stdout) {
        resolve(stdout)
        return
      }
      resolve()
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

export function getUrl(remote: string, branch: string, filepath: string, lines?: number[] | string): string {
  let uri = remote.replace(/\.git$/, '')
  if (uri.startsWith('git@')) {
    let str = uri.slice(4)
    let parts = str.split(':', 2)
    uri = `https://${parts[0]}/${parts[1]}`
  }
  // let { hostname } = parse(uri)
  let anchor = ''
  if (lines && Array.isArray(lines)) {
    anchor = lines ? lines.map(l => `L${l}`).join('-') : ''
  } else if (typeof lines == 'string') {
    anchor = lines
  }
  return uri + '/blob/' + branch + '/' + filepath + (anchor ? '#' + anchor : '')
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
      function getVersion(path: string): void {
        onLookup(path)
        // make sure git executes
        exec('git --version', (err, stdout) => {
          if (err) {
            return e('git not found')
          }
          return c({ path, version: parseVersion(stdout.trim()) })
        })
      }
      if (path !== '/usr/bin/git') {
        return getVersion(path)
      }
      getVersion(path)
      // must check if XCode is installed
      exec('xcode-select -p', (err: any) => {
        if (err && err.code === 2) {
          // git is not installed, and launching /usr/bin/git
          // will prompt the user to install it

          return e('git not found')
        }
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
