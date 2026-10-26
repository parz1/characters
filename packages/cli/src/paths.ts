import { fileURLToPath } from 'node:url'
import { CharactersError } from '@characters/core'

/** Fixed application-local data; never infer a workspace from the caller's CWD. */
export function workspacePath(
  explicit?: string,
  moduleUrl = import.meta.url,
): string {
  if (explicit !== undefined) {
    if (!explicit.trim())
      throw new CharactersError(
        'INVALID_INPUT',
        '数据目录不能为空。',
        '省略 --workspace 使用应用默认目录，或提供有效路径。',
      )
    return explicit
  }
  return fileURLToPath(new URL('../../../.local/data', moduleUrl))
}
