import { CancellationToken } from 'coc.nvim'
import Git, { IExecutionResult } from './git'

export type CommitChangeStatus = 'A' | 'C' | 'D' | 'M' | 'R' | 'T' | 'U' | 'X' | 'B'

export interface CommitInfo {
  sha: string
  shortSha: string
  parents: string[]
  author: string
  authoredAt: string
  subject: string
}

export interface CommitChange {
  status: CommitChangeStatus
  score?: number
  path: string
  oldPath?: string
  additions?: number
  deletions?: number
  binary: boolean
}

export interface CommitComparison {
  commit: CommitInfo
  baseSha?: string
  parentIndex?: number
  changes: CommitChange[]
}

interface ParsedStatus {
  status: CommitChangeStatus
  score?: number
  path: string
  oldPath?: string
}

interface ParsedNumstat {
  oldPath?: string
  path: string
  additions?: number
  deletions?: number
  binary: boolean
}

function parserError(kind: string, detail: string): Error {
  return new Error(`Invalid Git ${kind} output: ${detail}`)
}

export function parseNameStatus(output: string): ParsedStatus[] {
  if (!output) return []
  const fields = output.endsWith('\0') ? output.slice(0, -1).split('\0') : output.split('\0')
  const result: ParsedStatus[] = []
  let index = 0
  while (index < fields.length) {
    const token = fields[index++]
    const match = token.match(/^([ACDMRTUXB])([0-9]+)?$/)
    if (!match) throw parserError('name-status', `invalid status token ${JSON.stringify(token)}`)
    const status = match[1] as CommitChangeStatus
    const scoreText = match[2]
    if ((status === 'R' || status === 'C') && !scoreText) {
      throw parserError('name-status', `missing similarity score for ${status}`)
    }
    if (scoreText && status !== 'R' && status !== 'C') {
      throw parserError('name-status', `score on ${status} record`)
    }
    const score = scoreText ? Number(scoreText) : undefined
    if (score !== undefined && (!Number.isSafeInteger(score) || score < 0 || score > 100)) {
      throw parserError('name-status', `invalid score ${scoreText}`)
    }
    if (status === 'R' || status === 'C') {
      const oldPath = fields[index++]
      const path = fields[index++]
      if (!oldPath || !path) throw parserError('name-status', 'missing rename/copy path')
      result.push({ status, score, oldPath, path })
    } else {
      const path = fields[index++]
      if (!path) throw parserError('name-status', 'missing path')
      result.push({ status, path })
    }
  }
  return result
}

export function parseNumstat(output: string): ParsedNumstat[] {
  if (!output) return []
  const fields = output.endsWith('\0') ? output.slice(0, -1).split('\0') : output.split('\0')
  const result: ParsedNumstat[] = []
  let index = 0
  while (index < fields.length) {
    const record = fields[index++]
    const firstTab = record.indexOf('\t')
    const secondTab = firstTab < 0 ? -1 : record.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) {
      throw parserError('numstat', `missing tab separators in ${JSON.stringify(record)}`)
    }
    const additionsText = record.slice(0, firstTab)
    const deletionsText = record.slice(firstTab + 1, secondTab)
    const path = record.slice(secondTab + 1)
    const binary = additionsText === '-' || deletionsText === '-'
    if (binary && (additionsText !== '-' || deletionsText !== '-')) {
      throw parserError('numstat', 'only binary records may contain -')
    }
    if (!binary && (!/^\d+$/.test(additionsText) || !/^\d+$/.test(deletionsText))) {
      throw parserError('numstat', `invalid line counts in ${JSON.stringify(record)}`)
    }
    if (path) {
      result.push({
        path,
        additions: binary ? undefined : Number(additionsText),
        deletions: binary ? undefined : Number(deletionsText),
        binary
      })
      continue
    }
    const oldPath = fields[index++]
    const newPath = fields[index++]
    if (!oldPath || !newPath) throw parserError('numstat', 'missing rename/copy path')
    result.push({
      oldPath,
      path: newPath,
      additions: binary ? undefined : Number(additionsText),
      deletions: binary ? undefined : Number(deletionsText),
      binary
    })
  }
  return result
}

export function mergeChanges(statusOutput: string, numstatOutput: string): CommitChange[] {
  const statuses = parseNameStatus(statusOutput)
  const stats = parseNumstat(numstatOutput)
  const statusMap = new Map<string, ParsedStatus>()
  for (const status of statuses) {
    const key = `${status.oldPath ?? ''}\0${status.path}`
    if (statusMap.has(key)) throw parserError('diff', `duplicate status key ${JSON.stringify(key)}`)
    statusMap.set(key, status)
  }
  const result: CommitChange[] = []
  const statKeys = new Set<string>()
  for (const stat of stats) {
    const key = `${stat.oldPath ?? ''}\0${stat.path}`
    if (statKeys.has(key)) throw parserError('diff', `duplicate numstat key ${JSON.stringify(key)}`)
    statKeys.add(key)
    const status = statusMap.get(key)
    if (!status) throw parserError('diff', `numstat without name-status for ${JSON.stringify(key)}`)
    result.push({
      status: status.status,
      score: status.score,
      path: status.path,
      oldPath: status.oldPath,
      additions: stat.additions,
      deletions: stat.deletions,
      binary: stat.binary
    })
    statusMap.delete(key)
  }
  if (statusMap.size) {
    const key = statusMap.keys().next().value as string
    throw parserError('diff', `name-status without numstat for ${JSON.stringify(key)}`)
  }
  return result
}

