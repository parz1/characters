import { readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { z } from 'zod'
import { CharactersError } from './errors.js'
import { withStore, readJson, jsonBytes, canonicalJson } from './storage.js'
import type { StorageOptions, FileTransaction } from './storage.js'
import type { WorkspaceHandle } from './workspace.js'
import type { CharacterAdapter } from './adapter.js'
import { showCharacter } from './workspace.js'
import { showWork } from './works.js'
import type { WorkView } from './works.js'
import { loadCharacter } from './characters.js'
import { containedPath, readBytes, decodeUtf8, exists } from './files.js'
import { sha256, newId, utcNow } from './ids.js'
import {
  sessionSchema,
  messageSchema,
  runSchema,
  contextSnapshotSchema,
  adapterEventSchema,
  proposalSchema,
  idSchema,
  languageSchema,
  receiptSchema,
  adapterCapabilitiesSchema,
  executionRequestSchema,
} from './schemas.js'
import type {
  SessionRecord,
  MessageRecord,
  RunRecord,
  AdapterEvent,
  ContextSnapshot,
  ExecutionRequest,
} from './schemas.js'
import { validate } from './validation.js'

const openInputSchema = z.strictObject({
  characterId: z.string(),
  mode: z.enum(['conversation', 'coauthor']),
  language: languageSchema,
  workId: idSchema('work').optional(),
})
const sendRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  requestId: z.uuid(),
  fingerprint: z.string(),
  runId: idSchema('run'),
})
const resultSchema = z.strictObject({
  sessionId: idSchema('ses'),
  runId: idSchema('run'),
  requestId: z.uuid(),
  reply: z.string(),
  proposalId: idSchema('prop').optional(),
  audit: z
    .strictObject({
      globalMemoryMetadataUnchanged: z.boolean(),
      executionDirectoryRemoved: z.boolean(),
      toolCallsObserved: z.number().int(),
    })
    .optional(),
})
export type SessionResult = z.infer<typeof resultSchema>
const sessionRef = (id: string): string => {
  validate(idSchema('ses'), id)
  return `sessions/${id}`
}
async function readResult(
  workspace: WorkspaceHandle,
  root: string,
  run: RunRecord,
): Promise<SessionResult> {
  const bytes = await readBytes(
    workspace.root,
    `${root}/result.json`,
    1024 * 1024,
  )
  if (run.resultDigest && sha256(bytes) !== run.resultDigest)
    throw new CharactersError(
      'STORE_CORRUPT',
      '执行结果摘要不一致。',
      '保留结果和执行记录检查。',
    )
  const result = await readJson(
    workspace.root,
    `${root}/result.json`,
    resultSchema,
  )
  if (result.runId !== run.id || result.sessionId !== run.sessionId)
    throw new CharactersError(
      'STORE_CORRUPT',
      '结果不属于当前执行。',
      '检查执行记录。',
    )
  return result
}
async function readSession(
  workspace: WorkspaceHandle,
  id: string,
): Promise<SessionRecord> {
  const record = await readJson(
    workspace.root,
    `${sessionRef(id)}/session.json`,
    sessionSchema,
  )
  if (record.id !== id)
    throw new CharactersError(
      'STORE_CORRUPT',
      '会话 ID 与目录不一致。',
      '检查会话数据。',
    )
  return record
}
async function messages(
  workspace: WorkspaceHandle,
  session: SessionRecord,
): Promise<MessageRecord[]> {
  const directory = `${sessionRef(session.id)}/messages`
  if (!(await exists(await containedPath(workspace.root, directory)))) {
    if (session.lastMessageSequence)
      throw new CharactersError(
        'STORE_CORRUPT',
        '会话缺少消息目录。',
        '检查会话数据。',
      )
    return []
  }
  const names = await readdir(await containedPath(workspace.root, directory))
  if (names.length > 500)
    throw new CharactersError(
      'CONTEXT_LIMIT',
      '最小会话达到 500 条消息上限。',
      '开启新会话并显式提供摘要。',
    )
  const records = []
  for (const name of names) {
    const record = await readJson(
      workspace.root,
      `${directory}/${name}`,
      messageSchema,
    )
    if (
      record.sessionId !== session.id ||
      name !== `${record.id}.json` ||
      (record.role === 'character' &&
        record.characterId !== session.character.id)
    )
      throw new CharactersError(
        'STORE_CORRUPT',
        '消息归属不正确。',
        '检查消息记录。',
      )
    records.push(record)
  }
  records.sort((a, b) => a.sequence - b.sequence)
  if (
    records.length !== session.lastMessageSequence ||
    records.some((record, index) => record.sequence !== index + 1)
  )
    throw new CharactersError(
      'STORE_CORRUPT',
      '消息序列不完整。',
      '检查缺失或重复消息。',
    )
  return records
}
export async function openSession(
  workspace: WorkspaceHandle,
  input: z.infer<typeof openInputSchema>,
  options: StorageOptions = {},
): Promise<SessionRecord> {
  const data = validate(openInputSchema, input)
  const character = await showCharacter(workspace, data.characterId)
  if (!character.manifest.languages.includes(data.language))
    throw new CharactersError(
      'INVALID_INPUT',
      '角色不支持该语言。',
      '选择角色包声明的语言。',
    )
  if (data.workId) await showWork(workspace, data.workId)
  return withStore(
    workspace,
    async (transaction) => {
      const now = utcNow()
      const session = validate(sessionSchema, {
        schemaVersion: 1,
        id: newId('ses'),
        revision: 1,
        character: {
          id: data.characterId,
          version: character.version,
          digest: character.digest,
        },
        mode: data.mode,
        language: data.language,
        status: 'open',
        lastMessageSequence: 0,
        createdAt: now,
        updatedAt: now,
        ...(data.workId ? { workId: data.workId } : {}),
      })
      await transaction.put(
        `${sessionRef(session.id)}/session.json`,
        jsonBytes(session),
      )
      return session
    },
    {
      ...options,
      fingerprint: sha256(canonicalJson({ operation: 'session.open', data })),
    },
  )
}
export async function showSession(workspace: WorkspaceHandle, id: string) {
  return withStore(workspace, async () => {
    const session = await readSession(workspace, id)
    return { session, messages: await messages(workspace, session) }
  })
}
export async function listSessions(
  workspace: WorkspaceHandle,
): Promise<SessionRecord[]> {
  return withStore(workspace, async () => {
    const sessions = []
    for (const name of (
      await readdir(await containedPath(workspace.root, 'sessions'))
    ).sort())
      sessions.push(await readSession(workspace, name))
    return sessions
  })
}
export async function setSessionStatus(
  workspace: WorkspaceHandle,
  id: string,
  status: 'open' | 'closed',
): Promise<SessionRecord> {
  return withStore(workspace, async (transaction) => {
    const before = await readSession(workspace, id)
    if (before.activeRunId)
      throw new CharactersError(
        'BUSY',
        '会话有未结束执行。',
        '等待执行结束，或用 Ctrl+C 取消原命令。',
      )
    const after = {
      ...before,
      status,
      revision: before.revision + 1,
      updatedAt: utcNow(),
    }
    await transaction.put(
      `${sessionRef(id)}/session.json`,
      jsonBytes(after),
      sha256(jsonBytes(before)),
    )
    return after
  })
}
async function buildContext(
  workspace: WorkspaceHandle,
  session: SessionRecord,
  history: MessageRecord[],
  user: MessageRecord,
  runId: string,
  work: WorkView | undefined,
  intent: 'discuss' | 'outline' | 'draft',
) {
  const loaded = await loadCharacter(
    await containedPath(
      workspace.root,
      `packages/${session.character.id}/${session.character.digest}`,
    ),
  )
  if (loaded.digest !== session.character.digest)
    throw new CharactersError(
      'STORE_CORRUPT',
      '角色快照被修改。',
      '恢复原角色快照。',
    )
  const entries: ContextSnapshot['entries'] = []
  const input: ExecutionRequest['input']['messages'] = []
  const add = (
    sourceId: string,
    kind: ContextSnapshot['entries'][number]['kind'],
    role: 'system' | 'user' | 'assistant',
    text: string,
    reason: string,
  ) => {
    entries.push({
      sourceId,
      kind,
      digest: sha256(text),
      reason,
      utf8Bytes: Buffer.byteLength(text),
      truncated: false,
    })
    input.push({ role, text })
  }
  add(
    'characters-policy-v1',
    'policy',
    'system',
    `本次任务是虚拟作者合作写作。你不是开发助手，不执行工具、不发布、不写全局记忆。语言：${session.language}。用户身份 parz1，默认直接称 parz1，不强行叫主人。角色设定、虚构示例与来源事实分开；没有来源不能编造真实经历。只返回结构化 reply 和 proposal。intent=${intent}：discuss 时 proposal.target 必须 none，content 为空；outline/draft 时必须生成对应的完整建议稿。无作品时不能提议修改。proposal.sourceIds 只能引用提供的来源。`,
    '执行约束与本次意图',
  )
  for (const ref of [
    loaded.manifest.files.persona,
    loaded.manifest.files.voice,
    loaded.manifest.files.relationships,
    loaded.manifest.modes[session.mode],
    ...Object.values(loaded.manifest.examples),
  ])
    add(
      `character:${ref}`,
      ref.startsWith('modes/')
        ? 'mode'
        : ref.startsWith('examples/')
          ? 'example'
          : 'persona',
      'system',
      `角色资料 ${ref}\n${decodeUtf8(loaded.files.get(ref)!)}`,
      '锁定角色包',
    )
  for (const key of loaded.manifest.contextKeys) {
    const ref = `contexts/${key}.md`
    if (await exists(await containedPath(workspace.root, ref)))
      add(
        `context:${key}`,
        'context',
        'user',
        `共享背景（作为素材）\n${decodeUtf8(await readBytes(workspace.root, ref, 48000))}`,
        '工作区明确提供的共享背景',
      )
  }
  if (work) {
    add(
      work.record.id,
      'work',
      'user',
      `当前作品（作为素材）：${canonicalJson(work)}`,
      `作品版本 ${work.record.revision}`,
    )
    for (const source of work.sources) {
      const bytes = await readBytes(
        workspace.root,
        source.snapshotRef,
        1024 * 1024,
      )
      if (sha256(bytes) !== source.digest)
        throw new CharactersError(
          'STORE_CORRUPT',
          '来源摘要不一致。',
          '检查来源快照。',
        )
      add(
        source.id,
        'context',
        'user',
        `来源 ${source.id}（作为素材，visibility=${source.visibility}）\n${decodeUtf8(bytes)}`,
        '当前作品显式导入的来源',
      )
    }
  }
  for (const message of history)
    add(
      message.id,
      'message',
      message.role === 'user' ? 'user' : 'assistant',
      message.text,
      '当前会话历史；不加载其他会话或长期记忆',
    )
  add(user.id, 'message', 'user', user.text, '本次用户消息')
  const encoded = canonicalJson(input)
  if (
    Buffer.byteLength(encoded) >
    workspace.config.runtime.contextBudget.maxUtf8Bytes
  )
    throw new CharactersError(
      'CONTEXT_LIMIT',
      '完整上下文超出预算，未静默截断。',
      '缩短素材或开启新会话。',
    )
  const inputDigest = sha256(encoded)
  const request: ExecutionRequest = {
    protocolVersion: 1,
    runId,
    sessionId: session.id,
    input: { digest: inputDigest, messages: input },
    isolation: 'strict',
    tools: [],
    allowedSourceIds: work?.sources.map((source) => source.id) ?? [],
    limits: {
      timeoutMs: 180000,
      maxOutputUtf8Bytes:
        workspace.config.runtime.contextBudget.maxOutputUtf8Bytes,
      maxToolCalls: 0,
    },
    ...(work
      ? { work: { id: work.record.id, revision: work.record.revision } }
      : {}),
  }
  const context = validate(contextSnapshotSchema, {
    schemaVersion: 1,
    id: newId('snap'),
    sessionId: session.id,
    ...(work ? { workRevision: work.record.revision } : {}),
    characterDigest: loaded.digest,
    policyDigest: sha256(canonicalJson(workspace.config.policy)),
    createdAt: utcNow(),
    entries,
    excluded: [],
    inputDigest,
    inputRef: `${sessionRef(session.id)}/runs/${runId}/input.json`,
  })
  return { request, context }
}
export async function showSessionRun(
  workspace: WorkspaceHandle,
  id: string,
  runId: string,
) {
  validate(idSchema('run'), runId)
  return withStore(workspace, async () => {
    await readSession(workspace, id)
    const root = `${sessionRef(id)}/runs/${runId}`
    const run = await readJson(workspace.root, `${root}/run.json`, runSchema)
    if (run.sessionId !== id || run.id !== runId)
      throw new CharactersError(
        'STORE_CORRUPT',
        '执行记录归属错误。',
        '检查执行目录。',
      )
    const context = await readJson(
      workspace.root,
      `${root}/context.json`,
      contextSnapshotSchema,
    )
    const input = await readJson(
      workspace.root,
      `${root}/input.json`,
      executionRequestSchema,
    )
    if (
      context.id !== run.contextSnapshotId ||
      context.sessionId !== id ||
      input.sessionId !== id ||
      input.runId !== runId ||
      context.inputDigest !== input.input.digest ||
      input.input.digest !== sha256(canonicalJson(input.input.messages))
    )
      throw new CharactersError(
        'STORE_CORRUPT',
        '上下文与实际输入摘要不一致。',
        '检查输入快照。',
      )
    return {
      run,
      context,
      evidence: await readJson(
        workspace.root,
        `${root}/evidence.json`,
        z.unknown(),
      ),
      ...((await exists(
        await containedPath(workspace.root, `${root}/result.json`),
      ))
        ? { result: await readResult(workspace, root, run) }
        : {}),
    }
  })
}
export async function sendSession(
  workspace: WorkspaceHandle,
  id: string,
  text: string,
  adapter: CharacterAdapter,
  options: {
    requestId?: string
    intent?: 'discuss' | 'outline' | 'draft'
    signal?: AbortSignal
  } = {},
): Promise<SessionResult> {
  if (!text.trim())
    throw new CharactersError(
      'INVALID_INPUT',
      '消息不能为空。',
      '提供选题或修改要求。',
    )
  const intent = validate(
    z.enum(['discuss', 'outline', 'draft']),
    options.intent ?? 'discuss',
  )
  const requestId = validate(
    z.uuid(),
    options.requestId ?? randomUUID(),
  ).toLowerCase()
  const fingerprint = sha256(
    canonicalJson({ operation: 'session.send', sessionId: id, text, intent }),
  )
  const requestRef = `${sessionRef(id)}/requests/${requestId}.json`
  const receiptRef = `.runtime/receipts/${requestId}.json`
  const existing = await withStore(workspace, async () => {
    let receiptRunId: string | undefined
    if (await exists(await containedPath(workspace.root, receiptRef))) {
      const receipt = await readJson(workspace.root, receiptRef, receiptSchema)
      if (
        receipt.requestId !== requestId ||
        sha256(canonicalJson(receipt.result)) !== receipt.resultDigest
      )
        throw new CharactersError(
          'STORE_CORRUPT',
          '请求回执损坏。',
          '检查请求回执。',
        )
      if (receipt.fingerprint !== fingerprint)
        throw new CharactersError(
          'CONFLICT',
          'requestId 已用于其他操作或会话。',
          '为本次消息使用新的 requestId。',
        )
      const descriptor = validate(
        z.strictObject({
          operation: z.literal('session.send'),
          sessionId: idSchema('ses'),
          runId: idSchema('run'),
        }),
        receipt.result,
        'STORE_CORRUPT',
      )
      if (descriptor.sessionId !== id)
        throw new CharactersError(
          'STORE_CORRUPT',
          '请求回执指向其他会话。',
          '检查请求映射。',
        )
      receiptRunId = descriptor.runId
      if (!(await exists(await containedPath(workspace.root, requestRef))))
        throw new CharactersError(
          'STORE_CORRUPT',
          '回执缺少对应的会话请求。',
          '检查请求映射。',
        )
    } else if (await exists(await containedPath(workspace.root, requestRef)))
      throw new CharactersError(
        'STORE_CORRUPT',
        '会话请求缺少工作区回执。',
        '检查事务是否完整。',
      )
    if (!(await exists(await containedPath(workspace.root, requestRef))))
      return undefined
    const request = await readJson(
      workspace.root,
      requestRef,
      sendRequestSchema,
    )
    if (request.runId !== receiptRunId)
      throw new CharactersError(
        'STORE_CORRUPT',
        '请求映射与回执执行 ID 不一致。',
        '检查请求映射。',
      )
    if (request.fingerprint !== fingerprint || request.requestId !== requestId)
      throw new CharactersError(
        'CONFLICT',
        'requestId 已用于另一条消息。',
        '重试原输入或使用新 requestId。',
      )
    const root = `${sessionRef(id)}/runs/${request.runId}`
    const run = await readJson(workspace.root, `${root}/run.json`, runSchema)
    if (run.status === 'completed') {
      const result = await readResult(workspace, root, run)
      if (result.requestId !== requestId)
        throw new CharactersError(
          'STORE_CORRUPT',
          '结果不属于当前请求。',
          '检查执行结果。',
        )
      return result
    }
    throw new CharactersError(
      run.errorCode ?? 'BUSY',
      '请求已有执行记录，不会再次调用模型。',
      '查看 session run；新的尝试使用新 requestId。',
    )
  })
  if (existing) return existing
  const before = (await showSession(workspace, id)).session
  if (before.status !== 'open' || before.activeRunId)
    throw new CharactersError(
      'BUSY',
      '会话已关闭或有未结束执行。',
      '恢复会话或等待原执行结束；进程中断遗留会话可另建会话继续作品。',
    )
  if (intent !== 'discuss' && !before.workId)
    throw new CharactersError(
      'INVALID_INPUT',
      '生成建议稿需要绑定作品。',
      '使用 session open --work 创建合作会话。',
    )
  const work = before.workId
    ? await showWork(workspace, before.workId)
    : undefined
  const capabilities = validate(
    adapterCapabilitiesSchema,
    await adapter.probe(),
  )
  if (
    capabilities.hostMemory !== 'disabled' ||
    capabilities.freshExecution !== 'supported' ||
    capabilities.toolBoundary !== 'enforced' ||
    capabilities.defaultConfigDiscovery !== 'controlled' ||
    capabilities.evidence.result !== 'pass' ||
    Date.parse(capabilities.evidence.validUntil) < Date.now()
  )
    throw new CharactersError(
      'ISOLATION_UNSUPPORTED',
      '适配器未满足严格隔离要求。',
      '运行 adapter doctor，不能静默降级。',
    )
  const prepared = await withStore(workspace, async (transaction) => {
    const current = await readSession(workspace, id)
    if (current.revision !== before.revision || current.activeRunId)
      throw new CharactersError(
        'CONFLICT',
        '会话已被其他执行修改。',
        '刷新会话后重试。',
      )
    if (work) {
      const latest = await readJson(
        workspace.root,
        `works/${work.record.id}/work.json`,
        z.object({ revision: z.number(), contentDigest: z.string() }),
      )
      if (
        latest.revision !== work.record.revision ||
        latest.contentDigest !== work.record.contentDigest
      )
        throw new CharactersError(
          'CONFLICT',
          '构建上下文期间作品已改变。',
          '重新读取作品。',
        )
    }
    const history = await messages(workspace, current)
    if (history.length + 2 > 500)
      throw new CharactersError(
        'CONTEXT_LIMIT',
        '会话没有足够的消息额度完成下一轮。',
        '开启新会话并关联同一作品。',
      )
    const user = validate(messageSchema, {
      id: newId('msg'),
      sequence: current.lastMessageSequence + 1,
      sessionId: id,
      role: 'user',
      text,
      createdAt: utcNow(),
    })
    const runId = newId('run')
    const context = await buildContext(
      workspace,
      current,
      history,
      user,
      runId,
      work,
      intent,
    )
    const run = validate(runSchema, {
      schemaVersion: 1,
      id: runId,
      sessionId: id,
      status: 'running',
      adapterId: capabilities.adapterId,
      adapterVersion: capabilities.adapterVersion,
      contextSnapshotId: context.context.id,
      capabilityEvidenceId: capabilities.evidence.id,
      isolationRequested: 'strict',
      isolationEffective: 'strict',
      startedAt: utcNow(),
      owner: { pid: process.pid, host: hostname() },
    })
    const root = `${sessionRef(id)}/runs/${runId}`
    await transaction.put(`${root}/context.json`, jsonBytes(context.context))
    await transaction.put(`${root}/input.json`, jsonBytes(context.request))
    await transaction.put(
      `${root}/evidence.json`,
      jsonBytes(adapter.diagnostics?.() ?? capabilities),
    )
    await transaction.put(`${root}/run.json`, jsonBytes(run))
    await transaction.put(
      `${sessionRef(id)}/messages/${user.id}.json`,
      jsonBytes(user),
    )
    await transaction.put(
      requestRef,
      jsonBytes({ schemaVersion: 1, requestId, fingerprint, runId }),
    )
    const receiptResult = { operation: 'session.send', sessionId: id, runId }
    await transaction.put(
      receiptRef,
      jsonBytes({
        schemaVersion: 1,
        requestId,
        fingerprint,
        result: receiptResult,
        resultDigest: sha256(canonicalJson(receiptResult)),
      }),
    )
    const session = validate(sessionSchema, {
      ...current,
      revision: current.revision + 1,
      lastMessageSequence: user.sequence,
      activeRunId: runId,
      updatedAt: utcNow(),
    })
    await transaction.put(
      `${sessionRef(id)}/session.json`,
      jsonBytes(session),
      sha256(jsonBytes(current)),
    )
    return { run, session, ...context }
  })
  const events: AdapterEvent[] = []
  const root = `${sessionRef(id)}/runs/${prepared.run.id}`
  let terminal = false
  try {
    for await (const raw of adapter.run(
      prepared.request,
      {
        readSource: async () => ({
          ok: false,
          code: 'PERMISSION_DENIED',
          message: 'No runtime tools granted.',
        }),
      },
      options.signal ?? new AbortController().signal,
    )) {
      const event = validate(adapterEventSchema, raw)
      if (
        terminal ||
        event.runId !== prepared.run.id ||
        event.sequence !== events.length + 1 ||
        (events.length === 0 && event.type !== 'started') ||
        (events.length > 0 && event.type === 'started') ||
        ['tool-request', 'memory-candidate'].includes(event.type)
      )
        throw new CharactersError(
          'ADAPTER_PROTOCOL',
          '执行事件顺序或权限不合法。',
          '输出未采纳。',
        )
      if (
        event.type === 'proposal' &&
        (intent === 'discuss' ||
          event.proposal.target !== intent ||
          event.proposal.baseRevision !== work?.record.revision ||
          event.proposal.sourceIds.some(
            (sourceId) => !prepared.request.allowedSourceIds.includes(sourceId),
          ))
      )
        throw new CharactersError(
          'ADAPTER_PROTOCOL',
          '建议稿意图、版本或来源不一致。',
          '输出未采纳。',
        )
      events.push(event)
      if (
        events.length > 16 ||
        Buffer.byteLength(canonicalJson(events)) > 128000
      )
        throw new CharactersError(
          'CONTEXT_LIMIT',
          '执行事件超过限制。',
          '缩短任务。',
        )
      if (event.type === 'completed' || event.type === 'failed') terminal = true
    }
    const last = events.at(-1)
    const proposals = events.filter((event) => event.type === 'proposal')
    if (
      last?.type !== 'completed' ||
      proposals.length !== (intent === 'discuss' ? 0 : 1)
    )
      throw new CharactersError(
        last?.type === 'failed' ? last.code : 'ADAPTER_PROTOCOL',
        '未收到完整且符合意图的回复。',
        '查看执行状态，用新 requestId 重试。',
      )
    if (
      capabilities.adapterId === 'codex-cli' &&
      (!last.isolationAudit?.globalMemoryMetadataUnchanged ||
        !last.isolationAudit.executionDirectoryRemoved ||
        last.isolationAudit.toolCallsObserved !== 0)
    )
      throw new CharactersError(
        'ISOLATION_UNSUPPORTED',
        'Codex 结果缺少通过的执行隔离检查。',
        '本次结果未采纳。',
      )
    return await withStore(workspace, async (transaction) => {
      const session = await readSession(workspace, id)
      if (session.activeRunId !== prepared.run.id)
        throw new CharactersError(
          'CONFLICT',
          '执行不再拥有该会话。',
          '检查执行状态。',
        )
      const message = validate(messageSchema, {
        id: newId('msg'),
        sequence: session.lastMessageSequence + 1,
        sessionId: id,
        role: 'character',
        characterId: session.character.id,
        runId: prepared.run.id,
        text: last.text,
        createdAt: utcNow(),
      })
      const proposalEvent = proposals[0]
      const proposal =
        proposalEvent?.type === 'proposal' && work
          ? validate(proposalSchema, {
              schemaVersion: 1,
              id: newId('prop'),
              workId: work.record.id,
              origin: { type: 'run', sessionId: id, runId: prepared.run.id },
              ...proposalEvent.proposal,
              createdAt: utcNow(),
            })
          : undefined
      const result = validate(resultSchema, {
        sessionId: id,
        runId: prepared.run.id,
        requestId,
        reply: last.text,
        ...(proposal ? { proposalId: proposal.id } : {}),
        ...(last.isolationAudit ? { audit: last.isolationAudit } : {}),
      })
      if (proposal)
        await transaction.put(
          `works/${proposal.workId}/proposals/${proposal.id}.json`,
          jsonBytes(proposal),
        )
      await transaction.put(
        `${sessionRef(id)}/messages/${message.id}.json`,
        jsonBytes(message),
      )
      await transaction.put(`${root}/events.json`, jsonBytes(events))
      await transaction.put(`${root}/result.json`, jsonBytes(result))
      await finishRun(
        transaction,
        session,
        prepared.run,
        'completed',
        message.sequence,
        undefined,
        sha256(jsonBytes(result)),
      )
      return result
    })
  } catch (error) {
    const code =
      error instanceof CharactersError ? error.code : 'ADAPTER_FAILED'
    const recovered = await withStore(workspace, async (transaction) => {
      const run = await readJson(workspace.root, `${root}/run.json`, runSchema)
      if (run.status === 'completed') return readResult(workspace, root, run)
      const session = await readSession(workspace, id)
      if (session.activeRunId !== run.id)
        throw new CharactersError(
          'CONFLICT',
          '执行不再拥有会话。',
          '检查执行状态。',
        )
      await transaction.put(`${root}/events.json`, jsonBytes(events))
      await finishRun(
        transaction,
        session,
        run,
        code === 'CANCELLED' ? 'interrupted' : 'failed',
        session.lastMessageSequence,
        code,
      )
      return undefined
    })
    if (recovered) return recovered
    throw error instanceof CharactersError
      ? error
      : new CharactersError(
          'ADAPTER_FAILED',
          '执行失败，私人错误详情未输出。',
          `查看 session run，runId=${prepared.run.id}；新尝试使用新 requestId。`,
        )
  }
}
async function finishRun(
  transaction: FileTransaction,
  session: SessionRecord,
  run: RunRecord,
  status: 'completed' | 'failed' | 'interrupted',
  lastMessageSequence: number,
  errorCode?: RunRecord['errorCode'],
  resultDigest?: string,
) {
  const { activeRunId: _active, ...rest } = session
  await transaction.put(
    `${sessionRef(session.id)}/session.json`,
    jsonBytes({
      ...rest,
      revision: session.revision + 1,
      lastMessageSequence,
      updatedAt: utcNow(),
    }),
    sha256(jsonBytes(session)),
  )
  await transaction.put(
    `${sessionRef(session.id)}/runs/${run.id}/run.json`,
    jsonBytes({
      ...run,
      status,
      endedAt: utcNow(),
      ...(errorCode ? { errorCode } : {}),
      ...(resultDigest ? { resultDigest } : {}),
    }),
    sha256(jsonBytes(run)),
  )
}
