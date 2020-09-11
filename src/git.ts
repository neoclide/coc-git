import { IGit, cpErrorHandler, onceEvent } from './util'
import * as cp from 'child_process'
import iconv from 'iconv-lite'
import path from 'path'
import { OutputChannel, disposeAll } from 'coc.nvim'
import { CancellationToken, Disposable } from 'vscode-jsonrpc'

export interface SpawnOptions extends cp.SpawnOptions {
  input?: string
  encoding?: string
  log?: boolean
  cancellationToken?: CancellationToken
}

export interface IExecutionResult<T extends string | Buffer> {
  exitCode: number
  stdout: T
  stderr: string
}

export default class Git {
  constructor(
    private gitInfo: IGit,
    private channel: OutputChannel
  ) {
  }

  public async getRepositoryRoot(repositoryPath: string): Promise<string> {
    const result = await this.exec(repositoryPath, ['rev-parse', '--show-toplevel'])
    return path.normalize(result.stdout.trim())
  }

  public async getUsername(repositoryPath: string): Promise<string> {
    const result = await this.exec(repositoryPath, ['config', 'user.name'])
    return result.stdout.trim()
  }

  public async getRepositoryDotGit(repositoryPath: string): Promise<string> {
    const result = await this.exec(repositoryPath, ['rev-parse', '--git-dir'])
    let dotGitPath = result.stdout.trim()

    if (!path.isAbsolute(dotGitPath)) {
      dotGitPath = path.join(repositoryPath, dotGitPath)
    }

    return path.normalize(dotGitPath)
  }

  public async exec(cwd: string, args: string[], options: SpawnOptions = {}): Promise<IExecutionResult<string>> {
    options = Object.assign({ cwd }, options || {})
    return await this._exec(args, options)
  }

  public async isIndexed(relpath: string, root: string): Promise<boolean> {
    let res = await this.exec(root, ['ls-files', relpath])
    return res.stdout && res.stdout.trim().length > 0
  }

  public stream(cwd: string, args: string[], options: SpawnOptions = {}): cp.ChildProcess {
    options = Object.assign({ cwd }, options || {})
    return this.spawn(args, options)
  }

  private async _exec(args: string[], options: SpawnOptions = {}): Promise<IExecutionResult<string>> {
    const child = this.spawn(args, options)

    if (options.input) {
      child.stdin.end(options.input, 'utf8')
    }

    const bufferResult = await exec(child, options.cancellationToken)

    if (options.log !== false && bufferResult.stderr.length > 0) {
      this.log(`${bufferResult.stderr}\n`)
    }

    let encoding = options.encoding || 'utf8'
    encoding = iconv.encodingExists(encoding) ? encoding : 'utf8'

    const result: IExecutionResult<string> = {
      exitCode: bufferResult.exitCode,
      stdout: iconv.decode(bufferResult.stdout, encoding),
      stderr: bufferResult.stderr
    }

    if (bufferResult.exitCode) {
      this.channel.appendLine(`Error ${result.exitCode} on: 'git ${args.join(' ')}' in ${options.cwd}`)
      this.channel.append(result.stderr)
      this.channel.append(result.stdout)
      return Promise.reject(new Error('Failed to execute git'))
    }
    return result
  }

  private spawn(args: string[], options: SpawnOptions = {}): cp.ChildProcess {

    if (!options) {
      options = {}
    }

    if (!options.stdio && !options.input) {
      options.stdio = ['ignore', null, null]
    }

    options.env = Object.assign({}, process.env, options.env || {}, {
      LC_ALL: 'en_US.UTF-8',
      LANG: 'en_US.UTF-8'
    })

    if (options.log !== false) {
      this.log(`> git ${args.join(' ')}\n`)
    }

    return cp.spawn(this.gitInfo.path, args, options)
  }

  private log(output: string): void {
    this.channel.append(output)
  }
}

async function exec(child: cp.ChildProcess, cancellationToken?: CancellationToken): Promise<IExecutionResult<Buffer>> {
  if (!child.stdout || !child.stderr) {
    throw new Error('Failed to get stdout or stderr from git process.')
  }

  if (cancellationToken && cancellationToken.isCancellationRequested) {
    throw new Error('Cancelled')
  }

  const disposables: Disposable[] = []

  const once = (ee: NodeJS.EventEmitter, name: string, fn: (...args: any[]) => void) => {
    ee.once(name, fn)
    disposables.push(Disposable.create(() => ee.removeListener(name, fn)))
  }

  const on = (ee: NodeJS.EventEmitter, name: string, fn: (...args: any[]) => void) => {
    ee.on(name, fn)
    disposables.push(Disposable.create(() => ee.removeListener(name, fn)))
  }

  let result = Promise.all<any>([
    new Promise<number>((c, e) => {
      once(child, 'error', cpErrorHandler(e))
      once(child, 'exit', c)
    }),
    new Promise<Buffer>(c => {
      const buffers: Buffer[] = []
      on(child.stdout, 'data', (b: Buffer) => buffers.push(b))
      once(child.stdout, 'close', () => c(Buffer.concat(buffers)))
    }),
    new Promise<string>(c => {
      const buffers: Buffer[] = []
      on(child.stderr, 'data', (b: Buffer) => buffers.push(b))
      once(child.stderr, 'close', () => c(Buffer.concat(buffers).toString('utf8')))
    })
  ]) as Promise<[number, Buffer, string]>

  if (cancellationToken) {
    const cancellationPromise = new Promise<[number, Buffer, string]>((_, e) => {
      onceEvent(cancellationToken.onCancellationRequested)(() => {
        try {
          child.kill()
        } catch (err) {
          // noop
        }

        e(new Error('Cancelled'))
      })
    })

    result = Promise.race([result, cancellationPromise])
  }

  try {
    const [exitCode, stdout, stderr] = await result
    return { exitCode, stdout, stderr }
  } finally {
    disposeAll(disposables)
  }
}
