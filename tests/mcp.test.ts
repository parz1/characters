import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { addCharacter, initWorkspace, migrateService } from '@characters/core'
import { managementRequest, startService } from '@characters/service'
import { pairGateway, gatewayTools } from '@characters/mcp'
import { temporary, repository, koto } from './helpers.ts'

const execute = promisify(execFile)
const entry = path.join(repository, 'packages/mcp/dist/stdio.js')
const cli = path.join(repository, 'packages/cli/dist/index.js')

test('real MCP SDK client completes synthetic load/propose/review/new session/retract and refuses nonempty path', async (t) => {
  const root = await temporary(t)
  const workspace = path.join(root, 'demo')
  const args = [
    path.join(repository, 'scripts/m3-demo.ts'),
    '--workspace',
    workspace,
    '--transport',
    'mcp',
  ]
  const { stdout } = await execute(process.execPath, args, {
    cwd: repository,
    timeout: 60000,
  })
  const report = JSON.parse(stdout)
  assert.equal(report.ok, true)
  assert.equal(report.transport, 'mcp')
  assert.equal(report.hostIsolationVerified, false)
  assert.equal(report.checks.length, 5)
  assert.equal(report.serviceStoppedOnExit, true)
  const before = await readFile(path.join(workspace, 'workspace.yaml'))
  await assert.rejects(execute(process.execPath, args, { timeout: 30000 }))
  assert.deepEqual(
    await readFile(path.join(workspace, 'workspace.yaml')),
    before,
  )
})

test('paired stdio gateway denies forged threads, tool escalation, stale generations, revoked grants and strict without evidence', async (t) => {
  let service: Awaited<ReturnType<typeof startService>>
  const clients: Client[] = []
  const root = await temporary(t, async () => {
    for (const client of clients) await client.close()
    await service?.close()
  })
  const workspace = await initWorkspace(path.join(root, 'data'))
  await migrateService(workspace)
  await addCharacter(workspace, koto)
  service = await startService(workspace)
  const admin = (op: string, params: unknown = {}) =>
    managementRequest(workspace, op, params)
  const grant = z
    .object({ grant: z.object({ id: z.string() }), credentialRef: z.string() })
    .parse(
      await admin('connection.grant', {
        hostId: 'codex-cli',
        pluginId: 'characters',
        hostSessionRef: 'thread-a',
        characterIds: ['koto'],
        allowedProjectKeys: [],
        allowedContextKeys: [],
        actions: [
          'discover',
          'bind',
          'context.read',
          'memory.search',
          'memory.propose',
        ],
        isolation: 'strict',
        ttlSeconds: 300,
      }),
    )
  await assert.rejects(
    pairGateway(workspace, grant.grant.id, 'other-thread'),
    /配对/,
  )
  const pairing = await pairGateway(workspace, grant.grant.id, 'thread-a')
  const client = new Client({ name: 'cannot-prove-session', version: '1' })
  clients.push(client)
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        entry,
        '--workspace',
        workspace.root,
        '--pairing',
        pairing.pairingRef,
      ],
      stderr: 'pipe',
    }),
  )
  assert.equal((await client.listTools()).tools.length, 6)
  const call = async (
    name: string,
    params: unknown,
    thread: string | undefined = 'thread-a',
    id = randomUUID(),
  ) => {
    const result = await client.callTool({
      name,
      arguments: { requestId: id, params },
      ...(thread ? { _meta: { threadId: thread } } : {}),
    })
    return z
      .object({
        ok: z.boolean(),
        error: z.object({ code: z.string() }).nullable(),
      })
      .passthrough()
      .parse(result.structuredContent)
  }
  assert.equal(
    (await call('characters_list', {}, 'thread-b')).error?.code,
    'PERMISSION_DENIED',
  )
  assert.equal(
    (await call('characters_list', {}, '')).error?.code,
    'PERMISSION_DENIED',
  )
  assert.equal((await call('memory_confirm', {})).error?.code, 'INVALID_INPUT')
  for (const params of [
    { token: 'SECRET_CANARY' },
    { workspace: root },
    { actor: 'user' },
    { protocolVersion: 2 },
  ])
    assert.equal(
      (await call('characters_list', params)).error?.code,
      'INVALID_INPUT',
    )
  assert.equal((await call('characters_list', {})).ok, true)
  const burst = await Promise.all(
    Array.from({ length: 40 }, () => call('characters_list', {})),
  )
  assert.ok(burst.some((result) => result.error?.code === 'BUSY'))
  assert.ok(burst.every((result) => result.ok || result.error?.code === 'BUSY'))
  const duplicate = new Client({ name: 'duplicate', version: '1' })
  clients.push(duplicate)
  await duplicate.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        entry,
        '--workspace',
        workspace.root,
        '--pairing',
        pairing.pairingRef,
      ],
    }),
  )
  const reused = await duplicate.callTool({
    name: 'characters_list',
    arguments: { requestId: randomUUID(), params: {} },
    _meta: { threadId: 'thread-a' },
  })
  assert.match(JSON.stringify(reused.structuredContent), /BUSY/)
  assert.equal(
    (
      await call('bindings_open', {
        characterId: 'koto',
        scope: { purpose: 'test', contextKeys: [] },
      })
    ).error?.code,
    'ISOLATION_UNSUPPORTED',
  )
  await admin('connection.revoke', { id: grant.grant.id, expectedRevision: 1 })
  assert.equal(
    (await call('characters_list', {})).error?.code,
    'PERMISSION_DENIED',
  )
  await service.close()
  service = await startService(workspace)
  assert.equal(
    (await call('characters_list', {})).error?.code,
    'SERVICE_UNAVAILABLE',
  )
  await client.close()
  assert.equal(
    z
      .object({ protocolVersion: z.literal(1) })
      .parse(await admin('service.describe')).protocolVersion,
    1,
  )
})

