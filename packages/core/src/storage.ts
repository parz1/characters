import { mkdir, open, rename, unlink, readdir, rmdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { CharactersError } from './errors.js'
import {
  containedPath,
  decodeUtf8,
  exists,
  isErrno,
  readBytes,
} from './files.js'
import { newId, sha256, utcNow } from './ids.js'
import {
  transactionSchema,
  receiptSchema,
  writeLockSchema,
  idSchema,
  workspaceSchema,
  digestSchema,
} from './schemas.js'
import type { TransactionRecord } from './schemas.js'
import { validate } from './validation.js'
import type { WorkspaceHandle } from './workspace.js'
import { parseYaml } from './characters.js'

export type StorageBoundary =
  | 'locked'
  | 'staged'
  | 'prepared'
  | 'applied'
  | 'committed'
export interface StorageOptions {
  /** Runs under the lock, including before returning an idempotency receipt. */
  authorize?: () => Promise<void>
  validateReplay?: (result: unknown) => Promise<void>
  beforeCommit?: () => Promise<void>
  checkpoint?: (
    boundary: StorageBoundary,
    operationIndex?: number,
  ) => void | Promise<void>
  requestId?: string
  fingerprint?: string
}
const LIMIT = 16 * 1024 * 1024
export const jsonBytes = (value: unknown): Buffer =>
  Buffer.from(`${JSON.stringify(value, null, 2)}\n`)

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  const encoded = JSON.stringify(value)
  if (encoded === undefined)
    throw new CharactersError(
      'INVALID_INPUT',
      '数据不能序列化为 JSON。',
      '使用普通 JSON 数据。',
    )
  return encoded
}

export async function readJson<T>(
  root: string,
  ref: string,
  schema: z.ZodType<T>,
  limit = LIMIT,
): Promise<T> {
  const bytes = await readBytes(root, ref, limit)
  let input: unknown
  try {
    input = JSON.parse(decodeUtf8(bytes))
  } catch {
    throw new CharactersError(
      'STORE_CORRUPT',
      '持久记录不是有效 JSON。',
      '检查数据或从可信备份恢复；不会覆盖原文。',
    )
  }
  return validate(schema, input, 'STORE_CORRUPT')
}

