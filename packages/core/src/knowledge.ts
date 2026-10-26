import { z } from 'zod'
import { CharactersError } from './errors.js'
import { containedPath, decodeUtf8, exists, readBytes } from './files.js'
import { loadCharacter } from './characters.js'
import { canonicalJson, jsonBytes, readJson } from './storage.js'
import type { FileTransaction } from './storage.js'
import { recordNames } from './migration.js'
import { newId, sha256, utcNow } from './ids.js'
import {
  bindingSchema,
  characterIdSchema,
  contextDeliverySchema,
  idSchema,
  memoryCandidateSchema,
  memorySearchResultSchema,
  memoryV2Schema,
  sharedContextSchema,
  usageKeySchema,
} from './schemas.js'
import type { BindingRecord, ServiceConfig } from './schemas.js'
import type { WorkspaceHandle } from './workspace.js'
import { validate } from './validation.js'

type Memory = z.infer<typeof memoryV2Schema>
type Delivery = z.infer<typeof contextDeliverySchema>
type Entry = Delivery['entries'][number]
const corrupt = () =>
  new CharactersError(
    'STORE_CORRUPT',
    '知识记录的归属、来源或摘要不一致。',
    '保留现场并检查工作区备份。',
  )
const conflict = () =>
  new CharactersError(
    'CONFLICT',
    '记忆版本或状态已改变。',
    '重新查看当前记录和被替代项的版本。',
  )
const missingMemory = () =>
  new CharactersError(
    'NOT_FOUND',
    '当前角色下没有该记忆。',
    '查看该角色的记忆列表。',
  )
const forbidden = () =>
  new CharactersError(
    'PERMISSION_DENIED',
    '记忆或背景超出绑定范围。',
    '使用所属角色和已授权范围。',
  )
const memoryRef = (character: string, id: string) =>
  `states/${validate(characterIdSchema, character)}/memories/${validate(idSchema('mem'), id)}.json`
const contextRef = (key: string) =>
  `contexts/${validate(usageKeySchema, key)}/context.json`
const deliveryRef = (binding: string, snapshot: string) =>
  `bindings/${validate(idSchema('bind'), binding)}/deliveries/${validate(idSchema('snap'), snapshot)}/delivery.json`
const fitsWire = (value: unknown) =>
  Buffer.byteLength(
    JSON.stringify({ protocolVersion: 1, ok: true, data: value, error: null }),
  ) <= 262144

/** Domain operations run inside the caller's authorized withStore transaction. */
export class KnowledgeStore {
  constructor(readonly workspace: WorkspaceHandle) {}