test('gateway safe retry preserves requestId, rejects changed payload and cross-binding use', async (t) => {
  let service: Awaited<ReturnType<typeof startService>>
  const clients: Client[] = []
  const root = await temporary(t, async () => {
    for (const client of clients) await client.close()
    await service?.close()
  })
  const workspace = await initWorkspace(path.join(root, 'data'))
  await migrateService(workspace)
  await addCharacter(workspace, koto)
  service = await startService(workspace)
  const make = async (session: string) => {
    const grant = z.object({ grant: z.object({ id: z.string() }) }).parse(
      await managementRequest(workspace, 'connection.grant', {
        hostId: 'mock',
        pluginId: 'test',
        hostSessionRef: session,
        characterIds: ['koto'],
        allowedProjectKeys: [],
        allowedContextKeys: [],
        actions: ['discover', 'bind', 'memory.propose'],
        isolation: 'relaxed',
        ttlSeconds: 300,
      }),
    )
    const pairing = await pairGateway(workspace, grant.grant.id, session)
    const client = new Client({ name: 'test', version: '1' })
    clients.push(client)
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          entry,
          '--workspace',
          workspace.root,
          '--pairing',
          pairing.pairingRef,
        ],
      }),
    )
    return async (name: string, params: unknown, requestId = randomUUID()) => {
      const result = await client.callTool({
        name,
        arguments: { requestId, params },
        _meta: { threadId: session },
      })
      return z
        .object({
          ok: z.boolean(),
          data: z.unknown(),
          error: z.object({ code: z.string() }).nullable(),
        })
        .parse(result.structuredContent)
    }
  }
  const a = await make('a'),
    b = await make('b')
  const binding = z.object({ id: z.string() }).parse(
    (
      await a('bindings_open', {
        characterId: 'koto',
        scope: { purpose: 'test', contextKeys: [] },
      })
    ).data,
  )
  const params = {
    bindingId: binding.id,
    candidate: {
      kind: 'preference',
      content: 'SYNTHETIC_RETRY',
      tags: [],
      scope: {},
      excerpt: 'Synthetic only',
    },
  }
  const id = randomUUID()
  const first = await a('memory_propose', params, id)
  assert.equal(first.ok, true)
  assert.deepEqual(await a('memory_propose', params, id), first)
  assert.equal(
    (
      await a(
        'memory_propose',
        { ...params, candidate: { ...params.candidate, content: 'CHANGED' } },
        id,
      )
    ).error?.code,
    'CONFLICT',
  )
  assert.equal(
    (await b('memory_propose', params)).error?.code,
    'PERMISSION_DENIED',
  )
  await service.close()
  assert.equal(
    (await a('memory_propose', params, id)).error?.code,
    'SERVICE_UNAVAILABLE',
  )
})

