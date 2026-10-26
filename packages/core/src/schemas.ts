import { z } from 'zod'

export const schemaVersion = z.literal(1)
export const revisionSchema = z.number().int().min(1)
export const utcSchema = z.iso.datetime({ offset: false })
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const characterIdSchema = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
export const languageSchema = z.enum(['cn', 'ja', 'en'])
const text = z.string().trim().min(1)
const uuidPattern =
  '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
export const idPrefixes = [
  'ws',
  'ses',
  'run',
  'work',
  'mem',
  'msg',
  'src',
  'prop',
  'snap',
  'evd',
  'txn',
  'conn',
  'bind',
  'acc',
] as const
export type IdPrefix = (typeof idPrefixes)[number]
export const idSchema = (prefix: IdPrefix) =>
  z.string().regex(new RegExp(`^${prefix}_${uuidPattern}$`))

// Only canonical, portable POSIX references are persisted. No drive letters or backslashes.
export const relativePathSchema = z
  .string()
  .max(240)
  .regex(
    /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*(?:^|\/)(?:[cC][oO][nN]|[pP][rR][nN]|[aA][uU][xX]|[nN][uU][lL]|[cC][oO][mM][0-9]|[lL][pP][tT][0-9])(?:\.|\/|$))(?!.*[. ](?:\/|$))[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/,
  )
const contextKey = z.string().regex(/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)+$/)
const semver = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  )

export const characterManifestSchema = z.strictObject({
  schemaVersion,
  id: characterIdSchema,
  name: text.max(120),
  version: semver,
  languages: z.array(languageSchema).min(1).max(3),
  defaultLanguage: languageSchema,
  files: z.strictObject({
    persona: relativePathSchema,
    voice: relativePathSchema,
    relationships: relativePathSchema,
  }),
  modes: z.strictObject({
    conversation: relativePathSchema,
    coauthor: relativePathSchema,
  }),
  examples: z.strictObject({
    good: relativePathSchema,
    bad: relativePathSchema,
  }),
  contextKeys: z.array(contextKey).max(64),
})

const runtimeFields = {
  args: z.array(z.string()).max(64),
  environmentAllowlist: z
    .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
    .max(64),
  contextBudget: z.strictObject({
    maxUtf8Bytes: z.number().int().positive(),
    maxOutputUtf8Bytes: z.number().int().positive(),
  }),
}
export const workspaceSchema = z.strictObject({
  schemaVersion,
  id: idSchema('ws'),
  timezone: text.max(100),
  policy: z.strictObject({
    isolation: z.enum(['strict', 'relaxed']),
    memoryWrite: z.literal('confirm'),
    network: z.literal('adapter-only'),
    tools: z.array(z.literal('source.read')).max(1),
  }),
  runtime: z.discriminatedUnion('adapter', [
    z.strictObject({ ...runtimeFields, adapter: z.literal('unconfigured') }),
    z.strictObject({ ...runtimeFields, adapter: z.literal('fake') }),
    z.strictObject({
      ...runtimeFields,
      adapter: z.literal('stdio'),
      command: text,
    }),
  ]),
})

