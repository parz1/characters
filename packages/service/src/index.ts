import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { z } from 'zod'
import {
  CharactersError,
  acquireServiceLease,
  containedPath,
  exists,
  failure,
  sha256,
  withStore,
  decodeUtf8,
} from '@characters/core'
import type { WorkspaceHandle } from '@characters/core'
import {
  agentRequestSchema,
  serviceDescribeRequestSchema,
  responseEnvelopeSchema,
  agentResponseDataSchemas,
  serviceDescriptionSchema,
  parseProtocolResponse,
} from '@characters/protocol'
import { ManagementStore, adminRequestSchema } from './store.js'
import type { HostVerifier, Principal, Request } from './store.js'
import {
  descriptorRef,
  descriptorSchema,
  privateToken,
  publishDescriptor,
  readDescriptor,
  removeOwned,
  sameSecret,
  secret,
  secureDirectory,
  writePrivate,
} from './security.js'
export type { HostVerifier, VerifiedHost } from './store.js'
export { descriptorSchema, readDescriptor } from './security.js'
// Management prepares only the constrained gateway pairing path in the private tree.
export async function writeGatewayFile(
  workspace: WorkspaceHandle,
  ref: string,
  bytes: Uint8Array,
) {
  if (!/^\.runtime\/service\/gateway-conn_[0-9a-f-]{36}\.json$/.test(ref))
    throw new CharactersError(
      'INVALID_INPUT',
      '网关配对路径无效。',
      '使用管理端配对入口。',
    )
  await secureDirectory(workspace)
  await writePrivate(workspace, ref, bytes)
}

