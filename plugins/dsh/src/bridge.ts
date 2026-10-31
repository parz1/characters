import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { open, unlink, readdir } from 'node:fs/promises'
import { z } from 'zod'
import {
  CharactersError,
  bindingSchema,
  contextDeliverySchema,
  directoryRoot,
  usageKeySchema,
  containedPath,
  readJson,
} from '@characters/core'
import {
  parseAgentRequest,
  agentResponseDataSchemas,
} from '@characters/protocol'
import type { AgentRequest } from '@characters/protocol'
import {
  connectPairedAgent,
  gatewayWorkspace,
  gatewayPairingSchema,
} from '@characters/mcp'

export const dshConfigSchema = z.strictObject({
  workspace: z.string().min(1),
  pairing: z.string().min(1).optional(),
  projectRoot: z.string().min(1),
  projectKey: usageKeySchema.default('blog'),
})
export type DshConfig = z.input<typeof dshConfigSchema>
export interface DshSession {
  id: string
  cwd: string
}
export interface DshPeer {
  hostSessionRef: string
  hostId: string
  pluginId: string
  request(
    operation: AgentRequest['operation'],
    params: unknown,
    requestId: string,
  ): Promise<unknown>
}

export async function connectDsh(config: DshConfig) {
  const parsed = dshConfigSchema.parse(config)
  if (!parsed.pairing)
    throw new CharactersError(
      'PERMISSION_DENIED',
      '需要管理端会话配对。',
      '先授权并配对。',
    )
  const workspace = await gatewayWorkspace(path.resolve(parsed.workspace))
  const client = await connectPairedAgent(workspace, parsed.pairing)
  if (
    client.pairing.hostId !== 'dsh' ||
    client.pairing.pluginId !== 'characters-dsh'
  )
    throw new CharactersError(
      'PERMISSION_DENIED',
      '配对不属于 dsh characters 插件。',
      '由管理端创建 dsh / characters-dsh 授权。',
    )
  return new DshBridge(parsed, {
    ...client.pairing,
    request: async (operation, params, requestId) => {
      await client.describe()
      let claim: string | undefined
      if (operation === 'bindings.open') {
        claim = await containedPath(
          workspace.root,
          `.runtime/service/dsh-${client.pairing.connectionId}.used`,
        )
        try {
          const handle = await open(claim, 'wx', 0o600)
          await handle.close()
        } catch {
          throw new CharactersError(
            'BUSY',
            '本 dsh 配对已经使用，不能在重载后恢复角色激活。',
            '新建干净宿主会话，重新授权与配对。',
          )
        }
      }
      try {
        return (await client.rpc(operation, params, requestId)).data
      } catch (error) {
        // Only deterministic pre-admission failures are known not to have opened.
        if (
          claim &&
          error instanceof CharactersError &&
          [
            'ISOLATION_UNSUPPORTED',
            'PERMISSION_DENIED',
            'INVALID_INPUT',
          ].includes(error.code)
        )
          await unlink(claim)
        throw error
      }
    },
  })
}

/** Discover only management-issued pairing metadata for this exact native session. */
export async function connectDshSession(
  config: DshConfig,
  session: DshSession,
) {
  const parsed = dshConfigSchema.parse(config)
  if (
    (await directoryRoot(session.cwd)) !==
    (await directoryRoot(parsed.projectRoot))
  )
    throw new CharactersError(
      'PERMISSION_DENIED',
      '会话项目不匹配。',
      '使用明确选择的项目。',
    )
  if (parsed.pairing) return connectDsh(parsed)
  const workspace = await gatewayWorkspace(path.resolve(parsed.workspace))
  const directory = await containedPath(workspace.root, '.runtime/service')
  const entries = await readdir(directory)
  if (entries.length > 4096)
    throw new CharactersError(
      'BUSY',
      '配对目录超过扫描上限。',
      '由管理端整理失效配对。',
    )
  const matches: string[] = []
  for (const entry of entries) {
    if (!/^gateway-conn_[0-9a-f-]{36}\.json$/.test(entry)) continue
    const ref = `.runtime/service/${entry}`
    const pairing = await readJson(
      workspace.root,
      ref,
      gatewayPairingSchema,
      4096,
    )
    if (
      pairing.workspaceId === workspace.config.id &&
      pairing.hostId === 'dsh' &&
      pairing.pluginId === 'characters-dsh' &&
      pairing.hostSessionRef === session.id
    )
      matches.push(ref)
  }
  if (matches.length !== 1)
    throw new CharactersError(
      'PERMISSION_DENIED',
      '当前原生会话缺少唯一管理端配对。',
      '由管理端为本会话授权并配对；新会话使用独立授权。',
    )
  return connectDsh({ ...parsed, pairing: matches[0] })
}

