import { z } from 'zod'
import { timingSafeEqual } from 'node:crypto'
import {
  CharactersError,
  bindingSchema,
  connectionGrantSchema,
  hostEvidenceSchema,
  serviceConfigSchema,
  accessEventSchema,
  charactersLockSchema,
  loadCharacter,
  containedPath,
  exists,
  readBytes,
  readJson,
  recordNames,
  withStore,
  jsonBytes,
  canonicalJson,
  sha256,
  newId,
  utcNow,
  idSchema,
  usageScopeSchema,
  characterIdSchema,
  usageKeySchema,
  memoryV2Schema,
  KnowledgeStore,
} from '@characters/core'
import type {
  WorkspaceHandle,
  FileTransaction,
  ConnectionGrant,
  BindingRecord,
  HostEvidence,
  StorageOptions,
} from '@characters/core'
import {
  agentRequestSchema,
  strictActivationDecision,
} from '@characters/protocol'
import type { HostSessionAssessment } from '@characters/protocol'

export type Principal =
  | { kind: 'admin' }
  | { kind: 'agent'; id: string; token: string }
export interface VerifiedHost {
  assessment: HostSessionAssessment
  hostVersion: string
  pluginVersion: string
  verifierVersion: string
  configurationDigest: string
  hostBinaryDigest?: string
}
/** Trusted server-side integration, never a request field or a JSON import. */
export type HostVerifier = (
  grant: Readonly<ConnectionGrant>,
  signal: AbortSignal,
) => Promise<VerifiedHost | undefined>
export const grantInputSchema = connectionGrantSchema
  .pick({
    hostId: true,
    pluginId: true,
    hostSessionRef: true,
    characterIds: true,
    allowedProjectKeys: true,
    allowedContextKeys: true,
    actions: true,
    isolation: true,
  })
  .extend({ ttlSeconds: z.number().int().min(1).max(3600) })
export const adminRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    protocolVersion: z.literal(1),
    requestId: z.uuid(),
    operation: z.literal('memory.list'),
    params: z.strictObject({
      characterId: characterIdSchema,
      status: memoryV2Schema.shape.status.optional(),
      limit: z.number().int().min(1).max(100).optional(),
      after: idSchema('mem').optional(),
    }),
  }),
  z.strictObject({
    protocolVersion: z.literal(1),
    requestId: z.uuid(),
    operation: z.literal('memory.show'),
    params: z.strictObject({
      characterId: characterIdSchema,
      id: idSchema('mem'),
    }),
  }),
  ...(['memory.confirm', 'memory.reject', 'memory.retract'] as const).map(
    (operation) =>
      z.strictObject({
        protocolVersion: z.literal(1),
        requestId: z.uuid(),
        operation: z.literal(operation),
        params: z.strictObject({
          characterId: characterIdSchema,
          id: idSchema('mem'),
          expectedRevision: z.number().int().positive(),
          reason: z.string().trim().min(1).max(2048).optional(),
          replaceExpectedRevision: z.number().int().positive().optional(),
          factBasis: z.string().trim().min(1).max(2048).optional(),
        }),
      }),
  ),
  z.strictObject({
    protocolVersion: z.literal(1),
    requestId: z.uuid(),
    operation: z.literal('context.import'),
    params: z.strictObject({
      key: usageKeySchema,
      text: z
        .string()
        .min(1)
        .refine(
          (value) =>
            value.trim().length > 0 && Buffer.byteLength(value) <= 16384,
        ),
      expectedRevision: z.number().int().nonnegative(),
    }),
  }),
  z.strictObject({
    protocolVersion: z.literal(1),
    requestId: z.uuid(),
    operation: z.literal('context.revoke'),
    params: z.strictObject({
      key: usageKeySchema,
      expectedRevision: z.number().int().positive(),
    }),
  }),
  z.strictObject({
    protocolVersion: z.literal(1),
    requestId: z.uuid(),
    operation: z.literal('context.explain'),
    params: z.strictObject({
      bindingId: idSchema('bind'),
      snapshotId: idSchema('snap'),
      content: z.boolean().optional(),
    }),
  }),
  z.strictObject({
    protocolVersion: z.literal(1),
    requestId: z.uuid(),
    operation: z.literal('connection.grant'),
    params: grantInputSchema,
  }),
  ...(
    [
      'connection.list',
      'binding.list',
      'service.status',
      'service.stop',
    ] as const
  ).map((operation) =>
    z.strictObject({
      protocolVersion: z.literal(1),
      requestId: z.uuid(),
      operation: z.literal(operation),
      params: z.strictObject({}),
    }),
  ),
  z.strictObject({
    protocolVersion: z.literal(1),
    requestId: z.uuid(),
    operation: z.literal('connection.revoke'),
    params: z.strictObject({
      id: idSchema('conn'),
      expectedRevision: z.number().int().positive(),
    }),
  }),
  z.strictObject({
    protocolVersion: z.literal(1),
    requestId: z.uuid(),
    operation: z.literal('binding.revoke'),
    params: z.strictObject({
      id: idSchema('bind'),
      expectedRevision: z.number().int().positive(),
    }),
  }),
  z.strictObject({
    protocolVersion: z.literal(1),
    requestId: z.uuid(),
    operation: z.literal('binding.show'),
    params: z.strictObject({ id: idSchema('bind') }),
  }),
])
type AdminRequest = z.infer<typeof adminRequestSchema>
type AgentRequest = z.infer<typeof agentRequestSchema>
export type Request = AdminRequest | AgentRequest

