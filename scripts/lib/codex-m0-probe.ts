import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isolatedEnvironment, resolveCodex } from '@characters/adapters'
import { codexRpc, object } from './codex-rpc.ts'
import type { JsonObject } from './codex-rpc.ts'

const pluginId = 'characters-m0@characters-m0-lab'
const roleMarker = 'M0_ROLE_CONTEXT_CANARY'
const memoryMarker = 'M0_BASELINE_MEMORY_CANARY'
const fixture = fileURLToPath(
  new URL('../../tests/fixtures/codex-m0-mcp.mjs', import.meta.url),
)

function hash(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

async function cleanup(root: string) {
  if (
    path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) ||
    !path.basename(root).startsWith('characters-codex-m0-')
  )
    throw new Error('Unsafe M0 cleanup target')
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 100,
  })
}

function lastUser(request: JsonObject): string {
  const input = Array.isArray(request.input) ? request.input : []
  const users = input.filter(
    (item) => item && typeof item === 'object' && item.role === 'user',
  )
  return JSON.stringify(users.at(-1) ?? '')
}

function hasTool(request: JsonObject, namespace: string): boolean {
  return JSON.stringify(request.tools ?? []).includes(`mcp__${namespace}`)
}

function command(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  const result = spawnSync(executable, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    shell: false,
  })
  if (result.status !== 0) throw new Error('M0 local command failed')
  return result.stdout.trim()
}

export interface CodexM0Report {
  reportVersion: 1
  method: 'codex-host-local-lab-v1'
  checkedAt: string
  hostVersion: string
  hostBinaryDigest: string
  scope: 'isolated-app-server-not-existing-tui-or-desktop'
  realCredentialsUsed: false
  realModelUsed: false
  schema: {
    threadMetadataAvailable: boolean
    threadMemoryModeAvailable: boolean
    disabledPluginIdsWarning: string
  }
  checks: {
    compatibilityPluginLoaded: boolean
    portableManifestRecognized: boolean
    perThreadPluginSelection: boolean
    mcpCallCarriesThreadId: boolean
    threadMetadataIsNotToolArgument: boolean
    roleToolResultReachesModelInput: boolean
    activeThreadMemoryReadDisabled: boolean
    baselineThreadMemoryReadPreserved: boolean
    memoryGenerationEligibilityIsThreadScoped: boolean
    memoryModeAloneStopsReading: boolean
    disabledPluginIdsActuallyRemovesTools: boolean
    disabledPluginBlocksDirectCall: boolean
    reenabledPluginRestoresTools: boolean
    otherActivePluginSessionUnaffected: boolean
    closedThreadStillContainsDeliveredContext: boolean
    otherSessionUnaffected: boolean
    lifecycleDoesNotWriteSharedConfig: boolean
    memoryFileUnchanged: boolean
  }
  limitations: string[]
  strictPluginReady: false
  cleanup: boolean
}

