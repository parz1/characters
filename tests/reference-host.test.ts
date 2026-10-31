import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  addCharacter,
  initWorkspace,
  migrateService,
  memoryV2Schema,
} from '@characters/core'
import { startService, managementRequest } from '@characters/service'
import { ReferenceHost, createAgentRpc } from '@characters/reference-host'
import { isolatedEnvironment } from '@characters/adapters'
import { temporary, repository, koto } from './helpers.ts'

const execute = promisify(execFile)
const cli = path.join(repository, 'packages/cli/dist/index.js')
type Capture = {
  messages: Array<{ role: string; content?: string | null }>
  tools: Array<{ function: { name: string } }>
  stream: boolean
  model: string
  thinking: { type: string }
}

async function modelServer(
  t: TestContext,
  respond: (body: Capture, response: ServerResponse, index: number) => void,
) {
  const captures: Capture[] = []
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/chat/completions')
      assert.equal(
        request.headers.authorization,
        'Bearer SYNTHETIC_DEEPSEEK_KEY',
      )
      let body = ''
      for await (const bytes of request) {
        body += bytes.toString()
        assert.ok(body.length < 262144)
      }
      const data: Capture = JSON.parse(body)
      captures.push(data)
      respond(data, response, captures.length)
    } catch {
      response.writeHead(500)
      response.end('synthetic fixture failure')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return { captures, url: `http://127.0.0.1:${address.port}` }
}
function chunk(
  response: ServerResponse,
  delta: unknown,
  finish: string | null = null,
) {
  response.write(
    `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'synthetic', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
  )
}
function text(
  response: ServerResponse,
  content = '先别急着得意，把验证记录拿来。',
) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  chunk(response, { role: 'assistant' })
  for (const character of content) chunk(response, { content: character })
  chunk(response, {}, 'stop')
  response.end('data: [DONE]\n\n')
}
function tool(
  response: ServerResponse,
  name = 'memory_search',
  args = '{"query":"SYNTHETIC_MARKER","limit":5}',
) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  chunk(response, {
    role: 'assistant',
    tool_calls: [
      {
        index: 0,
        id: `call_${randomUUID()}`,
        type: 'function',
        function: { name, arguments: args.slice(0, 10) },
      },
    ],
  })
  chunk(response, {
    tool_calls: [{ index: 0, function: { arguments: args.slice(10) } }],
  })
  chunk(response, {}, 'tool_calls')
  response.end('data: [DONE]\n\n')
}

async function fixture(t: TestContext, url: string) {
  let service: Awaited<ReturnType<typeof startService>> | undefined
  const hosts = new Map<string, ReferenceHost>()
  const root = await temporary(t, async () => {
    for (const host of hosts.values()) await host.close().catch(() => undefined)
    await service?.close()
  })
  const workspace = await initWorkspace(path.join(root, 'data'))
  await migrateService(workspace)
  await addCharacter(workspace, path.join(repository, 'characters/kurisu'))
  await addCharacter(workspace, koto)
  service = await startService(workspace, {
    verifier: async (grant) => {
      const host = hosts.get(grant.hostSessionRef)
      if (!host?.isAlive()) return undefined
      return {
        assessment: {
          source: 'trusted-host-session',
          hostSessionRef: host.sessionRef,
          subjectSessionRef: host.sessionRef,
          scopedPluginControl: 'verified',
          memoryRead: 'disabled',
          memoryGeneration: 'disabled',
          changesOtherSessions: false,
          requiresSharedConfigWrite: false,
          checkedAt: host.startedAt.toISOString(),
          validUntil: host.validUntil.toISOString(),
        },
        hostVersion: 'synthetic',
        pluginVersion: 'synthetic',
        verifierVersion: 'test-only',
        configurationDigest: host.configurationDigest,
      }
    },
  })
  const admin = (operation: string, params: unknown = {}) =>
    managementRequest(workspace, operation, params)
  const connect = async (characterId = 'kurisu', projectKey?: string) => {
    let rpc: ReturnType<typeof createAgentRpc> | undefined
    const host = new ReferenceHost(
      { apiKey: 'SYNTHETIC_DEEPSEEK_KEY', baseURL: url },
      async (request) => {
        assert.ok(rpc)
        return rpc(request)
      },
    )
    hosts.set(host.sessionRef, host)
    const grant = z
      .object({
        grant: z.object({ id: z.string() }),
        credentialRef: z.string(),
      })
      .parse(
        await admin('connection.grant', {
          hostId: 'reference-host',
          pluginId: 'characters-reference',
          hostSessionRef: host.sessionRef,
          characterIds: [characterId],
          allowedProjectKeys: projectKey ? [projectKey] : [],
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
    rpc = createAgentRpc({
      port: service!.descriptor.port,
      generation: service!.descriptor.generation,
      token: (
        await readFile(path.join(workspace.root, grant.credentialRef), 'utf8')
      ).trim(),
    })
    const binding = await host.open(characterId, {
      purpose: 'synthetic reference test',
      contextKeys: [],
      ...(projectKey ? { projectKey } : {}),
    })
    return { host, grant, binding }
  }
  return { workspace, admin, connect, service }
}

test('reference host uses public HTTP for persona, candidate review, new-session recall and retraction, with role/scope isolation', async (t) => {
  const mock = await modelServer(t, (body, response) => {
    if (body.messages.at(-1)?.role === 'tool')
      text(response, '检索结果已收到。')
    else tool(response)
  })
  const f = await fixture(t, mock.url)
  const a = await f.connect('kurisu', 'demo')
  const candidate = await a.host.remember(
    'SYNTHETIC_MARKER：这是一条合成偏好。',
  )
  assert.equal(candidate.status, 'candidate')
  assert.equal((await a.host.search('SYNTHETIC_MARKER')).matches.length, 0)
  const confirmed = memoryV2Schema.parse(
    await f.admin('memory.confirm', {
      characterId: 'kurisu',
      id: candidate.id,
      expectedRevision: 1,
    }),
  )
  const b = await f.connect('kurisu', 'demo')
  assert.notEqual(a.host.sessionRef, b.host.sessionRef)
  assert.equal(
    (await b.host.search('SYNTHETIC_MARKER')).matches[0]?.id,
    candidate.id,
  )
  assert.equal(
    (await (await f.connect('koto', 'demo')).host.search('SYNTHETIC_MARKER'))
      .matches.length,
    0,
  )
  assert.equal(
    (await (await f.connect('kurisu', 'other')).host.search('SYNTHETIC_MARKER'))
      .matches.length,
    0,
  )
  let shown = ''
  assert.equal(
    await b.host.turn('查一下记忆', (delta) => {
      shown += delta
    }),
    shown,
  )
  assert.equal(shown, '检索结果已收到。')
  assert.match(mock.captures[0]!.messages[0]!.content!, /牧濑红莉栖/)
  assert.match(JSON.stringify(mock.captures[1]!.messages), /SYNTHETIC_MARKER/)
  assert.deepEqual(
    mock.captures[0]!.tools.map((item) => item.function.name),
    ['memory_search'],
  )
  assert.equal(mock.captures[0]!.thinking.type, 'disabled')
  assert.doesNotMatch(
    JSON.stringify(mock.captures),
    /SYNTHETIC_DEEPSEEK_KEY|admin\.|\.token/,
  )
  await f.admin('memory.retract', {
    characterId: 'kurisu',
    id: confirmed.id,
    expectedRevision: confirmed.revision,
  })
  assert.equal((await b.host.search('SYNTHETIC_MARKER')).matches.length, 0)
  await b.host.turn('再查一次', () => undefined)
  // Old retrieval and context snapshots are absent in the next model request.
  assert.doesNotMatch(
    JSON.stringify(mock.captures[2]!.messages),
    /SYNTHETIC_MARKER/,
  )
  await a.host.close()
  await assert.rejects(
    a.host.turn('已关闭', () => undefined),
    { code: 'BINDING_INACTIVE' },
  )
  await f.admin('connection.revoke', {
    id: b.grant.grant.id,
    expectedRevision: 1,
  })
  const before = mock.captures.length
  await assert.rejects(
    b.host.turn('撤销后', () => undefined),
    { code: 'PERMISSION_DENIED' },
  )
  assert.equal(mock.captures.length, before)
})

test('reference client rejects model authority escalation, extra tool fields and infinite tool loops', async (t) => {
  let mode = 'confirm'
  const mock = await modelServer(t, (_, response) => {
    if (mode === 'confirm') tool(response, 'memory_confirm')
    else if (mode === 'extra')
      tool(
        response,
        'memory_search',
        '{"query":"x","limit":5,"bindingId":"forged"}',
      )
    else tool(response)
  })
  const f = await fixture(t, mock.url)
  const { host } = await f.connect()
  await assert.rejects(
    host.turn('确认记忆', () => undefined),
    { code: 'PERMISSION_DENIED' },
  )
  mode = 'extra'
  await assert.rejects(
    host.turn('伪造绑定', () => undefined),
    { code: 'INVALID_INPUT' },
  )
  mode = 'loop'
  const before = mock.captures.length
  await assert.rejects(
    host.turn('一直调用', () => undefined),
    { code: 'CONTEXT_LIMIT' },
  )
  assert.equal(mock.captures.length - before, 4)
  assert.deepEqual(await f.admin('memory.list', { characterId: 'kurisu' }), {
    items: [],
    nextCursor: null,
  })
})

test('provider failures are redacted, never retried, and failed/cancelled turns do not enter history', async (t) => {
  let mode = 'error'
  const mock = await modelServer(t, (_, response) => {
    if (mode === 'error') {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end('{"error":{"message":"SYNTHETIC_SECRET_DO_NOT_ECHO"}}')
    } else if (mode === 'cancel') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      chunk(response, { content: '半份回复' })
    } else text(response, '完成')
  })
  const f = await fixture(t, mock.url)
  const { host } = await f.connect()
  await assert.rejects(
    host.turn('FAILED_MARKER', () => undefined),
    (error: unknown) => {
      assert.doesNotMatch(String(error), /SYNTHETIC_SECRET/)
      return (
        !!error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ADAPTER_FAILED'
      )
    },
  )
  assert.equal(mock.captures.length, 1)
  mode = 'cancel'
  const controller = new AbortController()
  await assert.rejects(
    host.turn('CANCELLED_MARKER', () => controller.abort(), controller.signal),
    { code: 'CANCELLED' },
  )
  mode = 'good'
  await host.turn('正常消息', () => undefined)
  assert.doesNotMatch(
    JSON.stringify(mock.captures.at(-1)!.messages),
    /FAILED_MARKER|CANCELLED_MARKER|半份回复/,
  )
  await f.service!.close()
  const before = mock.captures.length
  await assert.rejects(
    host.turn('服务已停止', () => undefined),
    { code: 'SERVICE_UNAVAILABLE' },
  )
  assert.equal(mock.captures.length, before)
})

function cliProcess(
  root: string,
  workspace: string,
  url: string,
  extra: string[] = [],
) {
  return spawn(
    process.execPath,
    [cli, 'chat', 'kurisu', '--workspace', workspace, ...extra],
    {
      cwd: root,
      env: {
        ...isolatedEnvironment(root),
        DEEPSEEK_API_KEY: 'SYNTHETIC_DEEPSEEK_KEY',
        DEEPSEEK_BASE_URL: url,
      },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
}

test('one-command CLI boots an empty workspace, installs Kurisu, chats in Chinese, proposes, searches, starts fresh and exits cleanly', async (t) => {
  const mock = await modelServer(t, (_, response) => text(response))
  const root = await temporary(t)
  const workspace = path.join(root, 'data')
  const child = cliProcess(root, workspace, mock.url)
  let stdout = '',
    stderr = ''
  child.stdout.on('data', (bytes) => {
    stdout += bytes.toString()
  })
  child.stderr.on('data', (bytes) => {
    stderr += bytes.toString()
  })
  const exited = once(child, 'exit')
  child.stdin.end(
    '你好红莉栖\n/remember SYNTHETIC_CLI_MARKER\n/search SYNTHETIC_CLI_MARKER\n/new\n第二轮\n/exit\n',
  )
  assert.deepEqual(await exited, [0, null], stderr)
  assert.equal(stderr, '')
  assert.match(stdout, /先别急着得意/)
  assert.match(stdout, /候选已提交/)
  assert.match(stdout, /尚未确认为长期记忆/)
  assert.match(stdout, /参考会话已结束/)
  assert.equal(mock.captures.length, 2)
  assert.doesNotMatch(
    JSON.stringify(mock.captures[1]!.messages),
    /你好红莉栖|SYNTHETIC_CLI_MARKER/,
  )
  assert.doesNotMatch(stdout, /SYNTHETIC_DEEPSEEK_KEY/)
  const { openWorkspace } = await import('@characters/core')
  const data = await openWorkspace(workspace)
  const service = await startService(data)
  try {
    const bindings = z
      .array(z.object({ status: z.string(), isolationEffective: z.string() }))
      .parse(await managementRequest(data, 'binding.list'))
    assert.equal(bindings.length, 2)
    assert.ok(
      bindings.every(
        (binding) =>
          binding.status === 'closed' &&
          binding.isolationEffective === 'strict',
      ),
    )
    const grants = z
      .array(z.object({ status: z.string() }))
      .parse(await managementRequest(data, 'connection.list'))
    assert.ok(grants.every((grant) => grant.status === 'revoked'))
    const memories = z
      .object({ items: z.array(z.object({ status: z.string() })) })
      .parse(
        await managementRequest(data, 'memory.list', { characterId: 'kurisu' }),
      )
    assert.equal(memories.items[0]?.status, 'candidate')
  } finally {
    await service.close()
  }
  assert.ok(!(await readdir(root)).includes('.local'))
})

test('CLI refuses implicit legacy migration, invalid options and taking over an existing service', async (t) => {
  const root = await temporary(t)
  const workspace = await initWorkspace(path.join(root, 'data'))
  const invoke = async (extra: string[] = []) => {
    const child = cliProcess(root, workspace.root, 'http://127.0.0.1:1', extra)
    let output = ''
    child.stdout.on('data', (bytes) => {
      output += bytes.toString()
    })
    child.stderr.on('data', (bytes) => {
      output += bytes.toString()
    })
    const exited = once(child, 'exit')
    child.stdin.end('/exit\n')
    return { exit: await exited, output }
  }
  assert.match((await invoke()).output, /迁移/)
  await migrateService(workspace)
  const service = await startService(workspace)
  try {
    assert.notEqual((await invoke()).exit[0], 0)
    await managementRequest(workspace, 'service.describe')
    assert.match(
      (await invoke(['--api-key', 'SYNTHETIC_SECRET'])).output,
      /参数无效/,
    )
  } finally {
    await service.close()
  }
  const { stdout } = await execute(process.execPath, [cli, 'chat', '--help'], {
    cwd: root,
    env: isolatedEnvironment(root),
  })
  assert.match(stdout, /本地参考测试客户端/)
})