function metadataFromOutput(output: string, revision: string): CommitInfo {
  const fields = output.split('\0')
  if (fields.length !== 6) {
    throw parserError('commit metadata', `expected 6 fields for ${JSON.stringify(revision)}`)
  }
  const [sha, shortSha, parentText, author, authoredAt, subject] = fields
  if (!sha || !shortSha) throw parserError('commit metadata', `missing SHA for ${JSON.stringify(revision)}`)
  return {
    sha,
    shortSha,
    parents: parentText ? parentText.split(' ') : [],
    author,
    authoredAt,
    subject
  }
}

export async function resolveCommit(git: Git, root: string, revision: string, token?: CancellationToken): Promise<CommitInfo> {
  const verified = await git.exec(root, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`], {
    cancellationToken: token
  })
  const sha = verified.stdout.trim()
  if (!sha) throw new Error(`Invalid Git commit: ${revision}`)
  const metadata = await git.exec(root, ['show', '-s', '--no-patch', '--format=%H%x00%h%x00%P%x00%an%x00%aI%x00%s', sha], {
    cancellationToken: token
  })
  return metadataFromOutput(metadata.stdout, revision)
}

function comparisonArgs(commitSha: string, baseSha: string | undefined, initial: boolean, kind: 'name-status' | 'numstat'): string[] {
  if (initial) {
    return ['--no-pager', 'diff-tree', '--root', '--no-commit-id', '-r', '--no-ext-diff', '--no-textconv', '--no-color', '--no-relative', '--ignore-submodules=none', '--find-renames=50%', '--find-copies=50%', `--${kind}`, '-z', commitSha, '--']
  }
  return ['--no-pager', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-relative', '--ignore-submodules=none', '--find-renames=50%', '--find-copies=50%', `--${kind}`, '-z', baseSha as string, commitSha, '--']
}

async function runComparison(git: Git, root: string, commit: CommitInfo, baseSha: string | undefined, token?: CancellationToken): Promise<CommitChange[]> {
  const initial = !baseSha
  const options = { cancellationToken: token }
  const [status, numstat]: [IExecutionResult<string>, IExecutionResult<string>] = await Promise.all([
    git.exec(root, comparisonArgs(commit.sha, baseSha, initial, 'name-status'), options),
    git.exec(root, comparisonArgs(commit.sha, baseSha, initial, 'numstat'), options)
  ])
  return mergeChanges(status.stdout, numstat.stdout)
}

export async function loadCommitComparison(git: Git, root: string, revision: string, parentIndex = 0, token?: CancellationToken): Promise<CommitComparison> {
  const commit = await resolveCommit(git, root, revision, token)
  return await loadComparisonForCommit(git, root, commit, parentIndex, token)
}

export async function loadComparisonForCommit(git: Git, root: string, commit: CommitInfo, parentIndex = 0, token?: CancellationToken): Promise<CommitComparison> {
  let baseSha: string | undefined
  if (commit.parents.length) {
    if (!Number.isInteger(parentIndex) || parentIndex < 0 || parentIndex >= commit.parents.length) {
      throw new Error(`Invalid parent index ${parentIndex} for ${commit.shortSha}`)
    }
    baseSha = commit.parents[parentIndex]
  }
  const changes = await runComparison(git, root, commit, baseSha, token)
  return {
    commit,
    baseSha,
    parentIndex: baseSha ? parentIndex : undefined,
    changes
  }
}

export async function assertParentAvailable(git: Git, root: string, parentSha: string, token?: CancellationToken): Promise<void> {
  await git.exec(root, ['cat-file', '-e', `${parentSha}^{commit}`], { cancellationToken: token })
}

export function patchArgs(comparison: CommitComparison, change: CommitChange): string[] {
  const paths = change.oldPath ? [change.oldPath, change.path] : [change.path]
  if (comparison.baseSha) {
    return ['--no-pager', 'diff', '-p', '--no-ext-diff', '--no-textconv', '--no-color', '--no-relative', '--ignore-submodules=none', '--find-renames=50%', '--find-copies=50%', comparison.baseSha, comparison.commit.sha, '--', ...paths]
  }
  return ['--no-pager', 'diff-tree', '--root', '--no-commit-id', '-r', '-p', '--no-ext-diff', '--no-textconv', '--no-color', '--no-relative', '--ignore-submodules=none', '--find-renames=50%', '--find-copies=50%', comparison.commit.sha, '--', ...paths]
}
