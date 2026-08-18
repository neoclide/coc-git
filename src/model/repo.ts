import { OutputChannel } from 'coc.nvim'
import fs from 'fs'
import os from 'os'
import path from 'path'
import util from 'util'
import Git, { IExecutionResult, SpawnOptions } from './git'
import { ChangeType, Decorator, Diff, DiffCategory, DiffChunks, StageChunk } from '../types'
import { toUnixSlash } from '../util'
import { v4 as uuid } from 'uuid'

export class Repo {
  private userName: string | undefined
  constructor(
    private git: Git,
    private channel: OutputChannel,
    public readonly root: string
  ) {
  }

  /**
   * Get staged info
   */
  public async getStagedChunks(relpath?: string): Promise<DiffChunks> {
    let args = ['-c', 'core.quotepath=false', '--no-pager', 'diff', '--no-ext-diff', '--no-renames', '-p', '-U0', '--no-color', '--staged']
    if (relpath) args.push('--', toUnixSlash(relpath))
    const result = await this.exec(args)
    if (!result.stdout) {
      return {}
    }
    let res: DiffChunks = {}
    let idx = 0
    let lines = result.stdout.split(/\r?\n/)
    let curr: StageChunk | undefined
    let fsPath: string
    while (idx < lines.length) {
      let line = lines[idx]
      if (fsPath && line.startsWith('@@')) {
        curr = undefined
        let ms = line.match(/^@@\s+-(\d+),?(\d*)\s+\+(\d+),?(\d*)\s+@@/)
        if (ms) {
          curr = {
            remove: { lnum: Number(ms[1]), count: ms[2] ? Number(ms[2]) : 1 },
            add: { lnum: Number(ms[3]), count: ms[4] ? Number(ms[4]) : 1 },
            lines: []
          }
          res[fsPath] = res[fsPath] || []
          res[fsPath].push(curr)
        }
      } else if (curr && /^[+\-]/.test(line)) {
        curr.lines.push(line)
      } else if (line.startsWith('diff --git')) {
        const parsedPath = parseDiffPath(line)
        if (relpath || parsedPath) {
          fsPath = relpath ? toUnixSlash(relpath) : parsedPath
          curr = undefined
          idx += 4
          continue
        }
      }
      idx++
    }
    return res
  }

  private async getHEAD(): Promise<string> {
    try {
      const result = await this.exec(['symbolic-ref', '--short', 'HEAD'])
      if (!result.stdout) {
        throw new Error('Not in a branch')
      }
      return result.stdout.trim()
    } catch (err) {
      const result = await this.exec(['rev-parse', 'HEAD'])
      if (!result.stdout) {
        throw new Error('Error parsing HEAD')
      }
      return result.stdout.trim()
    }
  }

  private async hasChanged(): Promise<boolean> {
    let result = await this.exec(['diff', '--name-status'])
    return result.stdout.trim().length > 0
  }

  private async getStaged(): Promise<[number, number]> {
    let result = await this.exec(['diff', '--staged', '--name-status'])
    if (!result.stdout) return [0, 0]
    let lines = result.stdout.trim().split(/\r?\n/)
    let conflicted = 0
    let staged = 0
    lines.forEach(line => {
      if (!line.length) return
      if (line.startsWith('U')) {
        conflicted++
      } else {
        staged++
      }
    })
    return [conflicted, staged]
  }

  private async hasUntracked(): Promise<boolean> {
    let cp = this.git.stream(this.root, ['ls-files', '--others', '--exclude-standard', '--directory'])
    return new Promise(resolve => {
      let settled = false
      const finish = (value: boolean): void => {
        if (settled) return
        settled = true
        resolve(value)
      }
      cp.stdout.on('data', () => {
        cp.kill('SIGKILL')
        finish(true)
      })
      cp.on('exit', () => {
        finish(false)
      })
      cp.on('error', () => {
        finish(false)
      })
    })
  }

  public async getStatus(character: string, decorator: Decorator): Promise<string> {
    try {
      let head = await this.getHEAD()
      if (!head) return ''
      let [changed, staged, untracked] = await Promise.all([this.hasChanged(), this.getStaged(), this.hasUntracked()])
      const { changedDecorator, conflictedDecorator, stagedDecorator, untrackedDecorator } = decorator
      let more = ''
      if (changed) more += changedDecorator
      if (staged[0]) more += conflictedDecorator
      if (staged[1]) more += stagedDecorator
      if (untracked) more += untrackedDecorator
      return `${character ? character + ' ' : ''}${head}${more}`
    } catch (e) {
      this.channel.appendLine('Error on git status')
      this.channel.append(e.message)
      return ''
    }
  }