const LIMIT = 256 * 1024
export async function startService(
  workspace: WorkspaceHandle,
  options: { verifier?: HostVerifier } = {},
) {
  await secureDirectory(workspace)
  const release = await acquireServiceLease(workspace)
  const generation = randomUUID()
  const store = new ManagementStore(workspace, generation, options.verifier)
  const adminToken = `admin.${secret()}`
  const adminCredentialRef = `.runtime/service/admin-${generation}.token`
  let pending = 0
  let queue: Promise<unknown> = Promise.resolve()
  let stopping = false
  let closing: Promise<void> | undefined
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  const server = createServer()
  const serialize = <T>(
    operation: () => Promise<T>,
    reserved = false,
  ): Promise<T> => {
    if (pending >= 64 && !reserved)
      return Promise.reject(
        new CharactersError('BUSY', '管理服务请求队列已满。', '稍后重试。'),
      )
    pending++
    const task = queue.then(operation)
    queue = task
      .catch(() => undefined)
      .finally(() => {
        pending--
      })
    return task
  }
  const close = (): Promise<void> => {
    stopping = true
    closing ??= serialize(async () => {
      stopping = true
      // Retire access before releasing the process lease; no host settings change.
      let fault: unknown
      try {
        await store.interrupt(true)
      } catch (error) {
        fault = error
      }
      try {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
        const descriptor = await readDescriptor(workspace)
        if (descriptor.generation !== generation)
          throw new CharactersError(
            'RECOVERY_REQUIRED',
            '服务描述符所有者发生变化。',
            '保留现场检查。',
          )
        await removeOwned(workspace, descriptorRef)
        await removeOwned(workspace, adminCredentialRef)
      } catch (error) {
        fault ??= error
      }
      try {
        await release()
      } catch (error) {
        fault ??= error
      }
      resolveClosed()
      if (fault) throw fault
    }, true)
    return closing
  }
  try {
    await withStore(workspace, async () => store.config())
    await store.interrupt()
    await writePrivate(
      workspace,
      adminCredentialRef,
      Buffer.from(`${adminToken}\n`),
    )
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('invalid-address')
    const descriptor = descriptorSchema.parse({
      schemaVersion: 1,
      protocolVersion: 1,
      workspaceId: workspace.config.id,
      generation,
      pid: process.pid,
      host: hostname(),
      port: address.port,
      adminCredentialRef,
    })
    server.headersTimeout = 5000
    server.requestTimeout = 10000
    server.keepAliveTimeout = 1000
    server.maxConnections = 64
    server.on('request', async (req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      let principal: Principal | undefined
      let operation = 'invalid-request'
      let shouldStop = false
      try {
        if (
          req.method !== 'POST' ||
          req.url !== '/v1/rpc' ||
          req.headers.host !== `127.0.0.1:${address.port}` ||
          req.headers.origin !== undefined ||
          req.headers['content-type']?.split(';')[0] !== 'application/json'
        )
          throw new CharactersError(
            'PERMISSION_DENIED',
            '请求边界校验失败。',
            '使用本地授权客户端。',
          )
        const auth = req.headers.authorization
        if (!auth?.startsWith('Bearer ') || auth.length > 256)
          throw new CharactersError(
            'PERMISSION_DENIED',
            '缺少有效凭据。',
            '使用授权客户端。',
          )
        const token = auth.slice(7)
        if (
          req.headers['x-characters-generation'] !== undefined &&
          req.headers['x-characters-generation'] !== generation
        )
          throw new CharactersError(
            'SERVICE_UNAVAILABLE',
            '服务世代不匹配。',
            '重新配对当前服务。',
          )
        if (sameSecret(token, adminToken)) principal = { kind: 'admin' }
        else {
          const match = /^(conn_[0-9a-f-]{36})\.[0-9a-f]{64}$/.exec(token)
          if (!match?.[1])
            throw new CharactersError(
              'PERMISSION_DENIED',
              '凭据格式无效。',
              '由管理员重新授权。',
            )
          principal = { kind: 'agent', id: match[1], token }
        }
        let size = 0
        const chunks: Buffer[] = []
        const deadline = setTimeout(() => req.destroy(), 10000)
        try {
          for await (const chunk of req) {
            const bytes = Buffer.from(chunk)
            size += bytes.length
            if (size > LIMIT)
              throw new CharactersError(
                'INVALID_INPUT',
                '请求超过 256 KiB。',
                '缩减请求。',
              )
            chunks.push(bytes)
          }
        } finally {
          clearTimeout(deadline)
        }
        let value: unknown
        try {
          value = JSON.parse(decodeUtf8(Buffer.concat(chunks)))
        } catch {
          throw new CharactersError(
            'INVALID_INPUT',
            '请求不是有效 UTF-8 JSON。',
            '检查协议格式。',
          )
        }
        const parsed = (
          principal.kind === 'admin' ? adminRequestSchema : agentRequestSchema
        ).safeParse(value)
        const describe = serviceDescribeRequestSchema.safeParse(value)
        if (!parsed.success && !describe.success) {
          const version = z
            .object({ protocolVersion: z.number() })
            .safeParse(value)
          throw new CharactersError(
            version.success && version.data.protocolVersion !== 1
              ? 'PROTOCOL_UNSUPPORTED'
              : 'INVALID_INPUT',
            '不支持的协议版本或请求格式。',
            '使用协议版本 1 的已实现操作。',
          )
        }
        const caller = principal
        if (stopping)
          throw new CharactersError(
            'SERVICE_UNAVAILABLE',
            '管理服务正在停止。',
            '等待重新启动。',
          )
        await serialize(async () => {
          if (stopping)
            throw new CharactersError(
              'SERVICE_UNAVAILABLE',
              '管理服务正在停止。',
              '等待服务重新启动。',
            )
          await withStore(workspace, async () => store.authorize(caller))
          await store.expireBindings()
          const send = (data: unknown) => {
            const encoded = JSON.stringify(
              responseEnvelopeSchema.parse({
                protocolVersion: 1,
                ok: true,
                data,
                error: null,
              }),
            )
            if (Buffer.byteLength(encoded) > LIMIT)
              throw new CharactersError(
                'CONTEXT_LIMIT',
                '响应超过 256 KiB。',
                '缩小范围后重试。',
              )
            // Queue includes the return boundary: revoke cannot overtake a delivery.
            res.end(encoded)
          }
          if (describe.success)
            return send(
              serviceDescriptionSchema.parse({
                protocolVersion: 1,
                supportedVersions: [1],
                generation,
                operations: [
                  'characters.list',
                  'bindings.open',
                  'bindings.close',
                  'context.get',
                  'memory.search',
                  'memory.propose',
                ],
                limits: { requestBytes: LIMIT, bindingTtlSeconds: 3600 },
                strictHostVerifier: !!options.verifier,
              }),
            )
          if (!parsed.success) throw new Error('unreachable')
          const request = {
            ...parsed.data,
            requestId: parsed.data.requestId.toLowerCase(),
          } as Request
          operation = request.operation
          let credential: { id: string; digest: string } | undefined
          let credentialRef: string | undefined
          if (
            request.operation === 'connection.grant' &&
            caller.kind === 'admin'
          ) {
            const id = `conn_${request.requestId}`
            credentialRef = `.runtime/service/${id}.token`
            if (
              !(await exists(
                await containedPath(workspace.root, credentialRef),
              ))
            )
              await writePrivate(
                workspace,
                credentialRef,
                Buffer.from(`${id}.${secret()}\n`),
              )
            credential = {
              id,
              digest: sha256(await privateToken(workspace, credentialRef)),
            }
          }
          const result = await store.execute(caller, request, credential)
          if (caller.kind === 'agent')
            agentResponseDataSchemas[
              (request as import('@characters/protocol').AgentRequest).operation
            ].parse(result)
          if (request.operation === 'service.stop') {
            stopping = true
            shouldStop = true
          }
          send(credentialRef ? { grant: result, credentialRef } : result)
        })
        if (shouldStop)
          setImmediate(() => {
            void close().catch(() => {
              server.closeAllConnections()
            })
          })
      } catch (error) {
        const result = failure(error)
        // Persist only fixed operation names and error codes, never request content/secrets.
        if (principal && !stopping && !result.ok) {
          const caller = principal
          const code = result.error.code
          await serialize(() =>
            withStore(workspace, async (tx) =>
              store.audit(
                tx,
                caller.kind,
                operation,
                caller.kind === 'agent' ? caller.id : undefined,
                undefined,
                'denied',
                code,
              ),
            ),
          ).catch(() => undefined)
        }
        res.statusCode =
          !result.ok && result.error.code === 'PERMISSION_DENIED' ? 403 : 400
        res.end(JSON.stringify({ protocolVersion: 1, ...result }))
      }
    })
    await publishDescriptor(workspace, descriptor)
    return { descriptor, closed, close }
  } catch (error) {
    server.closeAllConnections()
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()))
    if (await exists(await containedPath(workspace.root, adminCredentialRef)))
      await removeOwned(workspace, adminCredentialRef)
    await release()
    throw error
  }
}

export async function managementRequest(
  workspace: WorkspaceHandle,
  operation: string,
  params: unknown = {},
  requestId: string = randomUUID(),
  credentialRef?: string,
): Promise<unknown> {
  const descriptor = await readDescriptor(workspace)
  const token = await privateToken(
    workspace,
    credentialRef ?? descriptor.adminCredentialRef,
  )
  let response: Response
  try {
    response = await fetch(`http://127.0.0.1:${descriptor.port}/v1/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId,
        operation,
        params,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    })
  } catch {
    throw new CharactersError(
      'SERVICE_UNAVAILABLE',
      '无法连接管理服务。',
      '检查服务状态或重新启动。',
    )
  }
  const wire: unknown = await response.json()
  const envelope = parseProtocolResponse(wire)
  if (!envelope.ok) {
    throw new CharactersError(
      envelope.error.code,
      envelope.error.message,
      envelope.error.nextStep,
    )
  }
  return envelope.data
}
