import { Document, Uri } from 'coc.nvim'
import os from 'os'
import path from 'path'
import fs from 'fs'
import util from 'util'
import { safeRun, getStdout } from './util'
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
  // git --no-pager show:[relative]
  if (doc.schema != 'file' || doc.buftype != '') return null
  const stagedFile = path.join(os.tmpdir(), `coc-${uuid()}`)
  const currentFile = path.join(os.tmpdir(), `coc-${uuid()}`)
  let fsPath = Uri.parse(doc.uri).fsPath
  let file = path.relative(root, fsPath)
  let res = await safeRun(`git --no-pager show :${file}`, { cwd: root })
  if (res == null) return null
  await util.promisify(fs.writeFile)(stagedFile, res, 'utf8')
  await util.promisify(fs.writeFile)(currentFile, doc.getDocumentContent(), 'utf8')
  let output = await getStdout(`git --no-pager diff -p -U0 --no-color ${stagedFile} ${currentFile}`)
  if (!output) return null
  await util.promisify(fs.unlink)(stagedFile)
  await util.promisify(fs.unlink)(currentFile)
  return parseDiff(output)
}
