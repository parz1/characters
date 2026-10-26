import { z } from 'zod'
import {
  characterIdSchema,
  idSchema,
  revisionSchema,
  usageScopeSchema,
  bindingSchema,
  contextDeliverySchema,
  memoryV2Schema,
  digestSchema,
  errorCodeSchema,
  memoryCandidateSchema,
  memorySearchResultSchema,
} from '@characters/core'
export { usageScopeSchema } from '@characters/core'

export const protocolVersion = 1 as const
export const candidateInputSchema = memoryCandidateSchema

const envelope = {
  protocolVersion: z.literal(protocolVersion),
  requestId: z.uuid(),
}
const request = <O extends string, S extends z.ZodType>(
  operation: O,
  params: S,
) => z.strictObject({ ...envelope, operation: z.literal(operation), params })

export const agentRequestSchema = z.discriminatedUnion('operation', [
  request('characters.list', z.strictObject({})),
  request(
    'bindings.open',
    z.strictObject({
      characterId: characterIdSchema,
      scope: usageScopeSchema,
    }),
  ),
  request(
    'context.get',
    z.strictObject({
      bindingId: idSchema('bind'),
      mode: z.enum(['conversation', 'coauthor']).optional(),
    }),
  ),
  request(
    'memory.search',
    z.strictObject({
      bindingId: idSchema('bind'),
      query: z.string().trim().min(1).max(512),
      limit: z.number().int().min(1).max(20),
    }),
  ),
  request(
    'memory.propose',
    z.strictObject({
      bindingId: idSchema('bind'),
      candidate: candidateInputSchema,
    }),
  ),
  request(
    'bindings.close',
    z.strictObject({
      bindingId: idSchema('bind'),
      expectedRevision: revisionSchema,
    }),
  ),
])

export const serviceDescribeRequestSchema = request(
  'service.describe',
  z.strictObject({}),
)

export type AgentRequest = z.infer<typeof agentRequestSchema>
export type UsageScope = z.infer<typeof usageScopeSchema>
export type CandidateInput = z.infer<typeof candidateInputSchema>

export const mcpOperations = {
  characters_list: 'characters.list',
  bindings_open: 'bindings.open',
  context_get: 'context.get',
  memory_search: 'memory.search',
  memory_propose: 'memory.propose',
  bindings_close: 'bindings.close',
} as const satisfies Record<string, AgentRequest['operation']>

export function parseAgentRequest(value: unknown): AgentRequest {
  // Check the entire wire value before schema validation; do not print it in errors.
  let bytes: number
  try {
    bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    throw new Error('Invalid protocol request')
  }
  if (bytes > 256 * 1024) throw new Error('Protocol request exceeds 256 KiB')
  const result = agentRequestSchema.safeParse(value)
  if (!result.success) throw new Error('Invalid protocol request')
  return result.data
}

// This is a transport-side admission contract, not a persisted HostEvidence
// record. The eventual service must resolve its source from a trusted registry;
// parsing a model-supplied claim must NEVER create that trust.
export const hostSessionAssessmentSchema = z.strictObject({
  source: z.enum(['trusted-host-session', 'lab-probe', 'self-report']),
  hostSessionRef: z.string().min(1).max(256),
  subjectSessionRef: z.string().min(1).max(256),
  scopedPluginControl: z.enum(['verified', 'unsupported', 'unknown']),
  memoryRead: z.enum(['disabled', 'enabled', 'unknown']),
  memoryGeneration: z.enum(['disabled', 'enabled', 'unknown']),
  changesOtherSessions: z.boolean(),
  requiresSharedConfigWrite: z.boolean(),
  checkedAt: z.iso.datetime(),
  validUntil: z.iso.datetime(),
})
export type HostSessionAssessment = z.infer<typeof hostSessionAssessmentSchema>

export function strictActivationDecision(
  value: unknown,
  now: Date,
):
  | { allowed: true }
  | { allowed: false; code: 'ISOLATION_UNSUPPORTED'; reasons: string[] } {
  const parsed = hostSessionAssessmentSchema.safeParse(value)
  if (!parsed.success || !Number.isFinite(now.getTime()))
    return {
      allowed: false,
      code: 'ISOLATION_UNSUPPORTED',
      reasons: ['invalid-assessment'],
    }
  const a = parsed.data
  const reasons: string[] = []
  if (a.source !== 'trusted-host-session')
    reasons.push('not-current-host-evidence')
  if (a.hostSessionRef !== a.subjectSessionRef) reasons.push('wrong-session')
  if (a.scopedPluginControl !== 'verified')
    reasons.push('no-scoped-plugin-control')
  if (a.memoryRead !== 'disabled') reasons.push('memory-read-not-disabled')
  if (a.memoryGeneration !== 'disabled')
    reasons.push('memory-generation-not-disabled')
  if (a.changesOtherSessions) reasons.push('affects-other-sessions')
  if (a.requiresSharedConfigWrite) reasons.push('requires-shared-config-write')
  const start = Date.parse(a.checkedAt),
    end = Date.parse(a.validUntil)
  if (
    start > now.getTime() ||
    end <= now.getTime() ||
    end <= start ||
    end - start > 60 * 60 * 1000
  )
    reasons.push('invalid-or-expired-evidence')
  return reasons.length
    ? { allowed: false, code: 'ISOLATION_UNSUPPORTED', reasons }
    : { allowed: true }
}

export const serviceDescriptionSchema = z.strictObject({
  protocolVersion: z.literal(1),
  supportedVersions: z.array(z.number().int().positive()).min(1),
  generation: z.uuid(),
  operations: z.array(z.string()).max(64),
  limits: z.strictObject({
    requestBytes: z.number().int().positive().max(262144),
    bindingTtlSeconds: z.number().int().positive().max(3600),
  }),
  strictHostVerifier: z.boolean(),
})
export const protocolErrorSchema = z.strictObject({
  code: errorCodeSchema,
  message: z.string().max(2048),
  nextStep: z.string().max(2048),
})
export const responseEnvelopeSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    protocolVersion: z.literal(1),
    ok: z.literal(true),
    data: z.unknown(),
    error: z.null(),
  }),
  z.strictObject({
    protocolVersion: z.literal(1),
    ok: z.literal(false),
    data: z.null(),
    error: protocolErrorSchema,
  }),
])
export const agentResponseDataSchemas = {
  'characters.list': z.array(
    z.strictObject({
      id: characterIdSchema,
      version: z.string().max(128),
      digest: digestSchema,
    }),
  ),
  'bindings.open': bindingSchema,
  'bindings.close': bindingSchema,
  'context.get': contextDeliverySchema,
  'memory.search': memorySearchResultSchema,
  'memory.propose': memoryV2Schema,
} as const
export function parseProtocolResponse(
  value: unknown,
  operation?: keyof typeof agentResponseDataSchemas,
) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 262144)
    throw new Error('Protocol response exceeds 256 KiB')
  const envelope = responseEnvelopeSchema.parse(value)
  if (envelope.ok && operation)
    agentResponseDataSchemas[operation].parse(envelope.data)
  return envelope
}
export function negotiateVersion(supported: readonly number[]): 1 {
  if (!supported.includes(protocolVersion))
    throw new Error('No common protocol version')
  return protocolVersion
}