  public async getDiff(relFilepath: string, content: string, revision = '', encoding = 'utf8'): Promise<Diff[]> {
    if (relFilepath.startsWith(`.git${path.sep}`)) return
    const base = await this.getFileContent(relFilepath, revision || ':', encoding)
    return this.getDiffFromContents(base ? base + '\n' : '', content)
  }

  public async getDiffFromContents(base: string, content: string): Promise<Diff[]> {
    const stagedFile = path.join(os.tmpdir(), `coc-${uuid()}`)
    const currentFile = path.join(os.tmpdir(), `coc-${uuid()}`)
    let output: string
    try {
      await util.promisify(fs.writeFile)(stagedFile, base, 'utf8')
      await util.promisify(fs.writeFile)(currentFile, content, 'utf8')
      const result = await this.exec([
        '--no-pager', 'diff', '--no-index', '--no-ext-diff', '-p', '-U0', '--no-color',
        stagedFile, currentFile
      ], { allowedExitCodes: [1] })
      output = result.stdout
    } finally {
      await Promise.all([
        util.promisify(fs.unlink)(stagedFile).catch(() => undefined),
        util.promisify(fs.unlink)(currentFile).catch(() => undefined)
      ])
    }
    if (!output) return []
    this.channel.appendLine('> git diff buffer contents')
    // split output into lines and delete trailing empty line
    const lines = output.replace(/\r?\n$/, '').split(/\r?\n/)
    return parseDiff(lines)
  }

  public async getFileContent(relpath: string, revision: string, encoding = 'utf8'): Promise<string> {
    try {
      const object = revision.endsWith(':') ? revision : `${revision}:`
      const result = await this.exec(['--no-pager', 'show', `${object}${toUnixSlash(relpath)}`], {
        encoding,
        log: false,
        allowedExitCodes: [128]
      })
      if (result.exitCode !== 0) return ''
      return result.stdout.replace(/\r?\n$/, '').split(/\r?\n/).join('\n')
    } catch (_e) {
      return ''
    }
  }

  public async getIndexIdentity(): Promise<string> {
    try {
      const gitPath = (await this.safeRun(['rev-parse', '--git-path', 'index'])).trim()
      if (!gitPath) return ''
      const indexPath = path.isAbsolute(gitPath) ? gitPath : path.join(this.root, gitPath)
      const stat = await util.promisify(fs.stat)(indexPath)
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
    } catch (_e) {
      return ''
    }
  }

  public async getHeadIdentity(): Promise<string> {
    return this.safeRun(['rev-parse', '--verify', 'HEAD'])
  }

  public async getDiffAll(category: DiffCategory): Promise<Map<string, Diff[]>> {
    let diffGroups: Map<string, Diff[]> = new Map()
    let args: string[] = ['-c', 'core.quotepath=false', '--no-pager', 'diff', '--no-ext-diff', '--no-renames', '-p', '-U0', '--no-color']
    if (category === DiffCategory.All) {
      const head = await this.safeRun(['rev-parse', '--verify', 'HEAD'])
      if (head) {
        args.push('HEAD')
      } else {
        const emptyTree = await this.exec(['hash-object', '-t', 'tree', '--stdin'], { input: '', log: false })
        args.push(emptyTree.stdout.trim())
      }
    } else if (category === DiffCategory.Staged) {
      args.push('--cached')
    }
    let output = (await this.exec(args)).stdout
    if (!output) return diffGroups

    /* Split diff output into lines and group by filename */
    const lines = output.replace(/\r?\n$/, '').split(/\r?\n/)
    let lineGroups: Map<string, string[]> = new Map()
    let file: string = null
    for (const line of lines) {
      if (line.startsWith('diff --git')) {
        file = parseDiffPath(line) || null
      }
      if (file) {
        if (!lineGroups.has(file)) {
          lineGroups.set(file, [])
        }
        lineGroups.get(file).push(line)
      }
    }

    for (const [file, lines] of lineGroups) {
      let diffs = parseDiff(lines)
      if (diffs) {
        diffGroups.set(file, diffs)
      }
    }
    return diffGroups
  }

  public async isIgnored(relativePath: string): Promise<boolean> {
    let res = await this.exec(['check-ignore', '-q', '--', relativePath], { allowedExitCodes: [1] })
    return res.exitCode === 0
  }

  public async hasConflicts(relativePath: string): Promise<boolean> {
    let indexed = await this.isIndexed(relativePath)
    if (!indexed) return false
    let res = await this.exec(['diff', '--staged', '--name-status', '--', relativePath])
    return res.stdout.trim().startsWith('U')
  }

