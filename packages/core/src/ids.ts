import { randomUUID, createHash } from 'node:crypto'
import type { IdPrefix } from './schemas.js'

export const newId = <P extends IdPrefix>(prefix: P): `${P}_${string}` =>
  `${prefix}_${randomUUID()}`
export const utcNow = (): string => new Date().toISOString()
export const sha256 = (content: string | Uint8Array): string =>
  createHash('sha256').update(content).digest('hex')