export const installedCharacterSchema = z.strictObject({
  characterId: characterIdSchema,
  version: semver,
  digest: digestSchema,
  manifestRef: relativePathSchema,
})
export const charactersLockSchema = z.strictObject({
  schemaVersion,
  revision: revisionSchema,
  characters: z.array(installedCharacterSchema),
})
const identity = z
  .string()
  .regex(/^(?:person|character):[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
export const workSchema = z.strictObject({
  schemaVersion,
  id: idSchema('work'),
  revision: revisionSchema,
  title: text,
  language: languageSchema,
  kind: z.enum(['post', 'log', 'crap']),
  attribution: z.strictObject({
    mode: z.enum(['human', 'character', 'dialogue']),
    authors: z.array(identity).min(1),
    contributors: z.array(identity),
  }),
  stage: z.enum(['discussion', 'outline', 'draft', 'review', 'ready']),
  publication: z
    .strictObject({
      slug: characterIdSchema,
      description: text.optional(),
      published: utcSchema,
    })
    .optional(),
  contentRevision: revisionSchema,
  contentDigest: digestSchema,
  createdAt: utcSchema,
  updatedAt: utcSchema,
})

export const sourceSchema = z.strictObject({
  id: idSchema('src'),
  kind: z.enum(['user-note', 'file', 'url-snapshot', 'message']),
  title: text,
  snapshotRef: relativePathSchema,
  digest: digestSchema,
  origin: z
    .url({ protocol: /^https?$/ })
    .regex(/^https?:\/\/[^/?#@]+(?:[/?#].*)?$/)
    .optional(),
  messageRef: z
    .strictObject({ sessionId: idSchema('ses'), messageId: idSchema('msg') })
    .optional(),
  capturedAt: utcSchema,
  visibility: z.enum(['private', 'publishable']),
})

const sessionFields = {
  schemaVersion,
  id: idSchema('ses'),
  revision: revisionSchema,
  character: z.strictObject({
    id: characterIdSchema,
    version: semver,
    digest: digestSchema,
  }),
  language: languageSchema,
  status: z.enum(['open', 'closed']),
  lastMessageSequence: z.number().int().nonnegative(),
  activeRunId: idSchema('run').optional(),
  createdAt: utcSchema,
  updatedAt: utcSchema,
}
export const sessionSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    ...sessionFields,
    mode: z.literal('conversation'),
    workId: idSchema('work').optional(),
  }),
  z.strictObject({
    ...sessionFields,
    mode: z.literal('coauthor'),
    workId: idSchema('work'),
  }),
])

export const errorCodeSchema = z.enum([
  'INVALID_INPUT',
  'NOT_FOUND',
  'CONFLICT',
  'BUSY',
  'ISOLATION_UNSUPPORTED',
  'PERMISSION_DENIED',
  'CONTEXT_LIMIT',
  'ADAPTER_PROTOCOL',
  'ADAPTER_FAILED',
  'ADAPTER_TIMEOUT',
  'STORE_CORRUPT',
  'RECOVERY_REQUIRED',
  'CANCELLED',
  'PROTOCOL_UNSUPPORTED',
  'SERVICE_UNAVAILABLE',
  'BINDING_INACTIVE',
  'EVIDENCE_EXPIRED',
])
export const runSchema = z.strictObject({
  schemaVersion,
  id: idSchema('run'),
  sessionId: idSchema('ses'),
  parentRunId: idSchema('run').optional(),
  status: z.enum(['prepared', 'running', 'completed', 'failed', 'interrupted']),
  adapterId: text,
  adapterVersion: text,
  model: text.optional(),
  contextSnapshotId: idSchema('snap'),
  capabilityEvidenceId: idSchema('evd'),
  isolationRequested: z.enum(['strict', 'relaxed']),
  isolationEffective: z.enum(['strict', 'relaxed']),
  startedAt: utcSchema.optional(),
  endedAt: utcSchema.optional(),
  errorCode: errorCodeSchema.optional(),
  resultDigest: digestSchema.optional(),
  owner: z
    .strictObject({ pid: z.number().int().positive(), host: z.string().min(1) })
    .optional(),
})

const messageFields = {
  id: idSchema('msg'),
  sequence: revisionSchema,
  sessionId: idSchema('ses'),
  text: text,
  createdAt: utcSchema,
}
export const messageSchema = z.discriminatedUnion('role', [
  z.strictObject({ ...messageFields, role: z.literal('user') }),
  z.strictObject({
    ...messageFields,
    role: z.literal('character'),
    characterId: characterIdSchema,
    runId: idSchema('run'),
  }),
])
export const memoryKindSchema = z.enum([
  'fact',
  'event',
  'opinion',
  'relationship',
  'preference',
])
export const memorySchema = z.strictObject({
  schemaVersion,
  id: idSchema('mem'),
  revision: revisionSchema,
  characterId: characterIdSchema,
  kind: memoryKindSchema,
  status: z.enum([
    'candidate',
    'confirmed',
    'rejected',
    'superseded',
    'retracted',
  ]),
  content: text,
  tags: z.array(text),
  visibility: z.enum(['private', 'publishable']),
  occurredAt: utcSchema.optional(),
  recordedAt: utcSchema,
  sources: z
    .array(
      z.discriminatedUnion('type', [
        z.strictObject({
          type: z.literal('message'),
          sessionId: idSchema('ses'),
          messageId: idSchema('msg'),
        }),
        z.strictObject({
          type: z.literal('source'),
          workId: idSchema('work'),
          sourceId: idSchema('src'),
        }),
        z.strictObject({
          type: z.literal('user-statement'),
          statementRef: relativePathSchema,
        }),
      ]),
    )
    .min(1),
  replaces: idSchema('mem').optional(),
  decisions: z.array(
    z.strictObject({
      action: z.enum(['confirm', 'reject', 'supersede', 'retract']),
      actor: z.literal('user'),
      at: utcSchema,
      reason: text.optional(),
    }),
  ),
})

