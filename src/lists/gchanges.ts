import { BasicList, ListContext, Uri, ListItem, Neovim, Location, Range } from 'coc.nvim'
import Manager from '../manager'
import path from 'path'
import colors from 'colors/safe'
import { DiffCategory } from '../types'

export default class GChanges extends BasicList {
  public readonly name = 'gchanges'
  public readonly description = 'Git changes of repository'
  public readonly defaultAction = 'open'

  constructor(nvim: Neovim, private manager: Manager) {
    super()
    this.addLocationActions()
  }

  public async loadItems(context: ListContext): Promise<ListItem[]> {
    let buf = await context.window.buffer;
    let root = await this.manager.resolveGitRootFromBufferOrCwd(buf.id);
    if (!root) {
      throw new Error(`Can't resolve git root.`);
      return;
    }

    let args = context.args;
    let category = DiffCategory.All;
    if (args.indexOf('--cached') !== -1) {
      category = DiffCategory.Staged;
    } else if (args.indexOf('--unstaged') !== -1) {
      category = DiffCategory.Unstaged;
    } else {
      category = DiffCategory.All;
    }
    let res: ListItem[] = [];
    let diffGroups = await this.manager.getDiffAll(category);
    for (let [file, diffs] of diffGroups) {
      for (let diff of diffs) {
        let uri = Uri.file(path.join(root, file)).toString();
        let location = Location.create(
          uri,
          Range.create(diff.start - 1, 0, diff.end - 1, 0)
        );
        res.push({
          label: `${colors.cyan(file)}:${colors.green(diff.start.toString())} ${diff.lines[0]}`,
          sortText: `${file}:${diff.start}`,
          data: { uri },
          location,
        });
      }
    }
    return res;
  }
}