test('bounded stdio rejects malformed/oversized traffic without leaking input and never stops service', async (t) => {
  let service: Awaited<ReturnType<typeof startService>>
  const root = await temporary(t, async () => {
    await service?.close()
  })
  const workspace = await initWorkspace(path.join(root, 'data'))
  await migrateService(workspace)
  service = await startService(workspace)
  for (const payload of ['{"secret":"SECRET_CANARY"}\n', 'x'.repeat(262145)]) {
    const grant = z.object({ grant: z.object({ id: z.string() }) }).parse(
      await managementRequest(workspace, 'connection.grant', {
        hostId: 'mock',
        pluginId: 'test',
        hostSessionRef: randomUUID(),
        characterIds: ['koto'],
        allowedProjectKeys: [],
        allowedContextKeys: [],
        actions: ['discover'],
        isolation: 'strict',
        ttlSeconds: 300,
      }),
    )
    const grants = z
      .array(z.object({ id: z.string(), hostSessionRef: z.string() }))
      .parse(await managementRequest(workspace, 'connection.list'))
    const session = grants.find((g) => g.id === grant.grant.id)!.hostSessionRef
    const pairing = await pairGateway(workspace, grant.grant.id, session)
    const child = spawn(
      process.execPath,
      [entry, '--workspace', workspace.root, '--pairing', pairing.pairingRef],
      { windowsHide: true },
    )
    let stdout = '',
      stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    const exited = once(child, 'exit')
    child.stdin.on('error', () => undefined)
    child.stdin.end(payload)
    await exited
    assert.equal(stdout, '')
    assert.doesNotMatch(stderr, /SECRET_CANARY/)
    assert.match(stderr, /invalid protocol/)
  }
  await managementRequest(workspace, 'service.describe')
})

test('Codex package prepare is explicit, refuses overwrite, excludes secrets/roles and doctor stays fail-closed', async (t) => {
  const root = await temporary(t)
  const output = path.join(root, 'plugin')
  await assert.rejects(
    execute(process.execPath, [cli, 'plugin', 'codex', 'prepare', '--json']),
  )
  const run = (...args: string[]) =>
    execute(process.execPath, [cli, ...args], { timeout: 30000 })
  const prepared = JSON.parse(
    (await run('plugin', 'codex', 'prepare', '--output', output, '--json'))
      .stdout,
  )
  assert.equal(prepared.data.hostSettingsChanged, false)
  assert.equal(prepared.data.installed, false)
  const manifest = JSON.parse(
    await readFile(path.join(output, '.codex-plugin/plugin.json'), 'utf8'),
  )
  assert.equal(manifest.skills, './skills/')
  const config = await readFile(path.join(output, '.mcp.json'), 'utf8')
  assert.match(config, /EXPLICIT_WORKSPACE/)
  assert.doesNotMatch(config, /admin\.|\.token|koto|D:\\|C:\\/i)
  await writeFile(path.join(output, 'KEEP'), 'unchanged')
  await assert.rejects(
    run('plugin', 'codex', 'prepare', '--output', output, '--json'),
  )
  assert.equal(await readFile(path.join(output, 'KEEP'), 'utf8'), 'unchanged')
  assert.equal((await readdir(output)).length, 5)
  const doctor = JSON.parse(
    (await run('plugin', 'codex', 'doctor', '--json')).stdout,
  )
  assert.equal(doctor.data.strictReady, false)
  assert.equal(doctor.data.checks.memoryGeneration, 'unknown')
  assert.equal(gatewayTools.length, 6)
})