const denied = () =>
  new CharactersError(
    'PERMISSION_DENIED',
    '连接凭据或授权无效。',
    '由工作区管理员重新授权。',
  )
const inactive = () =>
  new CharactersError(
    'BINDING_INACTIVE',
    '角色绑定已失效。',
    '在当前宿主会话重新申请绑定。',
  )
const grantRef = (id: string) =>
  `connections/${idSchema('conn').parse(id)}.json`
const bindingRef = (id: string) =>
  `bindings/${idSchema('bind').parse(id)}/binding.json`

export class ManagementStore {
  constructor(
    readonly workspace: WorkspaceHandle,
    readonly generation: string,
    readonly verifier?: HostVerifier,
  ) {}

  async config() {
    if (
      !(await exists(await containedPath(this.workspace.root, 'service.yaml')))
    )
      throw new CharactersError(
        'RECOVERY_REQUIRED',
        '尚未执行服务数据迁移。',
        '先运行 workspace migrate --target service-v1。',
      )
    const config = await readJson(
      this.workspace.root,
      'service.yaml',
      serviceConfigSchema,
    )
    if (!config.enabled || config.workspaceId !== this.workspace.config.id)
      throw new CharactersError(
        'PERMISSION_DENIED',
        '服务配置未启用或工作区不匹配。',
        '检查迁移状态。',
      )
    return config
  }
  async authorize(principal: Principal): Promise<ConnectionGrant | undefined> {
    await this.config()
    if (principal.kind === 'admin') return undefined
    let grant: ConnectionGrant
    try {
      grant = await readJson(
        this.workspace.root,
        grantRef(principal.id),
        connectionGrantSchema,
      )
    } catch {
      throw denied()
    }
    if (
      grant.id !== principal.id ||
      grant.workspaceId !== this.workspace.config.id ||
      grant.status !== 'active' ||
      Date.parse(grant.expiresAt) <= Date.now() ||
      !timingSafeEqual(
        Buffer.from(sha256(principal.token), 'hex'),
        Buffer.from(grant.credentialDigest, 'hex'),
      )
    )
      throw denied()
    return grant
  }
  async bindings(): Promise<BindingRecord[]> {
    const records = []
    for (const name of await recordNames(this.workspace, 'bindings')) {
      if (!idSchema('bind').safeParse(name).success)
        throw new CharactersError(
          'STORE_CORRUPT',
          '绑定目录包含未知对象。',
          '检查工作区。',
        )
      const record = await readJson(
        this.workspace.root,
        bindingRef(name),
        bindingSchema,
      )
      if (record.id !== name || record.workspaceId !== this.workspace.config.id)
        throw inactive()
      records.push(record)
    }
    return records
  }
  async grants(): Promise<ConnectionGrant[]> {
    const records = []
    for (const name of await recordNames(this.workspace, 'connections')) {
      const id = name.endsWith('.json') ? name.slice(0, -5) : ''
      if (!idSchema('conn').safeParse(id).success)
        throw new CharactersError(
          'STORE_CORRUPT',
          '授权目录包含未知对象。',
          '检查工作区。',
        )
      const record = await readJson(
        this.workspace.root,
        grantRef(id),
        connectionGrantSchema,
      )
      if (record.id !== id || record.workspaceId !== this.workspace.config.id)
        throw denied()
      records.push(record)
    }
    return records
  }
  async audit(
    tx: FileTransaction,
    actor: 'admin' | 'agent' | 'service',
    operation: string,
    connectionId?: string,
    bindingId?: string,
    outcome: 'success' | 'denied' = 'success',
    code?: z.infer<typeof accessEventSchema>['code'],
    details?: { memoryId?: string; snapshotId?: string },
  ) {
    const event = accessEventSchema.parse({
      schemaVersion: 1,
      id: newId('acc'),
      workspaceId: this.workspace.config.id,
      at: utcNow(),
      actor,
      operation,
      connectionId,
      bindingId,
      outcome,
      code,
      ...details,
    })
    await tx.put(`audit/${event.id}.json`, jsonBytes(event))
  }
  async saveBinding(
    tx: FileTransaction,
    binding: BindingRecord,
    status: BindingRecord['status'],
  ) {
    const ref = bindingRef(binding.id)
    const updated = bindingSchema.parse({
      ...binding,
      revision: binding.revision + 1,
      status,
    })
    await tx.put(
      ref,
      jsonBytes(updated),
      sha256(await readBytes(this.workspace.root, ref, 1024 * 1024)),
    )
    return updated
  }
  async interrupt(all = false) {
    return withStore(this.workspace, async (tx) => {
      await this.config()
      let count = 0
      for (const binding of await this.bindings()) {
        if (
          binding.status === 'active' &&
          (all || binding.serviceGeneration !== this.generation)
        ) {
          await this.saveBinding(tx, binding, 'interrupted')
          await this.audit(
            tx,
            'service',
            'binding.interrupt',
            binding.connectionId,
            binding.id,
          )
          count++
        }
      }
      return count
    })
  }
  async expireBindings() {
    return withStore(this.workspace, async (tx) => {
      for (const binding of await this.bindings()) {
        if (
          binding.status === 'active' &&
          Date.parse(binding.expiresAt) <= Date.now()
        ) {
          await this.saveBinding(tx, binding, 'expired')
          await this.audit(
            tx,
            'service',
            'binding.expire',
            binding.connectionId,
            binding.id,
          )
        }
      }
    })
  }
  async activeBinding(id: string, grant: ConnectionGrant) {
    let binding: BindingRecord
    try {
      binding = await readJson(
        this.workspace.root,
        bindingRef(id),
        bindingSchema,
      )
    } catch {
      throw inactive()
    }
    if (
      binding.id !== id ||
      binding.workspaceId !== this.workspace.config.id ||
      binding.connectionId !== grant.id ||
      binding.hostSessionRef !== grant.hostSessionRef
    )
      throw denied()
    if (
      binding.status !== 'active' ||
      binding.serviceGeneration !== this.generation ||
      binding.grantRevision !== grant.revision ||
      Date.parse(binding.expiresAt) <= Date.now()
    )
      throw inactive()
    const evidence = await readJson(
      this.workspace.root,
      `evidence/${binding.evidenceId}.json`,
      hostEvidenceSchema,
    )
    if (
      evidence.id !== binding.evidenceId ||
      evidence.connectionId !== grant.id ||
      evidence.hostSessionRef !== grant.hostSessionRef ||
      Date.parse(evidence.validUntil) <= Date.now()
    )
      throw new CharactersError(
        'EVIDENCE_EXPIRED',
        '宿主会话隔离凭据已失效。',
        '通过可信宿主适配器重新验证。',
      )
    if (
      binding.isolationEffective === 'strict' &&
      (evidence.result !== 'pass' ||
        evidence.globalMemoryRead !== 'disabled' ||
        evidence.globalMemoryWrite !== 'disabled')
    )
      throw denied()
    return binding
  }
  async execute(
    principal: Principal,
    request: Request,
    credential?: { id: string; digest: string },
    storageOptions: Pick<StorageOptions, 'checkpoint'> = {},
  ) {
    // Verifier may contact a trusted host; never hold the transaction lock across it.
    const initial = await withStore(this.workspace, async () =>
      this.authorize(principal),
    )
    const knowledge = new KnowledgeStore(this.workspace)
    const needsEvidence =
      request.operation === 'bindings.open' ||
      (request.operation !== 'bindings.close' && 'bindingId' in request.params)
    const verified =
      needsEvidence && initial ? await this.verifyHost(initial) : undefined
    const fingerprint = sha256(
      canonicalJson({
        actor: principal.kind === 'admin' ? 'admin' : principal.id,
        request,
      }),
    )
    const authorize = async () => {
      const grant = await this.authorize(principal)
      if (
        grant &&
        needsEvidence &&
        grant.isolation === 'strict' &&
        (!verified ||
          verified.assessment.hostSessionRef !== grant.hostSessionRef ||
          !strictActivationDecision(verified.assessment, new Date()).allowed)
      )
        throw new CharactersError(
          'ISOLATION_UNSUPPORTED',
          '当前宿主会话缺少有效的可信隔离验证。',
          '接入可信宿主适配器后重新验证。',
        )
      if (grant && 'bindingId' in request.params) {
        const operationAction = {
          'context.get': 'context.read',
          'memory.search': 'memory.search',
          'memory.propose': 'memory.propose',
        } as const
        if (request.operation in operationAction)
          this.action(
            grant,
            operationAction[request.operation as keyof typeof operationAction],
          )
        if (request.operation === 'bindings.close') {
          const binding = await readJson(
            this.workspace.root,
            bindingRef(request.params.bindingId),
            bindingSchema,
          )
          if (
            binding.connectionId !== grant.id ||
            binding.hostSessionRef !== grant.hostSessionRef ||
            binding.serviceGeneration !== this.generation
          )
            throw denied()
        } else {
          const binding = await this.activeBinding(
            request.params.bindingId,
            grant,
          )
          const evidence = await readJson(
            this.workspace.root,
            `evidence/${binding.evidenceId}.json`,
            hostEvidenceSchema,
          )
          if (
            verified &&
            evidence.configurationDigest !== verified.configurationDigest
          )
            throw new CharactersError(
              'EVIDENCE_EXPIRED',
              '宿主配置已改变。',
              '重新验证并建立新绑定。',
            )
        }
      }
    }
    return withStore(
      this.workspace,
      async (tx) => {
        const grant = await this.authorize(principal)
        let result: unknown
        if (principal.kind === 'admin') {
          if (!adminRequestSchema.safeParse(request).success) throw denied()
          const admin = request as AdminRequest
          switch (admin.operation) {
            case 'memory.list': {
              const records = (
                await knowledge.memories(admin.params.characterId)
              )
                .filter(
                  (record) =>
                    !admin.params.status ||
                    record.status === admin.params.status,
                )
                .filter(
                  (record) =>
                    !admin.params.after || record.id > admin.params.after,
                )
              const page = records.slice(0, admin.params.limit ?? 50)
              result = {
                items: page.map((record) => ({
                  id: record.id,
                  revision: record.revision,
                  kind: record.kind,
                  status: record.status,
                  scope: record.scope,
                  tags: record.tags,
                  recordedAt: record.recordedAt,
                })),
                nextCursor:
                  records.length > page.length
                    ? (page.at(-1)?.id ?? null)
                    : null,
              }
              break
            }
            case 'memory.show': {
              const record = await knowledge.memory(
                admin.params.characterId,
                admin.params.id,
              )
              result = {
                record,
                sourceExcerpts: await knowledge.verifySources(record),
              }
              break
            }
            case 'memory.confirm':
            case 'memory.reject':
            case 'memory.retract':
              result = await knowledge.decide(
                tx,
                admin.params.characterId,
                admin.params.id,
                admin.operation === 'memory.confirm'
                  ? 'confirm'
                  : admin.operation === 'memory.reject'
                    ? 'reject'
                    : 'retract',
                admin.params.expectedRevision,
                admin.params.reason,
                admin.params.replaceExpectedRevision,
                admin.params.factBasis,
              )
              break
            case 'context.import':
              result = await knowledge.importContext(
                tx,
                admin.params.key,
                admin.params.text,
                admin.params.expectedRevision,
              )
              break
            case 'context.revoke':
              result = await knowledge.revokeContext(
                tx,
                admin.params.key,
                admin.params.expectedRevision,
              )
              break
            case 'context.explain':
              result = await knowledge.explain(
                admin.params.bindingId,
                admin.params.snapshotId,
                admin.params.content,
              )
              break
            case 'connection.grant': {
              if (!credential) throw denied()
              // Relaxed is possible only through this authenticated human management surface.
              const { ttlSeconds, ...fields } = admin.params
              const record = connectionGrantSchema.parse({
                ...fields,
                schemaVersion: 1,
                id: credential.id,
                revision: 1,
                workspaceId: this.workspace.config.id,
                status: 'active',
                createdAt: utcNow(),
                expiresAt: new Date(
                  Date.now() + ttlSeconds * 1000,
                ).toISOString(),
                credentialDigest: credential.digest,
              })
              await tx.put(grantRef(record.id), jsonBytes(record))
              result = this.publicGrant(record)
              break
            }
            case 'connection.list':
              result = (await this.grants()).map((item) =>
                this.publicGrant(item),
              )
              break
            case 'binding.list':
              result = await this.bindings()
              break
            case 'binding.show':
              result = await readJson(
                this.workspace.root,
                bindingRef(admin.params.id),
                bindingSchema,
              )
              break
            case 'binding.revoke': {
              const record = await readJson(
                this.workspace.root,
                bindingRef(admin.params.id),
                bindingSchema,
              )
              this.expectRevision(
                record.revision,
                admin.params.expectedRevision,
              )
              result =
                record.status === 'active'
                  ? await this.saveBinding(tx, record, 'revoked')
                  : record
              break
            }
            case 'connection.revoke': {
              const ref = grantRef(admin.params.id)
              const record = await readJson(
                this.workspace.root,
                ref,
                connectionGrantSchema,
              )
              this.expectRevision(
                record.revision,
                admin.params.expectedRevision,
              )
              if (record.status === 'active') {
                const updated = connectionGrantSchema.parse({
                  ...record,
                  revision: record.revision + 1,
                  status: 'revoked',
                })
                await tx.put(
                  ref,
                  jsonBytes(updated),
                  sha256(
                    await readBytes(this.workspace.root, ref, 1024 * 1024),
                  ),
                )
                for (const binding of await this.bindings())
                  if (
                    binding.connectionId === record.id &&
                    binding.status === 'active'
                  )
                    await this.saveBinding(tx, binding, 'revoked')
                result = this.publicGrant(updated)
              } else result = this.publicGrant(record)
              break
            }
            case 'service.status':
              result = {
                workspaceId: this.workspace.config.id,
                generation: this.generation,
                protocolVersion: 1,
                status: 'running',
              }
              break
            case 'service.stop':
              result = { status: 'stopping', generation: this.generation }
              break
          }
        } else {
          if (!grant || !agentRequestSchema.safeParse(request).success)
            throw denied()
          switch ((request as AgentRequest).operation) {
            case 'context.get': {
              const input = request as Extract<
                AgentRequest,
                { operation: 'context.get' }
              >
              const binding = await this.activeBinding(
                input.params.bindingId,
                grant,
              )
              result = await knowledge.deliver(
                tx,
                binding,
                await this.config(),
                input.params.mode,
              )
              break
            }
            case 'memory.search': {
              const input = request as Extract<
                AgentRequest,
                { operation: 'memory.search' }
              >
              const binding = await this.activeBinding(
                input.params.bindingId,
                grant,
              )
              result = await knowledge.deliver(
                tx,
                binding,
                await this.config(),
                'conversation',
                { query: input.params.query, limit: input.params.limit },
              )
              break
            }
            case 'memory.propose': {
              const input = request as Extract<
                AgentRequest,
                { operation: 'memory.propose' }
              >
              result = await knowledge.propose(
                tx,
                await this.activeBinding(input.params.bindingId, grant),
                input.params.candidate,
              )
              break
            }
            case 'characters.list': {
              this.action(grant, 'discover')
              const lock = await readJson(
                this.workspace.root,
                'characters.lock',
                charactersLockSchema,
              )
              result = lock.characters
                .filter((item) => grant.characterIds.includes(item.characterId))
                .map((item) => ({
                  id: item.characterId,
                  version: item.version,
                  digest: item.digest,
                }))
              break
            }
            case 'bindings.open': {
              const input = request as Extract<
                AgentRequest,
                { operation: 'bindings.open' }
              >
              this.action(grant, 'bind')
              const scope = usageScopeSchema.parse(input.params.scope)
              if (
                !grant.characterIds.includes(input.params.characterId) ||
                (scope.projectKey &&
                  !grant.allowedProjectKeys.includes(scope.projectKey)) ||
                scope.contextKeys.some(
                  (key) => !grant.allowedContextKeys.includes(key),
                )
              )
                throw denied()
              const config = await this.config()
              const evidence = this.evidence(grant, verified)
              if (grant.isolation === 'strict' && evidence.result !== 'pass')
                throw new CharactersError(
                  'ISOLATION_UNSUPPORTED',
                  '当前宿主会话缺少可信隔离验证。',
                  '接入可信宿主生命周期适配器；实验报告和模型声明不能用于授权。',
                )
              for (const other of await this.bindings()) {
                const owner = await readJson(
                  this.workspace.root,
                  grantRef(other.connectionId),
                  connectionGrantSchema,
                )
                if (
                  other.status === 'active' &&
                  other.serviceGeneration === this.generation &&
                  Date.parse(other.expiresAt) > Date.now() &&
                  owner.hostId === grant.hostId &&
                  other.hostSessionRef === grant.hostSessionRef
                )
                  throw new CharactersError(
                    'CONFLICT',
                    '该宿主会话已有角色绑定。',
                    '先关闭旧绑定，再显式绑定新角色。',
                  )
              }
              const lock = await readJson(
                this.workspace.root,
                'characters.lock',
                charactersLockSchema,
              )
              const item = lock.characters.find(
                (item) => item.characterId === input.params.characterId,
              )
              if (
                !item ||
                item.manifestRef !==
                  `packages/${item.characterId}/${item.digest}/character.yaml`
              )
                throw denied()
              const loaded = await loadCharacter(
                await containedPath(
                  this.workspace.root,
                  `packages/${item.characterId}/${item.digest}`,
                ),
              )
              if (
                loaded.digest !== item.digest ||
                loaded.manifest.version !== item.version ||
                loaded.manifest.id !== item.characterId
              )
                throw new CharactersError(
                  'STORE_CORRUPT',
                  '已安装角色快照损坏。',
                  '恢复可信角色包。',
                )
              const binding = bindingSchema.parse({
                schemaVersion: 1,
                id: newId('bind'),
                revision: 1,
                workspaceId: this.workspace.config.id,
                connectionId: grant.id,
                grantRevision: grant.revision,
                serviceGeneration: this.generation,
                hostSessionRef: grant.hostSessionRef,
                character: {
                  id: item.characterId,
                  version: item.version,
                  digest: item.digest,
                },
                scope,
                actions: grant.actions,
                evidenceId: evidence.id,
                isolationEffective: grant.isolation,
                status: 'active',
                createdAt: utcNow(),
                expiresAt: new Date(
                  Math.min(
                    Date.now() + config.bindingTtlSeconds * 1000,
                    Date.parse(grant.expiresAt),
                    Date.parse(evidence.validUntil),
                  ),
                ).toISOString(),
              })
              await tx.put(`evidence/${evidence.id}.json`, jsonBytes(evidence))
              await tx.put(bindingRef(binding.id), jsonBytes(binding))
              result = binding
              break
            }
            case 'bindings.close': {
              const input = request as Extract<
                AgentRequest,
                { operation: 'bindings.close' }
              >
              const binding = await this.activeBinding(
                input.params.bindingId,
                grant,
              )
              this.expectRevision(
                binding.revision,
                input.params.expectedRevision,
              )
              result = await this.saveBinding(tx, binding, 'closed')
              break
            }
          }
        }
        const memoryResult = memoryV2Schema.safeParse(result)
        const deliveryResult =
          request.operation === 'context.get'
            ? (result as { id: string })
            : request.operation === 'memory.search'
              ? (result as { delivery: { id: string } }).delivery
              : undefined
        await this.audit(
          tx,
          principal.kind,
          request.operation,
          grant?.id,
          'bindingId' in request.params ? request.params.bindingId : undefined,
          'success',
          undefined,
          {
            ...(memoryResult.success ? { memoryId: memoryResult.data.id } : {}),
            ...(deliveryResult ? { snapshotId: deliveryResult.id } : {}),
          },
        )
        return result
      },
      {
        ...storageOptions,
        ...([
          'connection.grant',
          'connection.revoke',
          'binding.revoke',
          'bindings.open',
          'bindings.close',
          'memory.propose',
          'memory.confirm',
          'memory.reject',
          'memory.retract',
          'context.import',
          'context.revoke',
        ].includes(request.operation)
          ? { requestId: request.requestId, fingerprint }
          : {}),
        authorize,
        beforeCommit: authorize,
        validateReplay: async (result) => {
          if (
            request.operation === 'memory.propose' &&
            principal.kind === 'agent'
          ) {
            const original = memoryV2Schema.parse(result)
            const current = await knowledge.memory(
              original.characterId,
              original.id,
            )
            if (
              current.status !== 'candidate' ||
              canonicalJson(current) !== canonicalJson(original)
            )
              throw new CharactersError(
                'CONFLICT',
                '候选已被审核，不能重放旧正文。',
                '由管理员查看当前记录。',
              )
            await knowledge.verifySources(current)
          }
          if (
            request.operation === 'bindings.open' &&
            principal.kind === 'agent'
          ) {
            const binding = bindingSchema.parse(result)
            const current = await this.authorize(principal)
            if (!current) throw denied()
            await this.activeBinding(binding.id, current)
            const evidence = await readJson(
              this.workspace.root,
              `evidence/${binding.evidenceId}.json`,
              hostEvidenceSchema,
            )
            if (
              verified &&
              evidence.configurationDigest !== verified.configurationDigest
            )
              throw new CharactersError(
                'EVIDENCE_EXPIRED',
                '宿主配置已改变。',
                '重新验证并建立新绑定。',
              )
          }
        },
      },
    )
  }
  publicGrant(grant: ConnectionGrant) {
    const { credentialDigest: _digest, ...safe } = grant
    return safe
  }
  async verifyHost(grant: ConnectionGrant): Promise<VerifiedHost | undefined> {
    if (!this.verifier) return undefined
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        controller.abort()
        resolve(undefined)
      }, 5000)
    })
    try {
      return await Promise.race([
        this.verifier(Object.freeze({ ...grant }), controller.signal),
        deadline,
      ])
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }
  expectRevision(actual: number, expected?: number) {
    if (expected === undefined)
      throw new CharactersError(
        'INVALID_INPUT',
        '修改操作需要 expectedRevision。',
        '读取当前版本后重试。',
      )
    if (actual !== expected)
      throw new CharactersError(
        'CONFLICT',
        '版本冲突。',
        '读取当前版本后重试。',
      )
  }
  action(grant: ConnectionGrant, action: ConnectionGrant['actions'][number]) {
    if (!grant.actions.includes(action)) throw denied()
  }
  evidence(grant: ConnectionGrant, verified?: VerifiedHost): HostEvidence {
    const a = verified?.assessment
    const pass =
      a &&
      a.hostSessionRef === grant.hostSessionRef &&
      strictActivationDecision(a, new Date()).allowed
    return hostEvidenceSchema.parse({
      schemaVersion: 1,
      id: newId('evd'),
      connectionId: grant.id,
      hostSessionRef: grant.hostSessionRef,
      hostId: grant.hostId,
      hostVersion: verified?.hostVersion ?? 'unknown',
      pluginVersion: verified?.pluginVersion ?? 'unknown',
      verifierVersion: verified?.verifierVersion ?? 'unavailable',
      configurationDigest:
        verified?.configurationDigest ?? sha256('unverified'),
      hostBinaryDigest: verified?.hostBinaryDigest,
      globalMemoryRead: a?.memoryRead ?? 'unknown',
      globalMemoryWrite: a?.memoryGeneration ?? 'unknown',
      contextInjection: pass ? 'tool-result' : 'unknown',
      contextRemoval: 'unsupported',
      fileBoundary: 'host-controlled',
      providerRetention: 'unknown',
      result: pass ? 'pass' : 'unverified',
      checkedAt: a?.checkedAt ?? utcNow(),
      validUntil: a?.validUntil ?? new Date(Date.now() + 300000).toISOString(),
    })
  }
}
