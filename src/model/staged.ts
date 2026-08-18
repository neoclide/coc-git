import { ChangeKind, ChangeLayer, Diff, GutterSign, GitChange } from '../types'

export interface LineMapping {
  /** Entries are one-based line numbers, indexed by INDEX line minus one. */
  indexToBuffer: Array<number | undefined>
  /** Keys are INDEX insertion/deletion anchors and values are BUFFER lines. */
  insertionAnchors: Map<number, number>
}

function changeKind(diff: Diff): ChangeKind {
  if (diff.changeType === 'add') return 'add'
  if (diff.changeType === 'delete') return diff.start === 0 ? 'topDelete' : 'delete'
  return diff.removed.count > diff.added.count ? 'changeDelete' : 'change'
}

export function changesFromDiffs(diffs: readonly Diff[], layer: ChangeLayer): GitChange[] {
  return diffs.map(diff => ({
    kind: changeKind(diff),
    layer,
    line: diff.start,
    endLine: diff.end,
    sourceLine: diff.removed.start,
    sourceEndLine: diff.removed.start + diff.removed.count - 1,
    sourceCount: diff.removed.count,
    targetCount: diff.added.count
  }))
}

function createHunkMapping(
  indexLines: readonly string[],
  bufferLines: readonly string[],
  changes: readonly GitChange[]
): LineMapping | undefined {
  const hunks = changes
    .filter(change => change.sourceLine != null && change.sourceCount != null && change.targetCount != null)
    .map(change => ({
      oldStart: change.sourceLine as number,
      oldCount: change.sourceCount as number,
      newStart: change.line,
      newCount: change.targetCount as number
    }))
    .sort((a, b) => a.oldStart - b.oldStart || a.newStart - b.newStart)
  if (hunks.length === 0) return undefined

  const indexToBuffer: Array<number | undefined> = Array(indexLines.length)
  const insertionAnchors = new Map<number, number>()
  let oldCursor = 1
  let newCursor = 1
  for (const hunk of hunks) {
    if (hunk.oldStart < oldCursor) continue
    const unchanged = hunk.oldStart - oldCursor
    for (let index = 0; index < unchanged; index++) {
      const oldLine = oldCursor + index
      const newLine = newCursor + index
      if (oldLine <= indexLines.length && newLine <= bufferLines.length) indexToBuffer[oldLine - 1] = newLine
    }
    const anchor = Math.max(1, Math.min(bufferLines.length || 1, hunk.newStart || newCursor))
    insertionAnchors.set(hunk.oldStart, anchor)
    for (let index = 0; index < hunk.oldCount; index++) {
      const oldLine = hunk.oldStart + index
      if (oldLine > indexLines.length) break
      if (index < hunk.newCount) {
        const newLine = hunk.newStart + index
        if (newLine >= 1 && newLine <= bufferLines.length) indexToBuffer[oldLine - 1] = newLine
      }
    }
    oldCursor = hunk.oldStart + hunk.oldCount
    newCursor = hunk.newStart + hunk.newCount
  }
  for (let index = oldCursor; index <= indexLines.length; index++) {
    const newLine = newCursor + index - oldCursor
    if (newLine <= bufferLines.length) indexToBuffer[index - 1] = newLine
  }
  return { indexToBuffer, insertionAnchors }
}

/**
 * Build an INDEX to BUFFER map from the same hunks used for the unstaged diff.
 * The small LCS fallback makes this helper useful with plain GitChange values
 * in unit tests; production changes carry the exact hunk coordinates above.
 */