/** Native host metadata is separate from model arguments; the service still owns policy admission. */
export class DshBridge {
  private binding: z.infer<typeof bindingSchema> | undefined
  private retired = false
  private delivered = false
  private work: Promise<unknown> = Promise.resolve()
  constructor(
    private readonly config: z.infer<typeof dshConfigSchema>,
    private readonly peer: DshPeer,
  ) {}
  private async admit(session: DshSession) {
    const parsed = z
      .strictObject({ id: z.string().min(1).max(256), cwd: z.string().min(1) })
      .safeParse(session)
    if (
      !parsed.success ||
      session.id !== this.peer.hostSessionRef ||
      this.peer.hostId !== 'dsh' ||
      this.peer.pluginId !== 'characters-dsh'
    )
      throw new CharactersError(
        'PERMISSION_DENIED',
        'dsh 原生会话与配对不匹配。',
        '为当前原生会话创建独立授权，不使用 CWD 或模型参数冒充身份。',
      )
    if (
      (await directoryRoot(session.cwd)) !==
      (await directoryRoot(this.config.projectRoot))
    )
      throw new CharactersError(
        'PERMISSION_DENIED',
        '当前会话不在授权的 blog 项目。',
        '在指定项目的新会话中加载角色。',
      )
  }
  owns(sessionId: string) {
    return (
      sessionId === this.peer.hostSessionRef && !!this.binding && !this.retired
    )
  }
  async invoke(session: DshSession, value: unknown) {
    // Serialize lifecycle and injection so close cannot race a pending open/delivery.
    const task = this.work.then(async () => {
      await this.admit(session)
      let request: AgentRequest
      try {
        request = parseAgentRequest(value)
      } catch {
        throw new CharactersError(
          'INVALID_INPUT',
          '角色工具请求无效。',
          '使用公布的六种工具和严格参数；不接受凭证、路径或 actor。',
        )
      }
      if (this.retired)
        throw new CharactersError(
          'BINDING_INACTIVE',
          '本线程已结束角色使用。',
          '角色历史仍保留，请新建 dsh 会话再加载。',
        )
      if (request.operation === 'bindings.open') {
        if (this.binding)
          throw new CharactersError(
            'CONFLICT',
            '本线程已绑定角色。',
            '新建 dsh 会话，不在已有角色历史中切换。',
          )
        if (
          request.params.scope.projectKey !== this.config.projectKey ||
          request.params.scope.contextKeys.length
        )
          throw new CharactersError(
            'PERMISSION_DENIED',
            '角色用途不在本插件的项目范围。',
            '使用配置的逻辑 projectKey，不授权共享背景。',
          )
      } else if (
        'bindingId' in request.params &&
        request.params.bindingId !== this.binding?.id
      )
        throw new CharactersError(
          'PERMISSION_DENIED',
          '绑定不属于本 dsh 会话。',
          '先在本会话显式加载角色。',
        )
      const data = await this.peer.request(
        request.operation,
        request.params,
        request.requestId,
      )
      agentResponseDataSchemas[request.operation].parse(data)
      if (request.operation === 'bindings.open') {
        const binding = bindingSchema.parse(data)
        if (
          binding.hostSessionRef !== session.id ||
          binding.scope.projectKey !== this.config.projectKey
        )
          throw new CharactersError(
            'PERMISSION_DENIED',
            '服务返回了不匹配的绑定。',
            '停止使用并检查配对。',
          )
        this.binding = binding
      }
      if (request.operation === 'context.get') this.delivered = true
      if (request.operation === 'bindings.close') {
        this.binding = undefined
        this.retired = true
      }
      return data
    })
    this.work = task.catch(() => undefined)
    return task
  }
  async context(session: DshSession) {
    const binding = this.binding
    if (!binding || this.retired) return undefined
    return contextDeliverySchema.parse(
      await this.invoke(session, {
        protocolVersion: 1,
        requestId: randomUUID(),
        operation: 'context.get',
        params: { bindingId: binding.id, mode: 'coauthor' },
      }),
    )
  }
  async close(session: DshSession) {
    if (!this.binding || this.retired) return
    const binding = this.binding
    try {
      await this.invoke(session, {
        protocolVersion: 1,
        requestId: randomUUID(),
        operation: 'bindings.close',
        params: { bindingId: binding.id, expectedRevision: binding.revision },
      })
    } finally {
      this.retired = true
      this.binding = undefined
    }
  }
  status() {
    return {
      pairedSession: this.peer.hostSessionRef,
      bindingId: this.binding?.id ?? null,
      closed: this.retired,
      privateContextDelivered: this.delivered,
      strictHostPolicyVerified: false,
      memoryRead: 'unknown',
      memoryGeneration: 'unknown',
      note: '会话配对不等于宿主记忆隔离证明；服务决定 strict 准入。关闭不清除聊天，不能恢复含角色历史线程的宿主记忆生成。',
    }
  }
}
