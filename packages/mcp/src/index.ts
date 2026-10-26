import { randomUUID } from 'node:crypto'
import { open, unlink } from 'node:fs/promises'
import { z } from 'zod'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {
  CharactersError,
  connectionGrantSchema,
  containedPath,
  decodeUtf8,
  failure,
  idSchema,
  readBytes,
  readJson,
  workspaceSchema,
  parseYaml,
} from '@characters/core'
import type { WorkspaceHandle } from '@characters/core'
import {
  agentRequestSchema,
  mcpOperations,
  parseAgentRequest,
  parseProtocolResponse,
  serviceDescriptionSchema,
} from '@characters/protocol'
import {
  managementRequest,
  readDescriptor,
  writeGatewayFile,
} from '@characters/service'

export const gatewayPairingSchema = z.strictObject({
  schemaVersion: z.literal(1),
  workspaceId: idSchema('ws'),
  generation: z.uuid(),
  connectionId: idSchema('conn'),
  hostSessionRef: z.string().min(1).max(256),
  hostId: z.string().min(1).max(128),
  pluginId: z.string().min(1).max(128),
})
export const pairingRef = (id: string) =>
  `.runtime/service/gateway-${idSchema('conn').parse(id)}.json`

/** Management-only pairing. A grant and a stdio connection are not host policy evidence. */
export async function pairGateway(
  workspace: WorkspaceHandle,
  connectionId: string,
  hostSessionRef: string,
) {
  idSchema('conn').parse(connectionId)
  const grants = z
    .array(connectionGrantSchema.omit({ credentialDigest: true }))
    .parse(await managementRequest(workspace, 'connection.list'))
  const grant = grants.find((item) => item.id === connectionId)
  if (
    !grant ||
    grant.status !== 'active' ||
    grant.hostSessionRef !== hostSessionRef ||
    Date.parse(grant.expiresAt) <= Date.now()
  )
    throw new CharactersError(
      'PERMISSION_DENIED',
      '授权与显式配对会话不匹配。',
      '为当前会话创建独立授权。',
    )
  const descriptor = await readDescriptor(workspace)
  const pairing = gatewayPairingSchema.parse({
    schemaVersion: 1,
    workspaceId: workspace.config.id,
    generation: descriptor.generation,
    connectionId,
    hostSessionRef,
    hostId: grant.hostId,
    pluginId: grant.pluginId,
  })
  const ref = pairingRef(connectionId)
  await writeGatewayFile(
    workspace,
    ref,
    Buffer.from(`${JSON.stringify(pairing)}\n`),
  )
  return {
    pairingRef: ref,
    generation: pairing.generation,
    connectionId,
    hostSessionRef,
  }
}

/** Read configuration only: the gateway never initializes, migrates or recovers a store. */
export async function gatewayWorkspace(root: string): Promise<WorkspaceHandle> {
  const config = workspaceSchema.parse(
    parseYaml(decodeUtf8(await readBytes(root, 'workspace.yaml', 65536))),
  )
  return { root, config }
}