  async memory(character: string, id: string): Promise<Memory> {
    const ref = memoryRef(character, id)
    if (!(await exists(await containedPath(this.workspace.root, ref))))
      throw missingMemory()
    const record = await readJson(
      this.workspace.root,
      ref,
      memoryV2Schema,
      1024 * 1024,
    )
    if (
      record.workspaceId !== this.workspace.config.id ||
      record.characterId !== character ||
      record.id !== id
    )
      throw corrupt()
    return record
  }
  async memories(character: string): Promise<Memory[]> {
    validate(characterIdSchema, character)
    const names = await recordNames(
      this.workspace,
      `states/${character}/memories`,
    )
    if (names.length > 4096)
      throw new CharactersError(
        'CONTEXT_LIMIT',
        '单角色记忆超过当前文件扫描上限。',
        '归档记录后重试；不会使用旧快照代替查询。',
      )
    const records = []
    for (const name of names) {
      if (
        !name.endsWith('.json') ||
        !idSchema('mem').safeParse(name.slice(0, -5)).success
      )
        throw corrupt()
      records.push(await this.memory(character, name.slice(0, -5)))
    }
    return records
  }
  visible(record: Memory, binding: BindingRecord): boolean {
    return (
      record.status === 'confirmed' &&
      record.workspaceId === binding.workspaceId &&
      record.characterId === binding.character.id &&
      (!record.scope.projectKey ||
        record.scope.projectKey === binding.scope.projectKey) &&
      record.scope.contextKeys.every((key) =>
        binding.scope.contextKeys.includes(key),
      )
    )
  }
  sameScope(a: Memory, b: Memory): boolean {
    return (
      a.scope.projectKey === b.scope.projectKey &&
      canonicalJson([...a.scope.contextKeys].sort()) ===
        canonicalJson([...b.scope.contextKeys].sort())
    )
  }
  async verifySources(
    record: Memory,
  ): Promise<Array<{ ref: string; text: string }>> {
    const excerpts = []
    for (const source of record.sources) {
      if (source.type !== 'host-excerpt') continue
      if (
        source.excerptRef !==
        `bindings/${source.bindingId}/proposals/${record.id}.txt`
      )
        throw corrupt()
      const binding = await readJson(
        this.workspace.root,
        `bindings/${source.bindingId}/binding.json`,
        bindingSchema,
      )
      if (
        binding.id !== source.bindingId ||
        binding.workspaceId !== record.workspaceId ||
        binding.character.id !== record.characterId ||
        binding.connectionId !== source.connectionId ||
        binding.hostSessionRef !== source.hostSessionRef ||
        binding.scope.projectKey !== record.scope.projectKey ||
        canonicalJson([...binding.scope.contextKeys].sort()) !==
          canonicalJson([...record.scope.contextKeys].sort())
      )
        throw corrupt()
      const bytes = await readBytes(
        this.workspace.root,
        source.excerptRef,
        8192,
      )
      if (sha256(bytes) !== source.digest) throw corrupt()
      excerpts.push({ ref: source.excerptRef, text: decodeUtf8(bytes) })
    }
    return excerpts
  }
  async propose(
    tx: FileTransaction,
    binding: BindingRecord,
    value: unknown,
  ): Promise<Memory> {
    const candidate = validate(memoryCandidateSchema, value)
    if (candidate.scope.projectKey !== binding.scope.projectKey)
      throw forbidden()
    const id = newId('mem')
    const excerptRef = `bindings/${binding.id}/proposals/${id}.txt`
    const record = memoryV2Schema.parse({
      schemaVersion: 2,
      workspaceId: binding.workspaceId,
      id,
      revision: 1,
      characterId: binding.character.id,
      kind: candidate.kind,
      status: 'candidate',
      content: candidate.content,
      tags: candidate.tags,
      visibility: 'private',
      scope: {
        ...candidate.scope,
        purpose: binding.scope.purpose,
        contextKeys: binding.scope.contextKeys,
      },
      recordedAt: utcNow(),
      sources: [
        {
          type: 'host-excerpt',
          connectionId: binding.connectionId,
          bindingId: binding.id,
          hostSessionRef: binding.hostSessionRef,
          hostMessageRef: candidate.hostMessageRef,
          excerptRef,
          digest: sha256(candidate.excerpt),
          capturedAt: utcNow(),
          suppliedBy: 'host-plugin',
        },
      ],
      replaces: candidate.replaces,
      decisions: [],
    })
    if (record.replaces) {
      const previous = await this.memory(record.characterId, record.replaces)
      if (!this.visible(previous, binding)) throw missingMemory()
      if (!this.sameScope(record, previous)) throw conflict()
    }
    await tx.put(excerptRef, Buffer.from(candidate.excerpt, 'utf8'))
    await tx.put(memoryRef(record.characterId, id), jsonBytes(record))
    return record
  }
  async decide(
    tx: FileTransaction,
    character: string,
    id: string,
    action: 'confirm' | 'reject' | 'retract',
    expected: number,
    reason?: string,
    replaceExpectedRevision?: number,
    factBasis?: string,
  ): Promise<Memory> {
    const record = await this.memory(character, id)
    if (
      record.revision !== expected ||
      (action === 'retract'
        ? record.status !== 'confirmed'
        : record.status !== 'candidate')
    )
      throw conflict()
    if (action === 'confirm') await this.verifySources(record)
    if (action === 'confirm' && record.kind === 'fact' && !factBasis?.trim())
      throw new CharactersError(
        'INVALID_INPUT',
        '确认 fact 需要人工核查依据。',
        '提供 factBasis，说明核查了哪些来源；服务不会替你验证聊天原文。',
      )
    const at = utcNow()
    if (action === 'confirm' && record.replaces) {
      const previous = await this.memory(character, record.replaces)
      if (
        previous.id === record.id ||
        previous.status !== 'confirmed' ||
        previous.revision !== replaceExpectedRevision ||
        !this.sameScope(record, previous)
      )
        throw conflict()
      const superseded = memoryV2Schema.parse({
        ...previous,
        status: 'superseded',
        revision: previous.revision + 1,
        decisions: [
          ...previous.decisions,
          {
            action: 'supersede',
            actor: 'user',
            at,
            reason: `Replaced by ${record.id}`,
          },
        ],
      })
      await this.saveMemory(tx, superseded)
    } else if (replaceExpectedRevision !== undefined)
      throw new CharactersError(
        'INVALID_INPUT',
        '本操作没有待确认的替代项。',
        '只在确认替代候选时提供替代项版本。',
      )
    if (factBasis && (action !== 'confirm' || record.kind !== 'fact'))
      throw new CharactersError(
        'INVALID_INPUT',
        '本操作不接受事实核查依据。',
        '仅确认 fact 时提供依据。',
      )
    const updated = memoryV2Schema.parse({
      ...record,
      revision: record.revision + 1,
      status: {
        confirm: 'confirmed',
        reject: 'rejected',
        retract: 'retracted',
      }[action],
      decisions: [...record.decisions, { action, actor: 'user', at, reason }],
      ...(action === 'confirm' && record.kind === 'fact'
        ? { factReview: { actor: 'user', at, basis: factBasis } }
        : {}),
    })
    await this.saveMemory(tx, updated)
    return updated
  }
  async saveMemory(tx: FileTransaction, record: Memory) {
    const ref = memoryRef(record.characterId, record.id)
    await tx.put(
      ref,
      jsonBytes(record),
      sha256(await readBytes(this.workspace.root, ref, 1024 * 1024)),
    )
  }
  async importContext(
    tx: FileTransaction,
    key: string,
    content: string,
    expected: number,
  ) {
    const ref = contextRef(key)
    const present = await exists(await containedPath(this.workspace.root, ref))
    const previous = present ? await this.sharedContext(key) : undefined
    if ((previous?.revision ?? 0) !== expected) throw conflict()
    const digest = sha256(content)
    const record = sharedContextSchema.parse({
      schemaVersion: 1,
      workspaceId: this.workspace.config.id,
      key,
      revision: expected + 1,
      status: 'active',
      objectRef: `objects/${digest}.txt`,
      digest,
      approvedBy: 'user',
      approvedAt: utcNow(),
    })
    await tx.put(record.objectRef, Buffer.from(content, 'utf8'))
    await tx.put(
      ref,
      jsonBytes(record),
      present ? sha256(await readBytes(this.workspace.root, ref, 65536)) : null,
    )
    return record
  }
  async sharedContext(key: string) {
    const record = await readJson(
      this.workspace.root,
      contextRef(key),
      sharedContextSchema,
      65536,
    )
    if (
      record.key !== key ||
      record.workspaceId !== this.workspace.config.id ||
      record.objectRef !== `objects/${record.digest}.txt`
    )
      throw corrupt()
    return record
  }
  async revokeContext(tx: FileTransaction, key: string, expected: number) {
    const record = await this.sharedContext(key)
    if (record.revision !== expected || record.status !== 'active')
      throw conflict()
    const updated = sharedContextSchema.parse({
      ...record,
      revision: record.revision + 1,
      status: 'revoked',
      approvedAt: utcNow(),
    })
    const ref = contextRef(key)
    await tx.put(
      ref,
      jsonBytes(updated),
      sha256(await readBytes(this.workspace.root, ref, 65536)),
    )
    return updated
  }
  async deliver(
    tx: FileTransaction,
    binding: BindingRecord,
    config: ServiceConfig,
    mode: 'conversation' | 'coauthor' = 'conversation',
    search?: { query: string; limit: number },
  ) {
    const delivery: Delivery = {
      schemaVersion: 1,
      id: newId('snap'),
      bindingId: binding.id,
      characterDigest: binding.character.digest,
      policyDigest: sha256(
        canonicalJson({
          config,
          scope: binding.scope,
          isolation: binding.isolationEffective,
        }),
      ),
      createdAt: utcNow(),
      entries: [],
      excluded: [],
      contentDigest: sha256(''),
      totalUtf8Bytes: 0,
    }
    const budget = Math.min(config.contextBudgetBytes, 48000)
    const matches: z.infer<typeof memorySearchResultSchema>['matches'] = []
    const exclude = (ref: string, reason: string) => {
      if (delivery.excluded.length < 128)
        delivery.excluded.push({ ref, reason })
    }
    const include = (
      entry: Entry,
      required = false,
      match?: (typeof matches)[number],
    ) => {
      const next = {
        ...delivery,
        entries: [...delivery.entries, entry],
        totalUtf8Bytes: delivery.totalUtf8Bytes + entry.utf8Bytes,
      }
      const wire = search
        ? { delivery: next, matches: [...matches, ...(match ? [match] : [])] }
        : next
      if (next.totalUtf8Bytes > budget || !fitsWire(wire)) {
        if (required)
          throw new CharactersError(
            'CONTEXT_LIMIT',
            '必需角色设定超过交付预算。',
            '提高允许的预算或缩减角色设定；不会截断设定。',
          )
        exclude(entry.ref, 'byte-budget')
        return false
      }
      delivery.entries.push(entry)
      delivery.totalUtf8Bytes = next.totalUtf8Bytes
      if (match) matches.push(match)
      return true
    }
    if (!search) {
      const root = `packages/${binding.character.id}/${binding.character.digest}`
      const loaded = await loadCharacter(
        await containedPath(this.workspace.root, root),
      )
      if (
        loaded.digest !== binding.character.digest ||
        loaded.manifest.id !== binding.character.id ||
        loaded.manifest.version !== binding.character.version
      )
        throw corrupt()
      const files = loaded.manifest.files
      for (const [kind, ref] of [
        ['persona', files.persona],
        ['voice', files.voice],
        ['relationship', files.relationships],
        ['mode', loaded.manifest.modes[mode]],
      ] as const) {
        const bytes = loaded.files.get(ref)
        if (!bytes) throw corrupt()
        include(
          {
            ref: `${root}/${ref}`,
            kind,
            digest: sha256(bytes),
            utf8Bytes: bytes.length,
            reason: 'required-role-definition',
            text: decodeUtf8(bytes),
          },
          true,
        )
      }
      for (const key of [...binding.scope.contextKeys].sort()) {
        const ref = contextRef(key)
        if (!(await exists(await containedPath(this.workspace.root, ref)))) {
          exclude(ref, 'not-imported')
          continue
        }
        const context = await this.sharedContext(key)
        if (context.status !== 'active') {
          exclude(ref, 'revoked')
          continue
        }
        const bytes = await readBytes(
          this.workspace.root,
          context.objectRef,
          16384,
        )
        if (sha256(bytes) !== context.digest) throw corrupt()
        include({
          ref,
          kind: 'context',
          revision: context.revision,
          digest: context.digest,
          utf8Bytes: bytes.length,
          reason: 'explicitly-authorized-background-data',
          text: decodeUtf8(bytes),
        })
      }
    }
    const tokens = search
      ? [
          ...new Set(
            search.query
              .toLocaleLowerCase('en-US')
              .split(/\s+/u)
              .filter(Boolean),
          ),
        ]
      : []
    const eligible = (await this.memories(binding.character.id))
      .filter((record) => this.visible(record, binding))
      .map((record) => {
        const content = record.content.toLocaleLowerCase('en-US'),
          tags = record.tags.map((tag) => tag.toLocaleLowerCase('en-US'))
        const score = tokens.reduce(
          (sum, token) =>
            sum +
            (content.includes(token) ? 1 : 0) +
            (tags.some((tag) => tag.includes(token)) ? 2 : 0),
          0,
        )
        return { record, score }
      })
      .filter((item) => !search || item.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score || a.record.id.localeCompare(b.record.id, 'en'),
      )
    const limit = search?.limit ?? 32
    let included = 0
    for (const { record, score } of eligible) {
      const ref = memoryRef(record.characterId, record.id)
      if (included >= limit) {
        exclude(ref, 'entry-limit')
        continue
      }
      await this.verifySources(record)
      const reason = search
        ? `keyword/tag score ${score}; confirmed-memory-data`
        : 'confirmed-memory-data; never host instructions'
      if (
        include(
          {
            ref,
            kind: 'memory',
            revision: record.revision,
            digest: sha256(record.content),
            utf8Bytes: Buffer.byteLength(record.content),
            reason,
            text: record.content,
          },
          false,
          search
            ? {
                id: record.id,
                revision: record.revision,
                kind: record.kind,
                content: record.content,
                tags: record.tags,
                score,
                reason,
              }
            : undefined,
        )
      )
        included++
    }
    delivery.contentDigest = sha256(canonicalJson(delivery.entries))
    const validated = contextDeliverySchema.parse(delivery)
    const result = search
      ? memorySearchResultSchema.parse({ delivery: validated, matches })
      : validated
    if (!fitsWire(result))
      throw new CharactersError(
        'CONTEXT_LIMIT',
        '交付清单超过协议预算。',
        '缩减范围。',
      )
    await tx.put(deliveryRef(binding.id, delivery.id), jsonBytes(validated))
    return result
  }
  async explain(bindingId: string, snapshotId: string, content = false) {
    const binding = await readJson(
      this.workspace.root,
      `bindings/${validate(idSchema('bind'), bindingId)}/binding.json`,
      bindingSchema,
    )
    const record = await readJson(
      this.workspace.root,
      deliveryRef(bindingId, snapshotId),
      contextDeliverySchema,
    )
    if (
      record.id !== snapshotId ||
      record.bindingId !== bindingId ||
      binding.id !== bindingId ||
      binding.workspaceId !== this.workspace.config.id ||
      binding.character.digest !== record.characterDigest ||
      sha256(canonicalJson(record.entries)) !== record.contentDigest ||
      record.entries.some(
        (entry) =>
          sha256(entry.text) !== entry.digest ||
          Buffer.byteLength(entry.text) !== entry.utf8Bytes,
      ) ||
      record.entries.reduce((sum, entry) => sum + entry.utf8Bytes, 0) !==
        record.totalUtf8Bytes
    )
      throw corrupt()
    if (content) return record
    return {
      ...record,
      entries: record.entries.map(({ text: _text, ...entry }) => entry),
    }
  }
}