async function writeSynced(
  root: string,
  ref: string,
  bytes: Uint8Array,
  createParents = true,
): Promise<void> {
  const filename = await containedPath(root, ref)
  if (createParents) await mkdir(path.dirname(filename), { recursive: true })
  const handle = await open(await containedPath(root, ref), 'wx')
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function currentDigest(
  root: string,
  ref: string,
): Promise<string | null> {
  if (!(await exists(await containedPath(root, ref)))) return null
  return sha256(await readBytes(root, ref, LIMIT))
}

// Reaping is serialized inside the old lock directory. Re-read the owner after
// acquiring the reaper claim, so a delayed reaper cannot delete a replacement lock.
async function acquire(
  root: string,
  ref = '.runtime/write.lock',
): Promise<() => Promise<void>> {
  const filename = await containedPath(root, ref)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await mkdir(filename)
      const owner = {
        schemaVersion: 1,
        token: randomUUID(),
        pid: process.pid,
        host: hostname(),
        createdAt: utcNow(),
      }
      await writeSynced(root, `${ref}/owner.json`, jsonBytes(owner))
      return async () => {
        const actual = await readJson(
          root,
          `${ref}/owner.json`,
          writeLockSchema,
        )
        if (actual.token !== owner.token)
          throw new CharactersError(
            'RECOVERY_REQUIRED',
            '写锁所有者发生变化。',
            '停止操作并检查锁文件。',
          )
        await unlink(await containedPath(root, `${ref}/owner.json`))
        for (let retry = 0; ; retry++) {
          try {
            await rmdir(await containedPath(root, ref))
            break
          } catch (error) {
            if (!isErrno(error, 'ENOTEMPTY') || retry >= 20) throw error
            await delay(10)
          }
        }
      }
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error
    }
    let owner
    try {
      owner = await readJson(root, `${ref}/owner.json`, writeLockSchema)
    } catch {
      throw new CharactersError(
        'BUSY',
        '写锁不完整或来自旧版本，不能证明原进程已退出。',
        '等待初始化完成，或保留现场检查；不会按文件年龄删除锁。',
      )
    }
    if (owner.host !== hostname())
      throw new CharactersError(
        'BUSY',
        '写锁属于其他主机。',
        '在原主机确认进程状态后处理。',
      )
    try {
      process.kill(owner.pid, 0)
      throw new CharactersError(
        'BUSY',
        '工作区正在被其他操作使用。',
        '等待该进程完成后重试。',
      )
    } catch (error) {
      if (!isErrno(error, 'ESRCH')) {
        if (error instanceof CharactersError) throw error
        throw new CharactersError(
          'BUSY',
          '无法证明锁的所有者已经退出。',
          '检查进程权限和状态后重试。',
        )
      }
    }
    const claim = `${ref}/reaping.json`
    try {
      await writeSynced(
        root,
        claim,
        jsonBytes({ pid: process.pid, token: randomUUID() }),
        false,
      )
    } catch (error) {
      if (isErrno(error, 'ENOENT')) continue
      if (isErrno(error, 'EEXIST'))
        throw new CharactersError(
          'RECOVERY_REQUIRED',
          '已有锁回收操作，不能并行接管。',
          '等待回收完成；若回收进程已中断，保留锁目录检查。',
        )
      throw error
    }
    let actual
    try {
      actual = await readJson(root, `${ref}/owner.json`, writeLockSchema)
    } catch {
      await unlink(await containedPath(root, claim)).catch((error) => {
        if (!isErrno(error, 'ENOENT')) throw error
      })
      throw new CharactersError(
        'BUSY',
        '回收期间锁所有者发生变化。',
        '等待并重新打开工作区。',
      )
    }
    if (actual.token !== owner.token) {
      await unlink(await containedPath(root, claim))
      continue
    }
    const quarantine = `.runtime/stale-${owner.token}`
    await rename(
      await containedPath(root, ref),
      await containedPath(root, quarantine),
    )
    await cleanupLock(root, quarantine)
  }
  throw new CharactersError(
    'BUSY',
    '工作区锁持续变化。',
    '等待其他进程退出后重试。',
  )
}

async function cleanupLock(root: string, ref: string): Promise<void> {
  const entries = await readdir(await containedPath(root, ref))
  if (entries.some((name) => !['owner.json', 'reaping.json'].includes(name)))
    throw new CharactersError(
      'RECOVERY_REQUIRED',
      '锁目录有未知内容。',
      '保留该目录检查。',
    )
  for (const name of entries)
    await unlink(await containedPath(root, `${ref}/${name}`))
  await rmdir(await containedPath(root, ref))
}

