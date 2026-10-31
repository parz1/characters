import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { z } from 'zod'
import { failure, CharactersError } from '@characters/core'
import { mcpOperations } from '@characters/protocol'
import { connectDshSession, dshConfigSchema } from './bridge.js'
import type { DshBridge, DshSession } from './bridge.js'
import { installCharacterContext } from './prompt.js'

export const name = 'characters'
export const inject = ['tools', 'systemPrompt', 'workingDirectory']
function sessionOf(ctx: Context, agent?: Agent): DshSession {
  if (!agent || typeof agent.id !== 'string')
    throw new CharactersError(
      'PERMISSION_DENIED',
      '工具需要原生 dsh 会话与项目目录。',
      '在 blog 的原生会话中调用；模型参数不能指定会话。',
    )
  return { id: agent.id, cwd: ctx.workingDirectory.get(agent.session) }
}

/** Global installation is generic; role state and prompt contribution remain session-bound. */
export function apply(ctx: Context, config: unknown = {}) {
  const bridges = new Map<string, Promise<DshBridge>>()
  const configured = dshConfigSchema.safeParse(config)
  const getBridge = (session: DshSession) => {
    if (!configured.success)
      throw new CharactersError(
        'PERMISSION_DENIED',
        '尚未配置本会话的管理端配对。',
        '先调用 characters_status，交由用户在 characters 管理端授权配对；插件不能自行授权。',
      )
    let bridge = bridges.get(session.id)
    bridge ??= connectDshSession(configured.data, session).catch(
      (error: unknown) => {
        bridges.delete(session.id)
        throw error
      },
    )
    bridges.set(session.id, bridge)
    return bridge
  }
  ctx.tools.register(
    defineTool({
      name: 'characters_status',
      description:
        'Show the native dsh session ID for explicit human management pairing. Does not load role content or certify memory isolation.',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [
          { type: 'text', text: JSON.stringify(value) },
        ],
      },
      async execute(_args, exec) {
        try {
          const session = sessionOf(ctx, exec.agent)
          const bridge = bridges.get(session.id)
          const status = bridge ? (await bridge).status() : undefined
          return {
            nativeSessionId: session.id,
            configured: configured.success,
            ...(status?.pairedSession === session.id
              ? status
              : { strictHostPolicyVerified: false }),
          }
        } catch (error) {
          return z.json().parse(failure(error))
        }
      },
    }),
  )
  for (const [toolName, operation] of Object.entries(mcpOperations)) {
    ctx.tools.register(
      defineTool({
        name: toolName,
        description: `${operation} via characters. Explicit user-requested role loading only. bindings_open requires scope.projectKey=blog (or configured key) and contextKeys=[]. Memory proposals require human management review. Do not change host or project plugins/configuration.`,
        parameters: {
          requestId: { type: 'string', required: true },
          params: { type: 'json', required: true },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [
            { type: 'text', text: JSON.stringify(value) },
          ],
        },
        async execute(args, exec) {
          try {
            const session = sessionOf(ctx, exec.agent)
            const data = await (
              await getBridge(session)
            ).invoke(session, {
              protocolVersion: 1,
              operation,
              ...args,
            })
            return z.json().parse({ ok: true, data, error: null })
          } catch (error) {
            return z.json().parse(failure(error))
          }
        },
      }),
    )
  }
  installCharacterContext(
    ctx,
    (session) => bridges.get(session.id),
    (context) => (context.agent ? sessionOf(ctx, context.agent) : undefined),
  )
  ctx.on('agent/disposed', ({ agent }) => {
    const bridge = bridges.get(agent.id)
    if (bridge)
      void bridge
        .then((current) =>
          current.owns(agent.id)
            ? current.close(sessionOf(ctx, agent))
            : undefined,
        )
        .catch(() => undefined)
  })
  ctx.effect(() => async () => {
    if (!configured.success) return
    await Promise.allSettled(
      [...bridges.values()].map(async (bridge) => {
        const current = await bridge
        await current.close({
          id: current.status().pairedSession,
          cwd: configured.data.projectRoot,
        })
      }),
    )
  })
}