const toolKeySchema = z.enum(
  Object.keys(mcpOperations) as [
    keyof typeof mcpOperations,
    ...(keyof typeof mcpOperations)[],
  ],
)
const requestOptions = new Map(
  agentRequestSchema.options.map((option) => [
    option.shape.operation.value,
    option,
  ]),
)
const readOnly = new Set(['characters.list', 'context.get', 'memory.search'])
export const gatewayTools = Object.entries(mcpOperations).map(
  ([name, operation]) => {
    const schema = requestOptions.get(operation)!
    return {
      name,
      description: `${operation}; explicitly paired session only. Memory proposals require management review.`,
      inputSchema: z.toJSONSchema(
        schema.pick({ requestId: true, params: true }),
      ),
      annotations: {
        readOnlyHint: readOnly.has(operation),
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
    }
  },
)

export async function connectGateway(workspace: WorkspaceHandle, ref: string) {
  const pairing = await readJson(
    workspace.root,
    ref,
    gatewayPairingSchema,
    4096,
  )
  if (
    ref !== pairingRef(pairing.connectionId) ||
    pairing.workspaceId !== workspace.config.id
  )
    throw new CharactersError(
      'PERMISSION_DENIED',
      '网关配对无效。',
      '在管理端重新配对。',
    )
  const token = decodeUtf8(
    await readBytes(
      workspace.root,
      `.runtime/service/${pairing.connectionId}.token`,
      256,
    ),
  ).trim()
  if (!new RegExp(`^${pairing.connectionId}\\.[0-9a-f]{64}$`).test(token))
    throw new CharactersError(
      'PERMISSION_DENIED',
      '网关必须使用专属 agent 凭证。',
      '重新创建连接授权。',
    )
  const rpc = async (operation: string, params: unknown, requestId: string) => {
    const descriptor = await readDescriptor(workspace)
    if (descriptor.generation !== pairing.generation)
      throw new CharactersError(
        'SERVICE_UNAVAILABLE',
        '服务世代已改变。',
        '重新授权与配对；不会恢复旧绑定。',
      )
    try {
      const response = await fetch(
        `http://127.0.0.1:${descriptor.port}/v1/rpc`,
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'X-Characters-Generation': pairing.generation,
          },
          body: JSON.stringify({
            protocolVersion: 1,
            requestId,
            operation,
            params,
          }),
        },
      )
      if (!response.body) throw new Error('no-response')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > 262144) throw new Error('response-limit')
          chunks.push(chunk.value)
        }
      } finally {
        await reader.cancel().catch(() => undefined)
      }
      const result = parseProtocolResponse(
        JSON.parse(decodeUtf8(Buffer.concat(chunks))),
      )
      if (!result.ok)
        throw new CharactersError(
          result.error.code,
          result.error.message,
          result.error.nextStep,
        )
      return result
    } catch (error) {
      if (error instanceof CharactersError) throw error
      throw new CharactersError(
        'SERVICE_UNAVAILABLE',
        '管理服务响应不可用。',
        '检查服务；重试必须保持 requestId 和参数。',
      )
    }
  }
  const describe = async () => {
    const result = serviceDescriptionSchema.parse(
      (await rpc('service.describe', {}, randomUUID())).data,
    )
    if (
      result.generation !== pairing.generation ||
      !result.supportedVersions.includes(1) ||
      Object.values(mcpOperations).some((op) => !result.operations.includes(op))
    )
      throw new CharactersError(
        'PROTOCOL_UNSUPPORTED',
        '服务版本或操作不兼容。',
        '使用兼容协议版本。',
      )
  }
  await describe()
  // Exclusive claim prevents a second process from reusing this connection's pairing.
  // After a crash require a fresh grant; never guess whether another host session is alive.
  const claimRef = `.runtime/service/gateway-${pairing.connectionId}.lock`
  let ownsClaim = false
  let claiming: Promise<void> | undefined
  const claim = () => {
    claiming ??= (async () => {
      try {
        const handle = await open(
          await containedPath(workspace.root, claimRef),
          'wx',
          0o600,
        )
        ownsClaim = true
        await handle.close()
      } catch {
        throw new CharactersError(
          'BUSY',
          '该网关配对已被使用或未正常释放。',
          '为新 session 创建新授权与配对。',
        )
      }
    })()
    return claiming
  }
  let pending = 0
  let closed = false
  const server = new Server(
    { name: 'characters', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: gatewayTools,
  }))
  server.setRequestHandler(CallToolRequestSchema, async (call) => {
    try {
      if (closed || pending >= 32)
        throw new CharactersError(
          'BUSY',
          '网关正在关闭或请求过多。',
          '稍后重试。',
        )
      pending++
      try {
        // _meta is supplied by the paired local host transport, never by tool arguments.
        // It correlates the session; strict policy still needs the service-side verifier.
        if (call.params._meta?.threadId !== pairing.hostSessionRef)
          throw new CharactersError(
            'PERMISSION_DENIED',
            '宿主线程与配对不匹配。',
            '为本线程建立独立配对；clientInfo 不作为身份。',
          )
        const name = toolKeySchema.safeParse(call.params.name)
        const args = z
          .strictObject({ requestId: z.uuid(), params: z.unknown() })
          .safeParse(call.params.arguments)
        if (!name.success || !args.success)
          throw new CharactersError(
            'INVALID_INPUT',
            '未知工具或参数格式。',
            '使用公布的六种工具及其 schema。',
          )
        let request
        try {
          request = parseAgentRequest({
            protocolVersion: 1,
            operation: mcpOperations[name.data],
            ...args.data,
          })
        } catch {
          throw new CharactersError(
            'INVALID_INPUT',
            '工具参数校验失败。',
            '检查请求格式与大小；不接受路径、凭证或 actor。',
          )
        }
        await describe()
        // Extra discovery processes must not consume another thread's pairing.
        await claim()
        const result = await rpc(
          request.operation,
          request.params,
          request.requestId,
        )
        parseProtocolResponse(result, request.operation)
        const response = {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        }
        if (Buffer.byteLength(JSON.stringify(response)) > 1048576)
          throw new CharactersError(
            'CONTEXT_LIMIT',
            'MCP 响应超过 1 MiB。',
            '缩小检索或上下文范围。',
          )
        return response
      } finally {
        pending--
      }
    } catch (error) {
      const result = { protocolVersion: 1, ...failure(error) }
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      }
    }
  })
  return {
    server,
    async close() {
      if (closed) return
      closed = true
      await server.close()
      // In-flight RPCs retain their own authorization checks; don't release a live claim.
      while (pending) await new Promise((resolve) => setTimeout(resolve, 10))
      if (ownsClaim) await unlink(await containedPath(workspace.root, claimRef))
    },
  }
}
