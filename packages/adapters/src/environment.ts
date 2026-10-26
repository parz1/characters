import { mkdir, mkdtemp, lstat, readdir, rm, unlink } from 'node:fs/promises'
import path from 'node:path'
import {
  containedPath,
  directoryRoot,
  exists,
  CharactersError,
} from '@characters/core'

export async function executionDirectory(workspaceRoot: string) {
  const root = await directoryRoot(workspaceRoot)
  const container = await containedPath(root, '.runtime/codex-executions')
  await mkdir(container, { recursive: true })
  const directory = await mkdtemp(path.join(container, 'codex-'))
  for (const ref of ['home', 'work', 'profile', 'appdata', 'localdata', 'tmp'])
    await mkdir(path.join(directory, ref))
  return {
    root,
    directory,
    home: path.join(directory, 'home'),
    cwd: path.join(directory, 'work'),
  }
}

export function isolatedEnvironment(
  directory: string,
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const key of [
    'PATH',
    'PATHEXT',
    'SystemRoot',
    'WINDIR',
    'SystemDrive',
    'COMSPEC',
    'LANG',
    'LC_ALL',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
  ]) {
    if (parent[key] !== undefined) environment[key] = parent[key]
  }
  return {
    ...environment,
    CODEX_HOME: path.join(directory, 'home'),
    HOME: path.join(directory, 'profile'),
    USERPROFILE: path.join(directory, 'profile'),
    APPDATA: path.join(directory, 'appdata'),
    LOCALAPPDATA: path.join(directory, 'localdata'),
    TEMP: path.join(directory, 'tmp'),
    TMP: path.join(directory, 'tmp'),
    TMPDIR: path.join(directory, 'tmp'),
  }
}

export async function removeExecutionDirectory(
  workspaceRoot: string,
  directory: string,
): Promise<void> {
  const root = await directoryRoot(workspaceRoot)
  const relative = path.relative(root, directory).split(path.sep).join('/')
  if (!/^\.runtime\/codex-executions\/codex-[A-Za-z0-9]+$/.test(relative))
    throw new CharactersError(
      'PERMISSION_DENIED',
      '临时目录不属于当前执行空间。',
      '保留目录检查。',
    )
  const checked = await containedPath(root, relative)
  if ((await lstat(checked)).isSymbolicLink())
    throw new CharactersError(
      'PERMISSION_DENIED',
      '临时目录被替换为链接。',
      '保留目录检查。',
    )
  const auth = await containedPath(root, `${relative}/home/auth.json`)
  if (await exists(auth)) await unlink(auth)
  await rm(checked, { recursive: true, force: true })
}

export async function memoryMetadata(home: string): Promise<string> {
  // Metadata only. Never read the user's memory documents or database bodies.
  const rows: Array<[string, string, number, number]> = []
  async function walk(ref: string): Promise<void> {
    const filename = path.join(home, ref)
    let info
    try {
      info = await lstat(filename)
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        rows.push([ref, 'absent', 0, 0])
        return
      }
      throw error
    }
    rows.push([
      ref,
      info.isSymbolicLink()
        ? 'link'
        : info.isDirectory()
          ? 'directory'
          : 'file',
      info.size,
      info.mtimeMs,
    ])
    if (rows.length > 10000)
      throw new CharactersError(
        'ISOLATION_UNSUPPORTED',
        '全局记忆元数据检查超过上限。',
        '检查记忆目录规模后重新验证。',
      )
    if (info.isDirectory() && !info.isSymbolicLink()) {
      for (const child of (await readdir(filename)).sort())
        await walk(path.join(ref, child))
    }
  }
  for (const ref of [
    'memories',
    'memory',
    'memory.md',
    'memory_summary.md',
    'raw_memories.md',
  ])
    await walk(ref)
  return JSON.stringify(rows)
}
