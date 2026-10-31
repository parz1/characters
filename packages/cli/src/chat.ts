import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { loadEnvFile } from 'node:process'
import { createInterface } from 'node:readline'
import {
  CharactersError,
  characterIdSchema,
  initWorkspace,
  openWorkspace,
  addCharacter,
  listCharacters,
  showCharacter,
  migrateService,
  exists,
  readBytes,
  failure,
} from '@characters/core'
import { managementRequest, startService } from '@characters/service'
import {
  ReferenceHost,
  createAgentRpc,
  deepSeekConfigSchema,
} from '@characters/reference-host'
import { z } from 'zod'
import { workspacePath } from './paths.js'
import type { HostVerifier } from '@characters/service'

const chatHelp = `characters chat CHARACTER [--workspace PATH] [--model MODEL] [--base-url URL] [--project KEY]

本地参考测试客户端，使用 DeepSeek；不依赖 Codex、pi 或 LangGraph。
首次自动初始化应用默认 .local/data、安装内置角色并启用新工作区的服务数据格式。
已有旧工作区需要显式迁移，不覆盖已安装角色。不接管或停止已有管理服务。
DEEPSEEK_API_KEY 可来自环境或应用根目录 .env.local；未配置时交互输入（隐藏且不保存）。
支持 /help、/search 查询、/remember 内容（仅提交候选）、/new、/exit；Ctrl+C 取消并退出。
聊天历史只存在本次进程；长期记忆和审核仍由 characters 服务管理。
`

async function readKey(): Promise<string> {
  if (!process.stdin.isTTY)
    throw new CharactersError(
      'INVALID_INPUT',
      '未配置 DeepSeek API key。',
      '在交互终端运行 chat 后按提示输入，或在应用 .env.local 中配置 DEEPSEEK_API_KEY。',
    )
  process.stdout.write('DeepSeek API key（输入隐藏，仅本次使用，不保存）：')
  const wasRaw = process.stdin.isRaw
  process.stdin.setRawMode(true)
  process.stdin.resume()
  return new Promise((resolve, reject) => {
    let value = ''
    const done = (error?: CharactersError) => {
      process.stdin.off('data', receive)
      process.stdin.setRawMode(wasRaw)
      process.stdin.pause()
      process.stdout.write('\n')
      if (error) reject(error)
      else resolve(value.trim())
    }
    const receive = (chunk: Buffer) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') {
          done(
            new CharactersError(
              'CANCELLED',
              '已取消密钥输入。',
              '需要时重新启动 chat。',
            ),
          )
          return
        }
        if (character === '\r' || character === '\n') {
          done()
          return
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1)
          continue
        }
        if (character >= ' ' && value.length < 4096) value += character
      }
    }
    process.stdin.on('data', receive)
  })
}

