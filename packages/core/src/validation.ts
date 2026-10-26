import { z } from 'zod'
import { CharactersError } from './errors.js'

export function validate<T>(
  schema: z.ZodType<T>,
  input: unknown,
  code: 'INVALID_INPUT' | 'STORE_CORRUPT' = 'INVALID_INPUT',
): T {
  const result = schema.safeParse(input)
  if (!result.success) {
    const locations = result.error.issues
      .map((issue) => issue.path.join('.') || '(root)')
      .join(', ')
    throw new CharactersError(
      code,
      `数据结构不合法：${locations}。`,
      '按 schemas 中的格式修正字段；不支持的数据版本需要显式迁移。',
    )
  }
  return result.data
}