// Controlled host experiment, not production isolation evidence. It creates its
// own Codex home and app-server, uses artificial markers, and never reads auth.
export async function probeCodexHost(
  explicit?: string,
): Promise<CodexM0Report> {
  const executable = await resolveCodex(explicit)
  const root = await mkdtemp(path.join(tmpdir(), 'characters-codex-m0-'))
  const work = path.join(root, 'work')
  const home = path.join(root, 'home')
  const market = path.join(root, 'market')
  const plugin = path.join(market, 'plugin')
  const log = path.join(root, 'mcp.jsonl')
  const captured: JsonObject[] = []
  const requestsByTag = (tag: string) =>
    captured.filter((request) => lastUser(request).includes(tag))
  let fixtureFailure = false
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString()
      if (Buffer.byteLength(body) > 2 * 1024 * 1024) request.destroy()
    })
    request.on('end', () => {
      try {
        if (!request.url?.endsWith('/responses')) {
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.end('{"data":[]}')
          return
        }
        const value = object(JSON.parse(body))
        captured.push(value)
        const user = lastUser(value)
        const tag = ['M0_FETCH_A', 'M0_FETCH_C'].find((item) =>
          user.includes(item),
        )
        const callId = `call_${tag ?? 'none'}`
        const call =
          tag && !JSON.stringify(value.input).includes(`"call_id":"${callId}"`)
        const item = call
          ? {
              id: `fc_${captured.length}`,
              type: 'function_call',
              call_id: callId,
              namespace: 'mcp__probe',
              name: 'context_get',
              arguments: '{}',
              status: 'completed',
            }
          : {
              id: `msg_${captured.length}`,
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [
                {
                  type: 'output_text',
                  text: 'M0 neutral reply',
                  annotations: [],
                },
              ],
            }
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const send = (event: unknown) =>
          response.write(`data: ${JSON.stringify(event)}\n\n`)
        send({
          type: 'response.created',
          response: {
            id: `resp_${captured.length}`,
            status: 'in_progress',
            output: [],
          },
        })
        send({
          type: 'response.output_item.added',
          output_index: 0,
          item: { ...item, status: 'in_progress' },
        })
        if (!call)
          send({
            type: 'response.output_text.delta',
            output_index: 0,
            content_index: 0,
            item_id: item.id,
            delta: 'M0 neutral reply',
          })
        send({ type: 'response.output_item.done', output_index: 0, item })
        send({
          type: 'response.completed',
          response: {
            id: `resp_${captured.length}`,
            status: 'completed',
            output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        })
        response.end()
      } catch {
        fixtureFailure = true
        response.writeHead(500)
        response.end()
      }
    })
  })
  let rpc: ReturnType<typeof codexRpc> | undefined
  try {
    for (const dir of [
      'home',
      'work',
      'profile',
      'appdata',
      'localdata',
      'tmp',
      'protocol',
      'market/plugin/.codex-plugin',
      'market/.agents/plugins',
      'home/memories',
    ])
      await mkdir(path.join(root, dir), { recursive: true })
    const env = isolatedEnvironment(root)
    // Never inherit proxies pointing outside the laboratory.
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY'])
      delete env[key]
    const version = command(executable, ['--version'], work, env)
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(executable)) digest.update(chunk)
    command(
      executable,
      [
        'app-server',
        'generate-json-schema',
        '--experimental',
        '--out',
        path.join(root, 'protocol'),
      ],
      work,
      env,
    )
    const startSchema = object(
      JSON.parse(
        await readFile(
          path.join(root, 'protocol/v2/ThreadStartResponse.json'),
          'utf8',
        ),
      ),
    )
    const disabled = object(object(startSchema.properties).disabledPluginIds)
    const warning = String(disabled.description ?? '')
    const memorySchema = object(
      JSON.parse(
        await readFile(
          path.join(root, 'protocol/v2/ThreadMemoryModeSetParams.json'),
          'utf8',
        ),
      ),
    )
    const callSchema = object(
      JSON.parse(
        await readFile(
          path.join(root, 'protocol/v2/McpServerToolCallParams.json'),
          'utf8',
        ),
      ),
    )
    await writeFile(log, '')
    const mcp = {
      mcpServers: {
        probe: {
          command: process.execPath,
          args: [fixture],
          env: { M0_MCP_LOG: log },
        },
      },
    }
    // Probe the portable entry point independently before adding compatibility.
    await writeFile(
      path.join(plugin, 'plugin.json'),
      JSON.stringify({
        name: 'characters-m0',
        version: '0.0.2',
        description: 'M0 portable fixture',
      }),
    )
    await writeFile(
      path.join(plugin, 'mcp.json'),
      JSON.stringify({
        mcpServers: { probe: { ...mcp.mcpServers.probe, type: 'stdio' } },
      }),
    )
    const catalog = path.join(market, '.agents/plugins/marketplace.json')
    await writeFile(
      catalog,
      JSON.stringify({
        name: 'characters-m0-lab',
        plugins: [
          {
            name: 'characters-m0',
            source: { source: 'local', path: './plugin' },
            policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
            category: 'Productivity',
          },
        ],
      }),
    )
    const memoryFile = path.join(home, 'memories/memory_summary.md')
    await writeFile(memoryFile, memoryMarker)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('M0 listen failed')
    const overrides = {
      model: 'characters-probe',
      model_provider: 'm0',
      'model_providers.m0.name': 'M0 local capture',
      'model_providers.m0.base_url': `http://127.0.0.1:${address.port}/v1`,
      'model_providers.m0.wire_api': 'responses',
      'model_providers.m0.requires_openai_auth': false,
      'analytics.enabled': false,
      'features.apps': false,
      'features.skip_host_skill_discovery': true,
      'features.enable_request_compression': false,
      'features.memories': true,
      'memories.use_memories': true,
      'memories.generate_memories': true,
      'memories.disable_on_external_context': false,
      'features.shell_tool': false,
      'features.shell_snapshot': false,
      'features.multi_agent': false,
      'features.goals': false,
      web_search: 'disabled',
    }
    rpc = codexRpc({
      executable,
      cwd: market,
      env,
      args: Object.entries(overrides).flatMap(([key, value]) => [
        '-c',
        `${key}=${JSON.stringify(value)}`,
      ]),
    })
    await rpc.request('initialize', {
      clientInfo: { name: 'characters-m0', version: '0.0.1' },
      capabilities: { experimentalApi: true },
    })
    rpc.notify('initialized')
    const portable = object(
      await rpc.request('plugin/read', {
        marketplacePath: catalog,
        pluginName: 'characters-m0',
      }),
    )
    const portableDetail = object(portable.plugin)
    const portableRecognized =
      object(portableDetail.summary).localVersion === '0.0.2' &&
      JSON.stringify(portableDetail.mcpServers).includes('probe')
    await writeFile(
      path.join(plugin, '.codex-plugin/plugin.json'),
      JSON.stringify({
        name: 'characters-m0',
        version: '0.0.1',
        description: 'M0 compatibility fixture',
        mcpServers: './.mcp.json',
      }),
    )
    await writeFile(path.join(plugin, '.mcp.json'), JSON.stringify(mcp))
    await rpc.request('plugin/install', {
      marketplacePath: catalog,
      pluginName: 'characters-m0',
    })
    // Installation is set-up only, inside the artificial home. Lifecycle tests
    // begin with the plugin disabled in shared config and never write it again.
    const configFile = path.join(home, 'config.toml')
    const baseline = `[plugins."${pluginId}"]\nenabled = false\n`
    await writeFile(configFile, baseline)
    const start = async (config: JsonObject = {}) => {
      const result = object(
        await rpc!.request('thread/start', {
          cwd: market,
          historyMode: 'legacy',
          approvalPolicy: 'never',
          config,
        }),
      )
      return String(object(result.thread).id)
    }
    const tools = async (id: string) =>
      object(await rpc!.request('mcpServerStatus/list', { threadId: id }))
    const hasPlugin = (status: JsonObject) =>
      Array.isArray(status.data) &&
      status.data.some((item: unknown) => object(item).pluginId === pluginId)
    const before = await start()
    const beforeTools = await tools(before)
    const active = await start({
      plugins: { [pluginId]: { enabled: true } },
      memories: { use_memories: false, generate_memories: false },
    })
    const activeTools = await tools(active)
    await rpc.request('thread/memoryMode/set', {
      threadId: active,
      mode: 'disabled',
    })
    const modeOnly = await start({ plugins: { [pluginId]: { enabled: true } } })
    await rpc.request('thread/memoryMode/set', {
      threadId: modeOnly,
      mode: 'disabled',
    })
    const turn = async (
      id: string,
      text: string,
      disabledPluginIds?: string[],
    ) => {
      const result = object(
        await rpc!.request('turn/start', {
          threadId: id,
          input: [{ type: 'text', text, text_elements: [] }],
          ...(disabledPluginIds ? { disabledPluginIds } : {}),
        }),
      )
      const turnId = object(result.turn).id
      const deadline = Date.now() + 15000
      while (
        !rpc!.notifications.some(
          (event) =>
            event.method === 'turn/completed' &&
            object(event.params).threadId === id &&
            object(object(event.params).turn).id === turnId,
        )
      ) {
        if (Date.now() > deadline) throw new Error('M0 turn did not complete')
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
    await turn(active, 'M0_FETCH_A')
    await turn(before, 'M0_BASELINE_BEFORE_CLOSE')
    await turn(modeOnly, 'M0_FETCH_C')
    await rpc.request('thread/settings/update', {
      threadId: active,
      disabledPluginIds: [pluginId],
    })
    await turn(active, 'M0_AFTER_CLOSE', [pluginId])
    let disabledPluginBlocksDirectCall = false
    try {
      const direct = object(
        await rpc.request('mcpServer/tool/call', {
          threadId: active,
          server: 'probe',
          tool: 'context_get',
          arguments: {},
        }),
      )
      disabledPluginBlocksDirectCall = direct.isError === true
    } catch {
      disabledPluginBlocksDirectCall = true
    }
    await rpc.request('thread/settings/update', {
      threadId: active,
      disabledPluginIds: [],
    })
    await turn(active, 'M0_REENABLED')
    await turn(modeOnly, 'M0_OTHER_ACTIVE')
    await turn(before, 'M0_BASELINE_AFTER_CLOSE')
    const afterTools = await tools(before)
    const afterNew = await start()
    const newTools = await tools(afterNew)
    const lines = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => object(JSON.parse(line)))
    const calls = lines.filter((line) => line.method === 'tools/call')
    const actualCallIds = calls.map(
      (line) => object(object(line.params)._meta).threadId,
    )
    const aRequests = requestsByTag('M0_FETCH_A')
    const beforeRequests = requestsByTag('M0_BASELINE_BEFORE_CLOSE')
    const afterRequests = requestsByTag('M0_BASELINE_AFTER_CLOSE')
    const cRequests = requestsByTag('M0_FETCH_C')
    const closedRequests = requestsByTag('M0_AFTER_CLOSE')
    const reenabledRequests = requestsByTag('M0_REENABLED')
    const otherActiveRequests = requestsByTag('M0_OTHER_ACTIVE')
    if (
      fixtureFailure ||
      !aRequests.length ||
      !beforeRequests.length ||
      !afterRequests.length ||
      !cRequests.length ||
      !closedRequests.length ||
      !reenabledRequests.length ||
      !otherActiveRequests.length
    )
      throw new Error('M0 capture incomplete')
    // Read ONLY the database created by this lab, never the user's Codex state.
    const db = new DatabaseSync(path.join(home, 'state_5.sqlite'), {
      readOnly: true,
    })
    let modes: Record<string, unknown>
    try {
      modes = Object.fromEntries(
        db
          .prepare('SELECT id, memory_mode FROM threads WHERE id IN (?, ?, ?)')
          .all(active, before, modeOnly)
          .map((row) => [String(row.id), row.memory_mode]),
      )
    } finally {
      db.close()
    }
    const includes = (rows: JsonObject[], marker: string) =>
      rows.some((row) => JSON.stringify(row.input).includes(marker))
    const bUnaffected =
      !hasPlugin(beforeTools) &&
      !hasPlugin(afterTools) &&
      !hasPlugin(newTools) &&
      [...beforeRequests, ...afterRequests].every(
        (row) => !hasTool(row, 'probe'),
      ) &&
      !includes([...beforeRequests, ...afterRequests], roleMarker) &&
      includes(beforeRequests, memoryMarker) &&
      includes(afterRequests, memoryMarker)
    return {
      reportVersion: 1,
      method: 'codex-host-local-lab-v1',
      checkedAt: new Date().toISOString(),
      hostVersion: version,
      hostBinaryDigest: digest.digest('hex'),
      scope: 'isolated-app-server-not-existing-tui-or-desktop',
      realCredentialsUsed: false,
      realModelUsed: false,
      schema: {
        threadMetadataAvailable: 'threadId' in object(callSchema.properties),
        threadMemoryModeAvailable: 'mode' in object(memorySchema.properties),
        disabledPluginIdsWarning: warning,
      },
      checks: {
        compatibilityPluginLoaded: hasPlugin(activeTools),
        portableManifestRecognized: portableRecognized,
        perThreadPluginSelection: hasPlugin(activeTools) && bUnaffected,
        mcpCallCarriesThreadId:
          actualCallIds.includes(active) && actualCallIds.includes(modeOnly),
        threadMetadataIsNotToolArgument:
          calls.length >= 2 &&
          calls.every(
            (line) =>
              Object.keys(object(object(line.params).arguments)).length === 0,
          ),
        roleToolResultReachesModelInput: includes(aRequests, roleMarker),
        activeThreadMemoryReadDisabled: !includes(aRequests, memoryMarker),
        baselineThreadMemoryReadPreserved:
          includes(beforeRequests, memoryMarker) &&
          includes(afterRequests, memoryMarker),
        memoryGenerationEligibilityIsThreadScoped:
          modes[active] === 'disabled' &&
          modes[modeOnly] === 'disabled' &&
          modes[before] === 'enabled',
        memoryModeAloneStopsReading: !includes(cRequests, memoryMarker),
        disabledPluginIdsActuallyRemovesTools: closedRequests.every(
          (row) => !hasTool(row, 'probe'),
        ),
        disabledPluginBlocksDirectCall,
        reenabledPluginRestoresTools: reenabledRequests.every((row) =>
          hasTool(row, 'probe'),
        ),
        otherActivePluginSessionUnaffected: otherActiveRequests.every((row) =>
          hasTool(row, 'probe'),
        ),
        closedThreadStillContainsDeliveredContext: includes(
          closedRequests,
          roleMarker,
        ),
        otherSessionUnaffected: bUnaffected,
        lifecycleDoesNotWriteSharedConfig:
          hash(await readFile(configFile)) === hash(baseline),
        memoryFileUnchanged:
          (await readFile(memoryFile, 'utf8')) === memoryMarker,
      },
      limitations: [
        'M0 observes an isolated app-server controlled by the lab; it does not establish a stock plugin can control an existing TUI or desktop session.',
        'Thread metadata identifies the host thread only within a trusted connection; it is not an authentication credential or memory-policy attestation.',
        'Database memory_mode is generation-eligibility evidence; no background production memory extraction was run.',
        'A server-side access gate is still required for revoke/stop. Already delivered context remains in host history.',
        'Plugin installation/removal and config/mcpServer/reload are not character lifecycle operations.',
      ],
      strictPluginReady: false,
      cleanup: true,
    }
  } finally {
    await rpc?.close()
    server.closeAllConnections()
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()))
    await cleanup(root)
  }
}