function validateOperation(ref: string, before: string | null): void {
  const uuid = '[0-9a-f-]{36}'
  const mutable =
    /^contexts\/[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*\/context\.json$/.test(
      ref,
    ) ||
    ref === 'service.yaml' ||
    ref === 'migrations/service-v1/manifest.json' ||
    new RegExp(`^connections/conn_${uuid}\\.json$`).test(ref) ||
    new RegExp(`^bindings/bind_${uuid}/binding\\.json$`).test(ref) ||
    new RegExp(`^states/[a-z][a-z0-9-]*/memories/mem_${uuid}\\.json$`).test(
      ref,
    ) ||
    ref === 'characters.lock' ||
    new RegExp(`^works/work_${uuid}/work\\.json$`).test(ref) ||
    new RegExp(`^sessions/ses_${uuid}/session\\.json$`).test(ref) ||
    new RegExp(`^sessions/ses_${uuid}/runs/run_${uuid}/run\\.json$`).test(ref)
  const immutable =
    new RegExp(
      `^bindings/bind_${uuid}/deliveries/snap_${uuid}/delivery\\.json$`,
    ).test(ref) ||
    new RegExp(`^bindings/bind_${uuid}/proposals/mem_${uuid}\\.txt$`).test(
      ref,
    ) ||
    new RegExp(`^(?:audit/acc_|evidence/evd_)${uuid}\\.json$`).test(ref) ||
    new RegExp(
      `^migrations/service-v1/backups/[a-z][a-z0-9-]*/mem_${uuid}\\.json$`,
    ).test(ref) ||
    ref === 'workspace.yaml' ||
    ref === '.gitignore' ||
    new RegExp(
      `^works/work_${uuid}/revisions/[1-9][0-9]*/(?:revision\\.json|brief\\.md|outline\\.md|draft\\.md|sources\\.json)$`,
    ).test(ref) ||
    new RegExp(`^works/work_${uuid}/proposals/prop_${uuid}\\.json$`).test(
      ref,
    ) ||
    /^objects\/[a-f0-9]{64}\.txt$/.test(ref) ||
    /^packages\/[a-z][a-z0-9-]*\/[a-f0-9]{64}\/(?:character\.yaml|README\.md|[a-zA-Z0-9_./-]+\.md)$/.test(
      ref,
    ) ||
    new RegExp(`^\\.runtime/receipts/${uuid}\\.json$`).test(ref) ||
    new RegExp(`^sessions/ses_${uuid}/messages/msg_${uuid}\\.json$`).test(
      ref,
    ) ||
    new RegExp(`^sessions/ses_${uuid}/requests/${uuid}\\.json$`).test(ref) ||
    new RegExp(
      `^sessions/ses_${uuid}/runs/run_${uuid}/(?:context|input|evidence|events|result)\\.json$`,
    ).test(ref)
  if ((!mutable && !immutable) || (!mutable && before !== null))
    throw new CharactersError(
      'PERMISSION_DENIED',
      '事务目标不属于允许写入的数据对象。',
      '仅通过 Core 数据接口写入受支持的记录。',
    )
}

async function cleanupTransaction(root: string, ref: string): Promise<void> {
  const entries = await readdir(await containedPath(root, ref))
  if (
    entries.some(
      (name) => !/^(?:journal\.json(?:\.tmp)?|stage-[0-9]+)$/.test(name),
    )
  )
    throw new CharactersError(
      'RECOVERY_REQUIRED',
      '事务目录有未知文件。',
      '保留目录检查，不会递归删除未知内容。',
    )
  // Delete the journal last: without it, all visible mutations have been verified.
  for (const name of entries.filter((name) => name !== 'journal.json'))
    await unlink(await containedPath(root, `${ref}/${name}`))
  if (entries.includes('journal.json'))
    await unlink(await containedPath(root, `${ref}/journal.json`))
  await rmdir(await containedPath(root, ref))
}

async function applyJournal(
  workspace: WorkspaceHandle,
  journal: TransactionRecord,
  ref: string,
  options: StorageOptions,
): Promise<void> {
  if (
    journal.workspaceId !== workspace.config.id ||
    ref !== `.runtime/transactions/${journal.id}`
  )
    throw new CharactersError(
      'STORE_CORRUPT',
      '事务不属于当前工作区或目录。',
      '保留事务日志检查。',
    )
  const seen = new Set<string>()
  for (const op of journal.operations) {
    validateOperation(op.ref, op.before)
    if (
      seen.has(op.ref.toLowerCase()) ||
      sha256(Buffer.from(op.content, 'base64')) !== op.after
    )
      throw new CharactersError(
        'STORE_CORRUPT',
        '事务内容摘要或目标重复检查失败。',
        '从可信备份恢复日志。',
      )
    seen.add(op.ref.toLowerCase())
    const actual = await currentDigest(workspace.root, op.ref)
    if (actual !== op.before && actual !== op.after)
      throw new CharactersError(
        'STORE_CORRUPT',
        '事务目标与记录的前后版本不匹配。',
        '不要覆盖目标，先检查外部修改或损坏。',
      )
  }
  for (const [index, op] of journal.operations.entries()) {
    if ((await currentDigest(workspace.root, op.ref)) !== op.after) {
      const staging = `${ref}/stage-${index}`
      const stagePath = await containedPath(workspace.root, staging)
      if (await exists(stagePath)) {
        if ((await currentDigest(workspace.root, staging)) !== op.after)
          throw new CharactersError(
            'STORE_CORRUPT',
            '事务临时文件被修改。',
            '保留日志与临时文件检查。',
          )
      } else
        await writeSynced(
          workspace.root,
          staging,
          Buffer.from(op.content, 'base64'),
        )
      const target = await containedPath(workspace.root, op.ref)
      await mkdir(path.dirname(target), { recursive: true })
      await rename(
        await containedPath(workspace.root, staging),
        await containedPath(workspace.root, op.ref),
      )
    }
    await options.checkpoint?.('applied', index)
  }
  await options.checkpoint?.('committed')
  await cleanupTransaction(workspace.root, ref)
}

async function recoverLocked(
  workspace: WorkspaceHandle,
  options: StorageOptions = {},
): Promise<number> {
  let recovered = 0
  const directory = '.runtime/transactions'
  await mkdir(await containedPath(workspace.root, directory), {
    recursive: true,
  })
  const names = (
    await readdir(await containedPath(workspace.root, directory))
  ).sort()
  let prepared = 0
  for (const name of names) {
    validate(idSchema('txn'), name, 'STORE_CORRUPT')
    if (
      await exists(
        await containedPath(
          workspace.root,
          `${directory}/${name}/journal.json`,
        ),
      )
    )
      prepared++
  }
  if (prepared > 1)
    throw new CharactersError(
      'STORE_CORRUPT',
      '串行写入工作区存在多个已准备事务。',
      '保留日志检查顺序，不能猜测提交顺序。',
    )
  for (const name of names) {
    validate(idSchema('txn'), name, 'STORE_CORRUPT')
    const ref = `${directory}/${name}`
    if (
      await exists(await containedPath(workspace.root, `${ref}/journal.json`))
    ) {
      const journal = await readJson(
        workspace.root,
        `${ref}/journal.json`,
        transactionSchema,
      )
      await applyJournal(workspace, journal, ref, options)
      recovered++
    } else await cleanupTransaction(workspace.root, ref)
  }
  for (const name of await readdir(
    await containedPath(workspace.root, '.runtime'),
  )) {
    if (/^stale-[a-f0-9-]{36}$/.test(name))
      await cleanupLock(workspace.root, `.runtime/${name}`)
  }
  return recovered
}

export class FileTransaction {
  private operations: TransactionRecord['operations'] = []
  constructor(readonly workspace: WorkspaceHandle) {}

  async put(
    ref: string,
    content: Uint8Array,
    expectedDigest: string | null = null,
  ): Promise<void> {
    validateOperation(ref, expectedDigest)
    if (content.length > LIMIT / 2)
      throw new CharactersError(
        'INVALID_INPUT',
        '单条事务内容过大。',
        '缩减文档大小。',
      )
    const actual = await currentDigest(this.workspace.root, ref)
    const after = sha256(content)
    const staged = this.operations.find(
      (operation) => operation.ref.toLowerCase() === ref.toLowerCase(),
    )
    if (staged) {
      if (
        staged.ref === ref &&
        staged.after === after &&
        staged.before === expectedDigest
      )
        return
      throw new CharactersError(
        'INVALID_INPUT',
        '同一事务不能对同一目标提交不同内容。',
        '先合并修改，再提交一次。',
      )
    }
    if (actual === after && expectedDigest === null) return // immutable deduplication
    if (actual !== expectedDigest)
      throw new CharactersError(
        'CONFLICT',
        '文件版本已改变。',
        '重新读取最新版本并调整修改。',
      )
    this.operations.push({
      ref,
      before: actual,
      after,
      content: Buffer.from(content).toString('base64'),
    })
  }

  async commit(options: StorageOptions): Promise<void> {
    if (!this.operations.length) return
    const journal = validate(transactionSchema, {
      schemaVersion: 1,
      id: newId('txn'),
      workspaceId: this.workspace.config.id,
      createdAt: utcNow(),
      operations: this.operations,
    })
    const bytes = jsonBytes(journal)
    if (bytes.length > LIMIT)
      throw new CharactersError(
        'INVALID_INPUT',
        '事务超过大小限制。',
        '将操作拆成独立的作品修改。',
      )
    const ref = `.runtime/transactions/${journal.id}`
    await mkdir(await containedPath(this.workspace.root, ref), {
      recursive: true,
    })
    await writeSynced(this.workspace.root, `${ref}/journal.json.tmp`, bytes)
    await options.checkpoint?.('staged')
    await rename(
      await containedPath(this.workspace.root, `${ref}/journal.json.tmp`),
      await containedPath(this.workspace.root, `${ref}/journal.json`),
    )
    await options.checkpoint?.('prepared')
    await applyJournal(this.workspace, journal, ref, options)
  }
}

async function verifyWorkspaceIdentity(
  workspace: WorkspaceHandle,
): Promise<void> {
  const configPath = await containedPath(workspace.root, 'workspace.yaml')
  let id: string
  if (await exists(configPath)) {
    let value: unknown
    try {
      value = parseYaml(
        decodeUtf8(
          await readBytes(workspace.root, 'workspace.yaml', 64 * 1024),
        ),
      )
    } catch {
      throw new CharactersError(
        'STORE_CORRUPT',
        '工作区配置损坏。',
        '检查配置或备份。',
      )
    }
    id = validate(workspaceSchema, value, 'STORE_CORRUPT').id
  } else {
    const bootstrap = await readJson(
      workspace.root,
      '.initializing',
      z.strictObject({ schemaVersion: z.literal(1), config: workspaceSchema }),
    )
    id = bootstrap.config.id
  }
  if (id !== workspace.config.id)
    throw new CharactersError(
      'PERMISSION_DENIED',
      '目录已被替换为另一个工作区。',
      '重新打开正确的工作区。',
    )
}

export async function withStore<T>(
  workspace: WorkspaceHandle,
  operation: (transaction: FileTransaction) => Promise<T>,
  options: StorageOptions = {},
): Promise<T> {
  const release = await acquire(workspace.root)
  try {
    await verifyWorkspaceIdentity(workspace)
    await recoverLocked(workspace)
    await options.authorize?.()
    await options.checkpoint?.('locked')
    const requestId = options.requestId
      ? validate(z.uuid(), options.requestId).toLowerCase()
      : undefined
    if (requestId && !options.fingerprint)
      throw new CharactersError(
        'INVALID_INPUT',
        '去重请求缺少指纹。',
        '通过领域接口提供完整请求。',
      )
    if (requestId) validate(digestSchema, options.fingerprint)
    const receiptRef = requestId
      ? `.runtime/receipts/${requestId}.json`
      : undefined
    if (
      receiptRef &&
      (await exists(await containedPath(workspace.root, receiptRef)))
    ) {
      const receipt = await readJson(workspace.root, receiptRef, receiptSchema)
      if (
        receipt.requestId !== requestId ||
        sha256(canonicalJson(receipt.result)) !== receipt.resultDigest
      )
        throw new CharactersError(
          'STORE_CORRUPT',
          '请求回执损坏。',
          '检查回执备份，避免重复提交。',
        )
      if (receipt.fingerprint !== options.fingerprint)
        throw new CharactersError(
          'CONFLICT',
          'requestId 已用于不同内容。',
          '重试原请求，或为新操作使用新的 requestId。',
        )
      await options.validateReplay?.(receipt.result)
      return receipt.result as T
    }
    const transaction = new FileTransaction(workspace)
    const result = await operation(transaction)
    if (receiptRef)
      await transaction.put(
        receiptRef,
        jsonBytes({
          schemaVersion: 1,
          requestId,
          fingerprint: options.fingerprint,
          result,
          resultDigest: sha256(canonicalJson(result)),
        }),
      )
    await options.beforeCommit?.()
    await transaction.commit(options)
    return result
  } finally {
    await release()
  }
}

/** Independent lifetime lease; never hold the transaction lock while serving. */
export async function acquireServiceLease(
  workspace: WorkspaceHandle,
): Promise<() => Promise<void>> {
  const release = await acquire(
    workspace.root,
    '.runtime/service/instance.lock',
  )
  try {
    await verifyWorkspaceIdentity(workspace)
    return release
  } catch (error) {
    await release()
    throw error
  }
}

export async function recoverWorkspaceStorage(
  workspace: WorkspaceHandle,
  options: StorageOptions = {},
): Promise<number> {
  const release = await acquire(workspace.root)
  try {
    await verifyWorkspaceIdentity(workspace)
    return await recoverLocked(workspace, options)
  } finally {
    await release()
  }
}