export function createLineMapping(
  indexLines: readonly string[],
  bufferLines: readonly string[],
  unstagedChanges: readonly GitChange[]
): LineMapping {
  const fromHunks = createHunkMapping(indexLines, bufferLines, unstagedChanges)
  if (fromHunks) return fromHunks
  if (unstagedChanges.length === 0) {
    return {
      indexToBuffer: indexLines.map((_, index) => index + 1 <= bufferLines.length ? index + 1 : undefined),
      insertionAnchors: new Map()
    }
  }

  const indexToBuffer: Array<number | undefined> = Array(indexLines.length)
  const insertionAnchors = new Map<number, number>()
  const rows = indexLines.length + 1
  const cols = bufferLines.length + 1
  const table: number[][] = Array.from({ length: rows }, () => Array<number>(cols).fill(0))
  for (let i = indexLines.length - 1; i >= 0; i--) {
    for (let j = bufferLines.length - 1; j >= 0; j--) {
      table[i][j] = indexLines[i] === bufferLines[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  let i = 0
  let j = 0
  while (i < indexLines.length && j < bufferLines.length) {
    if (indexLines[i] === bufferLines[j]) {
      indexToBuffer[i] = j + 1
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i++
    } else {
      insertionAnchors.set(i + 1, j + 1)
      j++
    }
  }
  if (i < indexLines.length) insertionAnchors.set(i + 1, Math.max(1, Math.min(bufferLines.length || 1, j + 1)))
  return { indexToBuffer, insertionAnchors }
}

function resolveMappedLine(line: number, mapping: LineMapping, bufferLineCount: number): number {
  const direct = line > 0 ? mapping.indexToBuffer[line - 1] : undefined
  if (direct != null) return direct
  const anchor = mapping.insertionAnchors.get(line)
  if (anchor != null) return Math.max(1, Math.min(bufferLineCount || 1, anchor))
  if (bufferLineCount === 0) return 1
  if (line <= 0) return 1
  for (let index = Math.min(line - 1, mapping.indexToBuffer.length - 1); index >= 0; index--) {
    const mapped = mapping.indexToBuffer[index]
    if (mapped != null) return Math.min(bufferLineCount, mapped + line - index - 1)
  }
  return Math.min(bufferLineCount, line)
}

export function mapIndexChangesToBuffer(
  stagedChanges: readonly GitChange[],
  mapping: LineMapping,
  bufferLineCount: number
): GitChange[] {
  return stagedChanges.map(change => {
    const isDeletion = change.kind === 'delete' || change.kind === 'topDelete'
    const sourceLine = isDeletion && change.sourceLine != null ? change.sourceLine : change.line
    const sourceEndLine = isDeletion && change.sourceEndLine != null
      ? change.sourceEndLine
      : (change.endLine ?? change.line)
    const line = resolveMappedLine(sourceLine, mapping, bufferLineCount)
    const endLine = Math.max(line, resolveMappedLine(sourceEndLine, mapping, bufferLineCount))
    return { ...change, line, endLine }
  })
}

export function gutterSignsFromChanges(changes: readonly GitChange[]): GutterSign[] {
  const result: GutterSign[] = []
  for (const change of changes) {
    const start = change.line === 0 ? 1 : Math.max(1, change.line)
    const end = Math.max(start, change.endLine ?? start)
    if (change.kind === 'delete' || change.kind === 'topDelete') {
      result.push({ line: start, kind: change.kind, layer: change.layer })
      continue
    }
    for (let line = start; line <= end; line++) {
      result.push({ line, kind: line === end && change.kind === 'changeDelete' ? 'changeDelete' : change.kind, layer: change.layer })
    }
    if (change.kind === 'change' && (change.targetCount ?? 0) > (change.sourceCount ?? 0)) {
      const extra = (change.targetCount as number) - (change.sourceCount as number)
      for (let index = 0; index < extra; index++) {
        result.push({ line: end + 1 + index, kind: 'add', layer: change.layer })
      }
    }
  }
  return result
}

export function mergeGutterSigns(unstaged: readonly GutterSign[], staged: readonly GutterSign[]): GutterSign[] {
  const merged = new Map<number, GutterSign>()
  for (const sign of [...staged, ...unstaged]) {
    const current = merged.get(sign.line)
    if (!current) {
      merged.set(sign.line, sign)
    } else if (current.layer !== sign.layer) {
      merged.set(sign.line, { line: sign.line, kind: 'mixed', layer: 'mixed' })
    } else if (current.layer === 'unstaged' || sign.layer === 'unstaged') {
      merged.set(sign.line, sign.layer === 'unstaged' ? sign : current)
    }
  }
  return [...merged.values()].sort((a, b) => a.line - b.line)
}
