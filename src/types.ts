
export interface GitConfiguration {
  remoteName: string
  diffRevision: string
  diffOptions: string[]
  issueFormat: string
  virtualTextPrefix: string
  addGBlameToVirtualText: boolean
  addGBlameToBufferVar: boolean
  blameUseRealTime: boolean
  enableGutters: boolean
  realtimeGutters: boolean
  signPriority: number
  foldContext: number,
  pushArguments: string[]
  splitWindowCommand: string
  showCommitInFloating: boolean
  changedSign: {
    text: string
    hlGroup: string
  }
  addedSign: {
    text: string
    hlGroup: string
  }
  removedSign: {
    text: string
    hlGroup: string
  }
  topRemovedSign: {
    text: string
    hlGroup: string
  }
  changeRemovedSign: {
    text: string
    hlGroup: string
  }
  conflict: {
    enabled: boolean
    currentHlGroup: string
    incomingHlGroup: string
    commonHlGroup: string
  }
  floatConfig: {
    border?: boolean
    rounded?: boolean
    highlight?: string
    title?: string
    borderhighlight?: string
    close?: boolean
    maxHeight?: number
    maxWidth?: number
    winblend?: number
    focusable?: boolean
    shadow?: boolean
  }
  virtualTextSrcId: number
  conflictSrcId: number
  gstatus: {
    saveBeforeOpen: boolean
  }
}

export interface BlameInfo {
  sha: string
  index: string
  startLnum: number
  endLnum: number
  author?: string
  time?: string
  summary?: string
}


export enum ChangeType {
  Add = 'add',
  Change = 'changed',
  Delete = 'delete'
}

export interface Decorator {
  changedDecorator: string
  conflictedDecorator: string
  stagedDecorator: string
  untrackedDecorator: string
}

export interface StageChunk {
  remove: {
    lnum: number
    count: number
  }
  add: {
    lnum: number
    count: number
  }
  lines: string[]
}

export interface DiffChunks {
  [relpath: string]: StageChunk[]
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

export enum DiffCategory {
  All,
  Staged,
  Unstaged,
}

export interface Conflict {
  start: number
  common?: number
  sep: number
  end: number
  current: string
  incoming: string
}

export interface SignInfo {
  lnum: number
  changeType: ChangeType | 'topdelete' | 'changedelete'
}

export interface FoldSettings {
  foldmethod: string
  foldlevel: number
  foldenable: boolean
}

export enum ConflictParseState {
  Initial,
  MatchedStart,
  MatchedCommon,
  MatchedSep,
}

export enum ConflictPart {
  Current,
  Incoming,
  Both,
}