  public async isIndexed(relpath: string): Promise<boolean> {
    let res = await this.exec(['ls-files', '--', relpath])
    return res.stdout && res.stdout.trim().length > 0
  }

  public async getUsername(): Promise<string> {
    if (typeof this.userName === 'string') return this.userName
    try {
      let res = await this.exec(['config', 'user.name'])
      this.userName = res.stdout.trim()
      return this.userName
    } catch (e) {
      this.userName = ''
      return ''
    }
  }

  public async isShallow(): Promise<boolean> {
    try {
      let res = await this.exec(['rev-parse', '--is-shallow-repository'])
      return res.stdout.trim() === 'true'
    } catch (e) {
      return false
    }
  }

  public async exec(args: string[], options: SpawnOptions = {}): Promise<IExecutionResult<string>> {
    return await this.git.exec(this.root, args, options)
  }

  public async safeRun(args: string[], options: SpawnOptions = {}): Promise<string> {
    try {
      let res = await this.exec(args, options)
      return res ? res.stdout.replace(/\s*$/, '') : ''
    } catch (e) {
      return ''
    }
  }
}

function readQuotedGitPath(input: string, start: number): { value: string, end: number } | undefined {
  if (input[start] !== '"') return undefined
  let value = ''
  for (let index = start + 1; index < input.length; index++) {
    const character = input[index]
    if (character === '"') return { value, end: index + 1 }
    if (character !== '\\') {
      value += character
      continue
    }
    const escaped = input[++index]
    if (escaped == null) return undefined
    const escapes: { [key: string]: string } = {
      a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '"': '"', '\\': '\\'
    }
    if (escapes[escaped] != null) {
      value += escapes[escaped]
      continue
    }
    if (/[0-7]/.test(escaped)) {
      let octal = escaped
      while (octal.length < 3 && /[0-7]/.test(input[index + 1] || '')) octal += input[++index]
      value += String.fromCharCode(parseInt(octal, 8))
      continue
    }
    value += escaped
  }
  return undefined
}

/** Parse the same-path header emitted by `git diff --no-renames`. */
export function parseDiffPath(line: string): string | undefined {
  const prefix = 'diff --git '
  if (!line.startsWith(prefix)) return undefined
  const value = line.slice(prefix.length)
  if (value.startsWith('"')) {
    const first = readQuotedGitPath(value, 0)
    if (!first) return undefined
    const secondStart = value.indexOf('"', first.end)
    const second = secondStart === -1 ? undefined : readQuotedGitPath(value, secondStart)
    if (!second || !first.value.startsWith('a/') || !second.value.startsWith('b/')) return undefined
    const firstPath = first.value.slice(2)
    return firstPath === second.value.slice(2) ? firstPath : undefined
  }
  if (!value.startsWith('a/')) return undefined
  const paths = value.slice(2)
  let separator = paths.indexOf(' b/')
  while (separator !== -1) {
    const firstPath = paths.slice(0, separator)
    if (firstPath === paths.slice(separator + 3)) return firstPath
    separator = paths.indexOf(' b/', separator + 1)
  }
  return undefined
}

export default Repo

export function parseDiff(diffLines: string[]): Diff[] {
  // delete the first four lines
  const allLines = diffLines.slice(4)
  const diffs: Diff[] = []

  let diff: Diff = null

  for (const line of allLines) {
    if (!line.startsWith('@@')) {
      if (diff) {
        diff.lines.push(line)
      }
      continue
    }

    // Diff key: -xx +yy
    let diffKey = line.split('@@', 2)[1].trim()

    const [pres, nows]: (undefined | string)[][] = diffKey
      .split(/\s+/)
      .map(str => str.slice(1).split(','))

    const removed = {
      start: parseInt(pres[0], 10),
      count: parseInt(`${pres[1] || 1}`, 10)
    }
    const added = {
      start: parseInt(nows[0], 10),
      count: parseInt(`${nows[1] || 1}`, 10)
    }

    if (added.count === 0) {
      // delete
      diff = {
        lines: [],
        start: added.start,
        end: added.start,
        head: line,
        removed,
        added,
        changeType: ChangeType.Delete
      }
      diffs.push(diff)
    } else if (removed.count === 0) {
      // add
      diff = {
        lines: [],
        start: added.start,
        end: added.start + added.count - 1,
        head: line,
        removed,
        added,
        changeType: ChangeType.Add
      }
      diffs.push(diff)
    } else {
      // change
      diff = {
        lines: [],
        start: added.start,
        end: added.start + Math.min(added.count, removed.count) - 1,
        head: line,
        removed,
        added,
        changeType: ChangeType.Change
      }
      diffs.push(diff)
    }
  }
  return diffs
}