export const contextSnapshotSchema = z.strictObject({
  schemaVersion,
  id: idSchema('snap'),
  sessionId: idSchema('ses'),
  workRevision: revisionSchema.optional(),
  characterDigest: digestSchema,
  policyDigest: digestSchema,
  createdAt: utcSchema,
  entries: z.array(
    z.strictObject({
      sourceId: text,
      kind: z.enum([
        'policy',
        'persona',
        'mode',
        'context',
        'memory',
        'message',
        'work',
        'example',
      ]),
      digest: digestSchema,
      reason: text,
      utf8Bytes: z.number().int().nonnegative(),
      truncated: z.boolean(),
    }),
  ),
  excluded: z.array(z.strictObject({ sourceId: text, reason: text })),
  inputDigest: digestSchema,
  inputRef: relativePathSchema,
})

export const proposalSchema = z.strictObject({
  schemaVersion,
  id: idSchema('prop'),
  workId: idSchema('work'),
  origin: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('user') }),
    z.strictObject({
      type: z.literal('run'),
      sessionId: idSchema('ses'),
      runId: idSchema('run'),
    }),
  ]),
  baseRevision: revisionSchema,
  target: z.enum(['outline', 'draft']),
  content: text,
  sourceIds: z.array(idSchema('src')),
  createdAt: utcSchema,
})

export const writeLockSchema = z.strictObject({
  schemaVersion,
  token: z.uuid(),
  pid: z.number().int().positive(),
  host: text,
  createdAt: utcSchema,
})
export const transactionSchema = z.strictObject({
  schemaVersion,
  id: idSchema('txn'),
  workspaceId: idSchema('ws'),
  createdAt: utcSchema,
  operations: z
    .array(
      z.strictObject({
        ref: relativePathSchema,
        before: digestSchema.nullable(),
        after: digestSchema,
        content: z
          .string()
          .regex(
            /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
          ),
      }),
    )
    .min(1)
    .max(256),
})
export const receiptSchema = z.strictObject({
  schemaVersion,
  requestId: z.uuid(),
  fingerprint: digestSchema,
  result: z.unknown(),
  resultDigest: digestSchema,
})
export const revisionManifestSchema = z.strictObject({
  schemaVersion,
  workId: idSchema('work'),
  revision: revisionSchema,
  previousDigest: digestSchema.nullable(),
  record: workSchema.omit({ contentDigest: true }),
  files: z.strictObject({
    'brief.md': digestSchema,
    'outline.md': digestSchema,
    'draft.md': digestSchema,
    'sources.json': digestSchema,
  }),
})

