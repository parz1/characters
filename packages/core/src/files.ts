import { lstat, open, realpath, readdir } from 'node:fs/promises'
import path from 'node:path'
import { CharactersError } from './errors.js'
import { relativePathSchema } from './schemas.js'
import { validate } from './validation.js'

export function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

export async function exists(filename: string): Promise<boolean> {
  try {
    await lstat(filename)
    return true
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false
    throw error
  }
}

export async function directoryRoot(directory: string): Promise<string> {
  const absolute = path.resolve(directory)
  let info
  try {
    info = await lstat(absolute)
  } catch (error) {
    if (isErrno(error, 'ENOENT'))
      throw new CharactersError(
        'NOT_FOUND',
        '目录不存在。',
        '检查显式提供的目录。',
      )
    throw error
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new CharactersError(
      'PERMISSION_DENIED',
      '目录不能是符号链接或 junction。',
      '选择实际目录。',
    )
  }
  return realpath(absolute)
}

export async function containedPath(
  root: string,
  reference: string,
): Promise<string> {
  validate(relativePathSchema, reference)
  // Recheck handles before every operation; a root can be replaced after opening.
  if ((await directoryRoot(root)) !== root) {
    throw new CharactersError(
      'PERMISSION_DENIED',
      '数据根目录已发生变化。',
      '重新打开可信工作区。',
    )
  }
  const target = path.resolve(root, ...reference.split('/'))
  const rel = path.relative(root, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new CharactersError(
      'PERMISSION_DENIED',
      '路径超出数据根目录。',
      '使用根目录内的相对引用。',
    )
  }
  let cursor = root
  for (const part of reference.split('/')) {
    cursor = path.join(cursor, part)
    try {
      const info = await lstat(cursor)
      if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) {
        throw new CharactersError(
          'PERMISSION_DENIED',
          '数据引用不能经过链接或硬链接。',
          '将文件复制为独立的普通文件。',
        )
      }
    } catch (error) {
      if (isErrno(error, 'ENOENT')) break
      throw error
    }
  }
  return target
}

export async function readBytes(
  root: string,
  reference: string,
  limit: number,
): Promise<Buffer> {
  const filename = await containedPath(root, reference)
  return readBoundedFile(filename, limit)
}

// Explicit CLI imports may have Unicode/spaces in their original names. Internal
// references remain portable IDs, never these user-supplied filesystem paths.
export async function readImportText(
  filename: string,
  limit = 1024 * 1024,
): Promise<string> {
  const absolute = path.resolve(filename)
  const root = await directoryRoot(path.dirname(absolute))
  const resolved = path.join(root, path.basename(absolute))
  let info
  try {
    info = await lstat(resolved)
  } catch (error) {
    if (isErrno(error, 'ENOENT'))
      throw new CharactersError(
        'NOT_FOUND',
        '导入文件不存在。',
        '检查显式提供的文件路径。',
      )
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1)
    throw new CharactersError(
      'PERMISSION_DENIED',
      '导入目标必须是独立普通文件。',
      '复制为普通文件后导入。',
    )
  return decodeUtf8(await readBoundedFile(resolved, limit))
}

async function readBoundedFile(
  filename: string,
  limit: number,
): Promise<Buffer> {
  let handle
  try {
    handle = await open(filename, 'r')
  } catch (error) {
    if (isErrno(error, 'ENOENT'))
      throw new CharactersError(
        'NOT_FOUND',
        '引用的文件不存在。',
        '检查角色清单或工作区文件。',
      )
    throw error
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.nlink > 1)
      throw new CharactersError(
        'PERMISSION_DENIED',
        '引用必须是独立的普通文件。',
        '复制文件后重试。',
      )
    if (info.size > limit)
      throw new CharactersError(
        'INVALID_INPUT',
        '文件超过大小限制。',
        '缩减文件内容后重试。',
      )
    const buffer = Buffer.alloc(limit + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      )
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset > limit)
      throw new CharactersError(
        'INVALID_INPUT',
        '文件超过大小限制。',
        '缩减文件内容后重试。',
      )
    return buffer.subarray(0, offset)
  } finally {
    await handle.close()
  }
}

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new CharactersError(
      'INVALID_INPUT',
      '文件不是有效的 UTF-8 文本。',
      '以 UTF-8 编码保存后重试。',
    )
  }
}

export async function listPackageFiles(root: string): Promise<string[]> {
  const files: string[] = []
  let entries = 0
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++entries > 128)
        throw new CharactersError(
          'INVALID_INPUT',
          '角色包条目过多。',
          '将角色包缩减到 128 个目录和文件以内。',
        )
      const ref = prefix ? `${prefix}/${entry.name}` : entry.name
      const filename = await containedPath(root, ref)
      if (entry.isDirectory()) await walk(filename, ref)
      else if (entry.isFile()) files.push(ref)
      else
        throw new CharactersError(
          'PERMISSION_DENIED',
          '角色包包含非普通文件。',
          '移除链接和特殊文件。',
        )
    }
  }
  await walk(root, '')
  return files.sort()
}
