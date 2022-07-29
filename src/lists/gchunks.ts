import { BasicList, ListContext, ListItem, Neovim, window } from 'coc.nvim'
import Manager from '../manager'
import { StageChunk } from '../types'
import colors from 'colors/safe'

export default class GChunks extends BasicList {
  public readonly name = 'gchunks'
  public readonly description = 'Git changes of current buffer'
  public readonly defaultAction = 'jump'

  constructor(nvim: Neovim, private manager: Manager) {
    super(nvim)
    this.actions.push({
      name: 'jump',
      execute: item => {
        if (Array.isArray(item)) return
        window.moveTo({ line: Math.max(item.data.line - 1, 0), character: 0 })
      }
    })
  }

  public async loadItems(context: ListContext): Promise<ListItem[]> {
    let buf = this.manager.getBuffer(context.buffer.id)
    if (!buf) {
      throw new Error(`Can't resolve git root.`)
      return
    }
    let res: ListItem[] = []
    let diffs = buf.cachedDiffs
    if (diffs && diffs.length > 0) {
      for (let diff of diffs) {
        let stagedSign = ' '
        res.push({
          label: `${stagedSign} Line:${diff.start} ${diff.lines[0]}`,
          sortText: `${diff.start}`,
          data: {
            line: diff.start
          }
        })
      }
    }
    try { 
      let { relpath } = buf
      let stagedDiff = await buf.repo.getStagedChunks(relpath)
      let chunks: StageChunk[] = Object.values(stagedDiff)[0]
      if (chunks.length > 0) {
        for (let diff of chunks) {
          let adjust = 0
          let stagedSign = colors.green('*')
          let line = diff.add.lnum
          for (let diff of diffs) {
            if (diff.end >= line) {
              break
            }
            adjust += diff.added.count
            adjust -= diff.removed.count
          }
          line += adjust
          res.push({
            label: `${stagedSign} Line:${line} ${diff.lines[0]}`,
            data: {
              line: `${line}`
            }
          })
        }
      }
    } catch (e) {
    }
    return res
  }
}
