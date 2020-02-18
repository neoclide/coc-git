
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
  removed: {
    start: number
    count: number
  }
  added: {
    start: number
    count: number
  }
  lines: string[]
}

export interface SignInfo {
  lnum: number
  changeType: ChangeType | 'topdelete' | 'changedelete'
  signId: number
}
