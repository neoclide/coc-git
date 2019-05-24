import { safeRun } from './util'

async function gitBranch(cwd: string): Promise<string> {
  let res = await safeRun('git symbolic-ref -q HEAD | cut -c 12-', { cwd })
  if (res == null) return ''
  res = res.trim()
  if (res) return res
  res = await safeRun('git rev-parse --short HEAD', { cwd })
  return `:${res.trim()}`
}

async function gitChanged(cwd: string): Promise<number> {
  let res = await safeRun('git diff --name-status | cut -c 1-2', { cwd })
  if (res == null) return 0
  let out = res.replace(/\n$/, '')
  let count = 0
  out.split('\n').forEach(line => {
    if (line.startsWith('M')) count++
  })
  return count
}

async function gitStaged(cwd: string): Promise<[number, number]> {
  let res = await safeRun('git diff --staged --name-status | cut -c 1-2', { cwd })
  if (res == null) return [0, 0]
  let out = res.replace(/\n$/, '')
  let conflicted = 0
  let staged = 0
  out.split('\n').forEach(line => {
    if (!line.length) return
    if (/U/.test(line)) {
      conflicted++
    } else {
      staged++
    }
  })
  return [conflicted, staged]
}

async function gitUntracked(cwd: string): Promise<number> {
  let res = await safeRun('git ls-files --others --exclude-standard', { cwd })
  if (res == null) return 0
  let out = res.trim()
  if (!out.length) return 0
  return out.split('\n').length
}

interface Decorator {
  changedDecorator: string
  conflictedDecorator: string
  stagedDecorator: string
  untrackedDecorator: string
}

export async function gitStatus(cwd: string, character: string, decorator: Decorator): Promise<string> {
  let res = await Promise.all([gitBranch(cwd), gitChanged(cwd), gitStaged(cwd), gitUntracked(cwd)])
  if (!res[0]) return ''
  let [branch, changed, staged, untracked] = res
  let more = ''
  const { changedDecorator, conflictedDecorator, stagedDecorator, untrackedDecorator } = decorator
  if (changed) more += changedDecorator
  if (staged[0]) more += conflictedDecorator
  if (staged[1]) more += stagedDecorator
  if (untracked) more += untrackedDecorator
  return `${character ? character + ' ' : ''}${branch}${more}`
}