export async function runChat(argv: string[]): Promise<boolean> {
  if (argv[0] !== 'chat') return false
  let args
  try {
    args = parseArgs({
      args: argv.slice(1),
      allowPositionals: true,
      strict: true,
      options: {
        workspace: { type: 'string' },
        model: { type: 'string' },
        'base-url': { type: 'string' },
        project: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    })
  } catch {
    throw new CharactersError(
      'INVALID_INPUT',
      'chat 命令参数无效。',
      '使用 chat --help；不接受密钥参数或 --json。',
    )
  }
  if (args.values.help) {
    process.stdout.write(chatHelp)
    return true
  }
  const parsedId = characterIdSchema.safeParse(
    args.positionals.length === 1 ? args.positionals[0] : undefined,
  )
  if (!parsedId.success)
    throw new CharactersError(
      'INVALID_INPUT',
      '需要一个有效角色 ID。',
      '例如 pnpm characters chat kurisu。',
    )
  const id = parsedId.data
  const options = args.values
  const directory = path.resolve(workspacePath(options.workspace))
  const appRoot = fileURLToPath(new URL('../../../', import.meta.url))
  // Resolve only this application's optional env file; never scan HOME or caller CWD.
  if (
    !process.env.DEEPSEEK_API_KEY &&
    (await exists(path.join(appRoot, '.env.local')))
  )
    loadEnvFile(path.join(appRoot, '.env.local'))
  const config = deepSeekConfigSchema.safeParse({
    apiKey: process.env.DEEPSEEK_API_KEY ?? (await readKey()),
    model: options.model ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-flash',
    baseURL:
      options['base-url'] ??
      process.env.DEEPSEEK_BASE_URL ??
      'https://api.deepseek.com',
  })
  if (!config.success)
    throw new CharactersError(
      'INVALID_INPUT',
      'DeepSeek 配置无效。',
      '检查 DEEPSEEK_API_KEY、模型及受信任的 HTTPS 地址。',
    )
  // Management bootstrap uses existing Core public APIs. Conversation code only uses RPC.
  const hasWorkspace = await exists(path.join(directory, 'workspace.yaml'))
  if (
    !hasWorkspace &&
    !(await exists(path.join(appRoot, 'characters', id, 'character.yaml')))
  )
    throw new CharactersError(
      'NOT_FOUND',
      '没有这个内置角色。',
      '先通过 character add 安装自定义角色，或选择 kurisu / koto。',
    )
  const workspace = hasWorkspace
    ? await openWorkspace(directory)
    : await initWorkspace(directory)
  if (!hasWorkspace) await migrateService(workspace)
  if (
    !(await listCharacters(workspace)).some((item) => item.characterId === id)
  )
    await addCharacter(workspace, path.join(appRoot, 'characters', id))
  const character = await showCharacter(workspace, id)
  const scope = {
    purpose: 'local reference character conversation',
    contextKeys: [],
    ...(options.project ? { projectKey: options.project } : {}),
  }
  const live = new Map<string, { host: ReferenceHost; connectionId?: string }>()
  const verifier: HostVerifier = async (grant) => {
    const entry = live.get(grant.hostSessionRef)
    if (
      !entry ||
      !entry.host.isAlive() ||
      entry.connectionId !== grant.id ||
      grant.hostId !== 'reference-host' ||
      grant.pluginId !== 'characters-reference'
    )
      return undefined
    return {
      assessment: {
        source: 'trusted-host-session',
        hostSessionRef: entry.host.sessionRef,
        subjectSessionRef: entry.host.sessionRef,
        scopedPluginControl: 'verified',
        memoryRead: 'disabled',
        memoryGeneration: 'disabled',
        changesOtherSessions: false,
        requiresSharedConfigWrite: false,
        checkedAt: entry.host.startedAt.toISOString(),
        validUntil: entry.host.validUntil.toISOString(),
      },
      hostVersion: 'reference-host-0.1.0',
      pluginVersion: '0.1.0',
      verifierVersion: 'reference-in-process-v1',
      configurationDigest: entry.host.configurationDigest,
    }
  }
  // This command owns only a newly started service. Existing service lease => BUSY.
  // No model execution occurs in packages/service or its verifier.
  const service = await startService(workspace, { verifier })
  let host: ReferenceHost | undefined
  let grantId: string | undefined
  const stop = new AbortController()
  let lines: ReturnType<typeof createInterface> | undefined
  const interrupt = () => {
    stop.abort()
    lines?.close()
  }
  process.once('SIGINT', interrupt)
  const retire = async () => {
    if (!host) return
    const retiring = host
    const connection = grantId
    host = undefined
    grantId = undefined
    try {
      await retiring.close()
    } finally {
      live.delete(retiring.sessionRef)
      if (connection)
        await managementRequest(workspace, 'connection.revoke', {
          id: connection,
          expectedRevision: 1,
        })
    }
  }
  const fresh = async () => {
    let rpc: ReturnType<typeof createAgentRpc> | undefined
    const next = new ReferenceHost(config.data, (request) => {
      if (!rpc)
        throw new CharactersError(
          'PERMISSION_DENIED',
          '参考会话尚未授权。',
          '重新建立会话。',
        )
      return rpc(request)
    })
    host = next
    const entry: { host: ReferenceHost; connectionId?: string } = { host: next }
    live.set(next.sessionRef, entry)
    const grant = z
      .object({
        grant: z.object({ id: z.string() }),
        credentialRef: z.string(),
      })
      .parse(
        await managementRequest(workspace, 'connection.grant', {
          hostId: 'reference-host',
          pluginId: 'characters-reference',
          hostSessionRef: next.sessionRef,
          characterIds: [id],
          allowedProjectKeys: options.project ? [options.project] : [],
          allowedContextKeys: [],
          actions: [
            'discover',
            'bind',
            'context.read',
            'memory.search',
            'memory.propose',
          ],
          isolation: 'strict',
          ttlSeconds: 3600,
        }),
      )
    grantId = grant.grant.id
    entry.connectionId = grant.grant.id
    const token = (await readBytes(workspace.root, grant.credentialRef, 256))
      .toString('utf8')
      .trim()
    rpc = createAgentRpc({
      port: service.descriptor.port,
      generation: service.descriptor.generation,
      token,
    })
    await next.open(id, scope)
    process.stdout.write(
      `\n${character.manifest.name} 已就绪。/help 查看命令，/exit 退出。\n`,
    )
  }
  try {
    await fresh()
    process.stdout.write(
      `工作区：${workspace.root}\n模型：${config.data.model}；聊天历史仅保存在本次进程，长期记忆须人工审核。\n`,
    )
    lines = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      crlfDelay: Infinity,
    })
    lines.on('SIGINT', interrupt)
    const prompt = () => {
      if (!stop.signal.aborted) process.stdout.write('\n你 > ')
    }
    prompt()
    for await (const line of lines) {
      if (stop.signal.aborted) break
      const text = line.trim()
      if (!text) {
        prompt()
        continue
      }
      if (text === '/exit') break
      try {
        if (text === '/help') process.stdout.write(chatHelp)
        else if (text === '/new') {
          await retire()
          await fresh()
        } else if (text.startsWith('/remember ')) {
          const candidate = await host!.remember(
            text.slice('/remember '.length).trim(),
          )
          process.stdout.write(
            `候选已提交：${candidate.id}，revision ${candidate.revision}；尚未确认为长期记忆。\n`,
          )
          process.stdout.write(
            `管理端确认：pnpm characters memory confirm ${candidate.id} --character ${id} --expect-revision ${candidate.revision} --workspace "${workspace.root}"\n`,
          )
        } else if (text.startsWith('/search ')) {
          const result = await host!.search(
            text.slice('/search '.length).trim(),
          )
          process.stdout.write(`${JSON.stringify(result.matches, null, 2)}\n`)
        } else if (text.startsWith('/'))
          process.stdout.write('未知命令，输入 /help 查看。\n')
        else {
          process.stdout.write(`${character.manifest.name} > `)
          await host!.turn(
            text,
            (delta) => process.stdout.write(delta),
            stop.signal,
          )
          process.stdout.write('\n')
        }
      } catch (error) {
        const result = failure(error)
        if (!result.ok)
          process.stderr.write(
            `\n${result.error.message}\n下一步：${result.error.nextStep}\n`,
          )
        if (stop.signal.aborted) break
      }
      prompt()
    }
  } finally {
    lines?.close()
    process.removeListener('SIGINT', interrupt)
    try {
      await retire()
    } finally {
      await service.close()
    }
  }
  process.stdout.write('\n参考会话已结束，绑定已关闭。\n')
  return true
}
