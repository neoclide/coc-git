import { Document, Uri } from 'coc.nvim'
import os from 'os'
import path from 'path'
import fs from 'fs'
import util from 'util'
import { safeRun, getStdout, shellescape } from './util'
import uuid = require('uuid/v4')
import { Diff, ChangeType } from './types'

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

    const deleteCount = parseInt(`${pres[1] || 1}`, 10)
    const addCount = parseInt(`${nows[1] || 1}`, 10)
    const lineNum = parseInt(nows[0], 10)

    // delete
    if (nows[1] === '0') {
      diff = {
        lines: [],
        head: line,
        start: lineNum,
        end: lineNum,
        changeType: ChangeType.Delete
      }
      diffs.push(diff)
    } else {
      if (deleteCount == 0) {
        diff = {
          lines: [],
          head: line,
          start: lineNum,
          end: lineNum + addCount - 1,
          changeType: ChangeType.Add
        }
        diffs.push(diff)
      } else {
        diff = {
          lines: [],
          head: line,
          start: lineNum,
          end: lineNum + Math.min(addCount, deleteCount) - 1,
          delta: [addCount, deleteCount],
          changeType: ChangeType.Change
        }
        diffs.push(diff)
      }
    }
  }
  return diffs
}

export async function getDiff(root: string, doc: Document): Promise<Diff[]> {
  if (doc.schema != 'file' || doc.buftype != '') return null
  const stagedFile = path.join(os.tmpdir(), `coc-${uuid()}`)
  const currentFile = path.join(os.tmpdir(), `coc-${uuid()}`)
  let fsPath = Uri.parse(doc.uri).fsPath
  let file = path.relative(root, fsPath)
  if (file.startsWith('.git')) return null
  let res = await safeRun(`git --no-pager show ${shellescape(':' + file)}`, { cwd: root })
  if (res == null) return null
  let staged = res.replace(/\r?\n$/, '').split(/\r?\n/).join('\n')
  await util.promisify(fs.writeFile)(stagedFile, staged + '\n', 'utf8')
  await util.promisify(fs.writeFile)(currentFile, doc.getDocumentContent(), 'utf8')
  let output = await getStdout(`git --no-pager diff -p -U0 --no-color ${shellescape(stagedFile)} ${shellescape(currentFile)}`)
  await util.promisify(fs.unlink)(stagedFile)
  await util.promisify(fs.unlink)(currentFile)
  if (!output) return null
  return parseDiff(output)
}