const support = z.enum(['supported', 'unsupported', 'unknown'])
export const adapterCapabilitiesSchema = z.strictObject({
  protocolVersion: z.literal(1),
  adapterId: text,
  adapterVersion: text,
  hostVersion: text,
  freshExecution: support,
  hostMemory: z.enum(['disabled', 'session-scoped', 'global', 'unknown']),
  toolBoundary: z.enum(['enforced', 'none', 'unknown']),
  defaultConfigDiscovery: z.enum(['controlled', 'unknown']),
  cancellation: support,
  providerRetention: z.enum(['configured', 'unknown']),
  evidence: z.strictObject({
    id: idSchema('evd'),
    verifiedAt: utcSchema,
    validUntil: utcSchema,
    hostBinaryDigest: digestSchema,
    configurationDigest: digestSchema,
    suiteVersion: text,
    result: z.enum(['pass', 'fail', 'unverified']),
  }),
})
export const executionRequestSchema = z.strictObject({
  protocolVersion: z.literal(1),
  runId: idSchema('run'),
  sessionId: idSchema('ses'),
  work: z
    .strictObject({ id: idSchema('work'), revision: revisionSchema })
    .optional(),
  input: z.strictObject({
    digest: digestSchema,
    messages: z
      .array(
        z.strictObject({
          role: z.enum(['system', 'user', 'assistant']),
          // Input snapshots are byte-sensitive; never trim role documents or code.
          text: z.string().min(1),
        }),
      )
      .min(1),
  }),
  isolation: z.enum(['strict', 'relaxed']),
  tools: z.array(
    z.strictObject({ name: z.literal('source.read'), schemaVersion }),
  ),
  allowedSourceIds: z.array(idSchema('src')),
  limits: z.strictObject({
    timeoutMs: z.number().int().positive(),
    maxOutputUtf8Bytes: z.number().int().positive(),
    maxToolCalls: z.number().int().nonnegative(),
  }),
})
const eventBase = { runId: idSchema('run'), sequence: revisionSchema }
export const adapterEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...eventBase, type: z.literal('started') }),
  z.strictObject({ ...eventBase, type: z.literal('text'), delta: z.string() }),
  z.strictObject({
    ...eventBase,
    type: z.literal('tool-request'),
    requestId: z.uuid(),
    name: z.literal('source.read'),
    sourceId: idSchema('src'),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('proposal'),
    proposal: z.strictObject({
      target: z.enum(['outline', 'draft']),
      baseRevision: revisionSchema,
      content: text,
      sourceIds: z.array(idSchema('src')),
    }),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('memory-candidate'),
    candidate: z.strictObject({
      kind: memoryKindSchema,
      content: text,
      sourceIds: z.array(text).min(1),
    }),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('completed'),
    text,
    isolationAudit: z
      .strictObject({
        globalMemoryMetadataUnchanged: z.boolean(),
        executionDirectoryRemoved: z.boolean(),
        toolCallsObserved: z.number().int().nonnegative(),
      })
      .optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('failed'),
    code: errorCodeSchema,
    message: text,
  }),
])

export const codexReplySchema = z.strictObject({
  reply: z.string().min(1),
  proposal: z.strictObject({
    target: z.enum(['none', 'outline', 'draft']),
    content: z.string(),
    sourceIds: z.array(z.string()),
  }),
})

export const usageKeySchema = z
  .string()
  .max(128)
  .regex(/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/)
export const usageScopeSchema = z.strictObject({
  purpose: z
    .string()
    .min(1)
    .refine(
      (value) =>
        value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 512,
    ),
  projectKey: usageKeySchema.optional(),
  contextKeys: z
    .array(usageKeySchema)
    .max(64)
    .refine((items) => new Set(items).size === items.length),
})
export const connectionActionsSchema = z
  .array(
    z.enum([
      'discover',
      'bind',
      'context.read',
      'memory.search',
      'memory.propose',
    ]),
  )
  .min(1)
  .max(5)
