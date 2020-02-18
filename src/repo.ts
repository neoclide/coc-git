import { Document, OutputChannel, Uri } from 'coc.nvim'
import fs from 'fs'
import os from 'os'
import path from 'path'
import util from 'util'
import Git, { IExecutionResult, SpawnOptions } from './git'
import { ChangeType, Diff } from './types'
import { getStdout, shellescape } from './util'
import uuid = require('uuid/v4')

interface Decorator {
  changedDecorator: string
  conflictedDecorator: string
  stagedDecorator: string
  untrackedDecorator: string
}

export default class Repo {
  constructor(
    private git: Git,
    private channel: OutputChannel,
    public root: string
  ) {
  }

  public async getHEAD(): Promise<string> {
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
    if (!result.stdout) return false
    let lines = result.stdout.split(/\r?\n/)
    return lines.some(l => l.startsWith('M'))
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
    let cp = this.git.stream(this.root, ['ls-files', '--others', '--exclude-standard'])
    return new Promise(resolve => {
      let hasData = false
      let timer = setTimeout(() => {
        if (cp.killed) return
        cp.kill('SIGKILL')
        resolve(false)
      }, 100)
      cp.stdout.on('data', () => {
        clearTimeout(timer)
        hasData = true
        cp.kill('SIGKILL')
        resolve(hasData)
      })
      cp.on('exit', () => {
        clearTimeout(timer)
        resolve(hasData)
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

  public async getDiff(doc: Document): Promise<Diff[]> {
    if (!doc || doc.isIgnored || doc.buftype !== '' || doc.schema !== 'file') return
    let fsPath = Uri.parse(doc.uri).fsPath
    if (!fs.existsSync(fsPath)) return
    fsPath = fs.realpathSync(fsPath, 'utf8')
    let file = path.relative(this.root, fsPath)
    if (file.startsWith(`.git${path.sep}`)) return
    // check if indexed
    let staged: string
    try {
      let res = await this.exec(['ls-files', '--', file])
      if (!res.stdout.trim().length) return
      res = await this.exec(['--no-pager', 'show', `:${file}`])
      if (!res.stdout) return
      staged = res.stdout.replace(/\r?\n$/, '').split(/\r?\n/).join('\n')
    } catch (e) {
      this.channel.append(e.stack)
      return
    }
    const stagedFile = path.join(os.tmpdir(), `coc-${uuid()}`)
    const currentFile = path.join(os.tmpdir(), `coc-${uuid()}`)
    await util.promisify(fs.writeFile)(stagedFile, staged + '\n', 'utf8')
    await util.promisify(fs.writeFile)(currentFile, doc.getDocumentContent(), 'utf8')
    let output = await getStdout(`git --no-pager diff -p -U0 --no-color ${shellescape(stagedFile)} ${shellescape(currentFile)}`)
    await util.promisify(fs.unlink)(stagedFile)
    await util.promisify(fs.unlink)(currentFile)
    if (!output) return
    this.channel.appendLine(`> git diff ${fsPath}`)
    return parseDiff(output)
  }

  private async exec(args: string[], options: SpawnOptions = {}): Promise<IExecutionResult<string>> {
    return await this.git.exec(this.root, args, options)
  }
}

export function parseDiff(diffStr: string): Diff[] {
  // split to lines and delete the first four lines and the last '\n'
  const allLines = diffStr.split('\n').slice(4, -1)
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
