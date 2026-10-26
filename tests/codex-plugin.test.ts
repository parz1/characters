import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { initWorkspace, migrateService } from '@characters/core'
import { isolatedEnvironment, resolveCodex } from '@characters/adapters'
import { managementRequest, startService } from '@characters/service'
import { pairGateway } from '@characters/mcp'
import { codexRpc, object } from '../scripts/lib/codex-rpc.ts'
import { temporary, repository } from './helpers.ts'

const execute = promisify(execFile)

test('actual Codex reads prepared plugin and six gateway tools in isolated home; unpaired thread cannot load context', async (t) => {
  let executable: string
  try {
    executable = await resolveCodex()
  } catch {
    t.skip('Codex not installed; no real model/credentials are used')
    return
  }
  let rpc: ReturnType<typeof codexRpc> | undefined
  let service: Awaited<ReturnType<typeof startService>> | undefined
  const root = await temporary(t, async () => {
    await rpc?.close()
    await service?.close()
  })
  for (const ref of [
    'home',
    'profile',
    'appdata',
    'localdata',
    'tmp',
    'market/.agents/plugins',
  ])
    await mkdir(path.join(root, ref), { recursive: true })
  const workspace = await initWorkspace(path.join(root, 'data'))
  await migrateService(workspace)
  service = await startService(workspace)
  const grant = z.object({ grant: z.object({ id: z.string() }) }).parse(
    await managementRequest(workspace, 'connection.grant', {
      hostId: 'codex-cli',
      pluginId: 'characters',
      hostSessionRef: 'synthetic-unpaired-thread',
      characterIds: ['koto'],
      allowedProjectKeys: [],
      allowedContextKeys: [],
      actions: ['discover', 'bind', 'context.read'],
      isolation: 'strict',
      ttlSeconds: 300,
    }),
  )
  const pairing = await pairGateway(
    workspace,
    grant.grant.id,
    'synthetic-unpaired-thread',
  )
  const market = path.join(root, 'market')
  await execute(
    process.execPath,
    [
      path.join(repository, 'packages/cli/dist/index.js'),
      'plugin',
      'codex',
      'prepare',
      '--output',
      path.join(market, 'plugin'),
      '--workspace',
      workspace.root,
      '--pairing',
      pairing.pairingRef,
    ],
    { timeout: 30000 },
  )
  const catalog = path.join(market, '.agents/plugins/marketplace.json')
  await writeFile(
    catalog,
    JSON.stringify({
      name: 'characters-m5-lab',
      plugins: [
        {
          name: 'characters',
          source: { source: 'local', path: './plugin' },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: 'Productivity',
        },
      ],
    }),
  )
  const env = isolatedEnvironment(root)
  for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY']) delete env[key]
  // No turn/model requests. Even an accidental turn has no credentials and only a closed loopback endpoint.
  rpc = codexRpc({
    executable,
    cwd: market,
    env,
    args: Object.entries({
      model: 'characters-no-model',
      model_provider: 'm5',
      'model_providers.m5.name': 'M5 disabled model',
      'model_providers.m5.base_url': 'http://127.0.0.1:1/v1',
      'model_providers.m5.wire_api': 'responses',
      'model_providers.m5.requires_openai_auth': false,
      'analytics.enabled': false,
      'features.apps': false,
      'features.skip_host_skill_discovery': true,
      'features.memories': false,
      'memories.use_memories': false,
      'memories.generate_memories': false,
      'features.shell_tool': false,
      'features.shell_snapshot': false,
      web_search: 'disabled',
    }).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]),
  })
  await rpc.request('initialize', {
    clientInfo: { name: 'characters-m5-test', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  })
  rpc.notify('initialized')
  const detail = object(
    await rpc.request('plugin/read', {
      marketplacePath: catalog,
      pluginName: 'characters',
    }),
  )
  assert.match(JSON.stringify(detail), /characters/)
  await rpc.request('plugin/install', {
    marketplacePath: catalog,
    pluginName: 'characters',
  })
  const config = path.join(root, 'home/config.toml')
  const baseline = '[plugins."characters@characters-m5-lab"]\nenabled = false\n'
  await writeFile(config, baseline)
  const started = object(
    await rpc.request('thread/start', {
      cwd: market,
      historyMode: 'legacy',
      approvalPolicy: 'never',
      config: {
        plugins: { 'characters@characters-m5-lab': { enabled: true } },
        memories: { use_memories: false, generate_memories: false },
      },
    }),
  )
  const threadId = String(object(started.thread).id)
  const status = object(await rpc.request('mcpServerStatus/list', { threadId }))
  const servers = z
    .array(
      z
        .object({
          name: z.string(),
          tools: z.record(z.string(), z.unknown()),
          pluginId: z.string().nullable().optional(),
        })
        .passthrough(),
    )
    .parse(status.data)
  const gateway = servers.find(
    (item) => item.pluginId === 'characters@characters-m5-lab',
  )
  assert.ok(gateway, JSON.stringify(status))
  assert.deepEqual(
    Object.keys(gateway.tools).sort(),
    [
      'bindings_close',
      'bindings_open',
      'characters_list',
      'context_get',
      'memory_propose',
      'memory_search',
    ],
    JSON.stringify(status) + rpc.diagnostics(),
  )
  const call = object(
    await rpc.request('mcpServer/tool/call', {
      threadId,
      server: gateway.name,
      tool: 'characters_list',
      arguments: {
        requestId: '11111111-1111-4111-8111-111111111111',
        params: {},
      },
    }),
  )
  assert.equal(call.isError, true)
  assert.match(JSON.stringify(call), /PERMISSION_DENIED/)
  assert.match(JSON.stringify(detail), /Load an explicitly requested character/)
  assert.equal(await readFile(config, 'utf8'), baseline)
})