export const connectionGrantSchema = z.strictObject({
  schemaVersion,
  id: idSchema('conn'),
  revision: revisionSchema,
  workspaceId: idSchema('ws'),
  hostId: characterIdSchema,
  pluginId: text.max(128),
  hostSessionRef: text.max(256),
  characterIds: z.array(characterIdSchema).min(1).max(64),
  allowedProjectKeys: z.array(usageKeySchema).max(64),
  allowedContextKeys: z.array(usageKeySchema).max(64),
  actions: connectionActionsSchema,
  isolation: z.enum(['strict', 'relaxed']),
  status: z.enum(['active', 'revoked']),
  createdAt: utcSchema,
  expiresAt: utcSchema,
  credentialDigest: digestSchema,
})
export const hostEvidenceSchema = z.strictObject({
  schemaVersion,
  id: idSchema('evd'),
  connectionId: idSchema('conn'),
  hostSessionRef: text.max(256),
  hostId: characterIdSchema,
  hostVersion: text.max(128),
  pluginVersion: text.max(128),
  verifierVersion: text.max(128),
  hostBinaryDigest: digestSchema.optional(),
  configurationDigest: digestSchema,
  globalMemoryRead: z.enum(['disabled', 'enabled', 'unknown']),
  globalMemoryWrite: z.enum(['disabled', 'enabled', 'unknown']),
  contextInjection: z.enum(['tool-result', 'native', 'unsupported', 'unknown']),
  contextRemoval: z.enum(['supported', 'unsupported', 'unknown']),
  fileBoundary: z.enum(['enforced', 'host-controlled', 'unknown']),
  providerRetention: z.enum(['configured', 'unknown']),
  result: z.enum(['pass', 'fail', 'unverified']),
  checkedAt: utcSchema,
  validUntil: utcSchema,
})
export const bindingSchema = z.strictObject({
  schemaVersion,
  id: idSchema('bind'),
  revision: revisionSchema,
  workspaceId: idSchema('ws'),
  connectionId: idSchema('conn'),
  grantRevision: revisionSchema,
  serviceGeneration: z.uuid(),
  hostSessionRef: text.max(256),
  character: z.strictObject({
    id: characterIdSchema,
    version: semver,
    digest: digestSchema,
  }),
  scope: usageScopeSchema,
  actions: connectionActionsSchema,
  evidenceId: idSchema('evd'),
  isolationEffective: z.enum(['strict', 'relaxed']),
  status: z.enum(['active', 'closed', 'revoked', 'expired', 'interrupted']),
  createdAt: utcSchema,
  expiresAt: utcSchema,
})
export const contextDeliverySchema = z.strictObject({
  schemaVersion,
  id: idSchema('snap'),
  bindingId: idSchema('bind'),
  characterDigest: digestSchema,
  policyDigest: digestSchema,
  createdAt: utcSchema,
  entries: z.array(
    z.strictObject({
      ref: relativePathSchema,
      kind: z.enum([
        'persona',
        'voice',
        'relationship',
        'mode',
        'context',
        'memory',
      ]),
      revision: revisionSchema.optional(),
      digest: digestSchema,
      utf8Bytes: z.number().int().nonnegative(),
      reason: text,
      text: z.string(),
    }),
  ),
  excluded: z.array(z.strictObject({ ref: relativePathSchema, reason: text })),
  contentDigest: digestSchema,
  totalUtf8Bytes: z.number().int().nonnegative(),
})
export const hostExcerptSourceSchema = z.strictObject({
  type: z.literal('host-excerpt'),
  connectionId: idSchema('conn'),
  bindingId: idSchema('bind'),
  hostSessionRef: text.max(256),
  hostMessageRef: text.max(256).optional(),
  excerptRef: relativePathSchema,
  digest: digestSchema,
  capturedAt: utcSchema,
  suppliedBy: z.literal('host-plugin'),
})
export const memoryV2Schema = memorySchema.extend({
  schemaVersion: z.literal(2),
  workspaceId: idSchema('ws'),
  scope: usageScopeSchema,
  factReview: z
    .strictObject({
      actor: z.literal('user'),
      at: utcSchema,
      basis: text.max(2048),
    })
    .optional(),
  sources: z
    .array(
      z.union([memorySchema.shape.sources.element, hostExcerptSourceSchema]),
    )
    .min(1),
})
const boundedText = (max: number) =>
  z
    .string()
    .min(1)
    .refine(
      (value) =>
        value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= max,
    )
export const memoryCandidateSchema = z.strictObject({
  kind: memoryKindSchema,
  content: boundedText(4096),
  tags: z.array(boundedText(64)).max(16),
  scope: z.strictObject({ projectKey: usageKeySchema.optional() }),
  excerpt: boundedText(8192),
  hostMessageRef: z.string().min(1).max(256).optional(),
  replaces: idSchema('mem').optional(),
})
export const sharedContextSchema = z.strictObject({
  schemaVersion,
  workspaceId: idSchema('ws'),
  key: usageKeySchema,
  revision: revisionSchema,
  status: z.enum(['active', 'revoked']),
  objectRef: relativePathSchema,
  digest: digestSchema,
  approvedBy: z.literal('user'),
  approvedAt: utcSchema,
})
export const memorySearchResultSchema = z.strictObject({
  delivery: contextDeliverySchema,
  matches: z
    .array(
      z.strictObject({
        id: idSchema('mem'),
        revision: revisionSchema,
        kind: memoryKindSchema,
        content: z.string(),
        tags: z.array(z.string()),
        score: z.number().int().nonnegative(),
        reason: z.string(),
      }),
    )
    .max(20),
})
export const serviceConfigSchema = z.strictObject({
  schemaVersion,
  revision: revisionSchema,
  workspaceId: idSchema('ws'),
  enabled: z.boolean(),
  protocolVersion: z.literal(1),
  bindingTtlSeconds: z.number().int().min(1).max(3600),
  defaultIsolation: z.literal('strict'),
  memoryWrite: z.literal('confirm'),
  contextBudgetBytes: z.number().int().min(1024).max(262144),
})
export const accessEventSchema = z.strictObject({
  schemaVersion,
  id: idSchema('acc'),
  workspaceId: idSchema('ws'),
  at: utcSchema,
  actor: z.enum(['admin', 'agent', 'service']),
  operation: text.max(128),
  connectionId: idSchema('conn').optional(),
  bindingId: idSchema('bind').optional(),
  outcome: z.enum(['success', 'denied']),
  memoryId: idSchema('mem').optional(),
  snapshotId: idSchema('snap').optional(),
  code: errorCodeSchema.optional(),
})
export const migrationManifestSchema = z.strictObject({
  schemaVersion,
  revision: revisionSchema,
  workspaceId: idSchema('ws'),
  target: z.literal('service-v1'),
  status: z.enum(['applied', 'rolled-back']),
  createdAt: utcSchema,
  memories: z.array(
    z.strictObject({
      ref: relativePathSchema,
      backupRef: relativePathSchema,
      before: digestSchema,
      after: digestSchema,
    }),
  ),
})

