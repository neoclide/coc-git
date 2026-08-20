export interface StatusEntry {
  index: string
  tree: string
  relative: string
}

export function parseStatusEntries(output: string): StatusEntry[] {
  const result: StatusEntry[] = []
  const entries = output.split('\0')
  for (let i = 0; i < entries.length; i++) {
    const line = entries[i]
    if (!line) continue
    result.push({ index: line[0], tree: line[1], relative: line.slice(3) })
    if (line[0] === 'R' || line[0] === 'C' || line[1] === 'R' || line[1] === 'C') {
      i++ // porcelain -z emits the original path as the following record
    }
  }
  return result
}
