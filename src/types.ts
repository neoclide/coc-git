
export enum ChangeType {
  Add = 'add',
  Change = 'changed',
  Delete = 'delete'
}

export interface Diff {
  changeType: ChangeType
  start: number
  end: number
  head: string
  lines: string[]
  // removed count and added count
  delta?: [number, number]
}

export interface SignInfo {
  lnum: number
  changeType: ChangeType | 'topdelete' | 'bottomdelete'
  signId: number
}