export const serviceDescriptorSchema = z.strictObject({
  schemaVersion,
  protocolVersion: z.literal(1),
  workspaceId: idSchema('ws'),
  generation: z.uuid(),
  pid: z.number().int().positive(),
  host: z.string().min(1).max(256),
  port: z.number().int().min(1).max(65535),
  adminCredentialRef: z
    .string()
    .regex(/^\.runtime\/service\/admin-[0-9a-f-]{36}\.token$/),
})

export const schemas = {
  'shared-context': sharedContextSchema,
  'memory-search-result': memorySearchResultSchema,
  'service-descriptor': serviceDescriptorSchema,
  'connection-grant': connectionGrantSchema,
  binding: bindingSchema,
  'host-evidence': hostEvidenceSchema,
  'context-delivery': contextDeliverySchema,
  'memory-v2': memoryV2Schema,
  'host-excerpt-source': hostExcerptSourceSchema,
  'service-config': serviceConfigSchema,
  'access-event': accessEventSchema,
  'migration-manifest': migrationManifestSchema,
  character: characterManifestSchema,
  workspace: workspaceSchema,
  'characters-lock': charactersLockSchema,
  work: workSchema,
  source: sourceSchema,
  session: sessionSchema,
  run: runSchema,
  message: messageSchema,
  memory: memorySchema,
  'context-snapshot': contextSnapshotSchema,
  proposal: proposalSchema,
  'adapter-capabilities': adapterCapabilitiesSchema,
  'execution-request': executionRequestSchema,
  'adapter-event': adapterEventSchema,
  'write-lock': writeLockSchema,
  transaction: transactionSchema,
  receipt: receiptSchema,
  'revision-manifest': revisionManifestSchema,
  'codex-reply': codexReplySchema,
} as const

export function schemaDocuments() {
  return Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [
      `${name}.schema.json`,
      { ...z.toJSONSchema(schema, { target: 'draft-2020-12' }), title: name },
    ]),
  )
}

export type CharacterManifest = z.infer<typeof characterManifestSchema>
export type WorkspaceConfig = z.infer<typeof workspaceSchema>
export type InstalledCharacter = z.infer<typeof installedCharacterSchema>
export type CharactersLock = z.infer<typeof charactersLockSchema>
export type WorkRecord = z.infer<typeof workSchema>
export type SourceRecord = z.infer<typeof sourceSchema>
export type SessionRecord = z.infer<typeof sessionSchema>
export type RunRecord = z.infer<typeof runSchema>
export type MessageRecord = z.infer<typeof messageSchema>
export type MemoryRecord = z.infer<typeof memorySchema>
export type ContextSnapshot = z.infer<typeof contextSnapshotSchema>
export type ProposalRecord = z.infer<typeof proposalSchema>
export type AdapterCapabilities = z.infer<typeof adapterCapabilitiesSchema>
export type ExecutionRequest = z.infer<typeof executionRequestSchema>
export type AdapterEvent = z.infer<typeof adapterEventSchema>
export type ErrorCode = z.infer<typeof errorCodeSchema>
export type TransactionRecord = z.infer<typeof transactionSchema>
export type ConnectionGrant = z.infer<typeof connectionGrantSchema>
export type BindingRecord = z.infer<typeof bindingSchema>
export type HostEvidence = z.infer<typeof hostEvidenceSchema>
export type ServiceConfig = z.infer<typeof serviceConfigSchema>
