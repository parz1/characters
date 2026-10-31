import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, mkdir } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as plugin from '@characters/dsh-plugin'
import {
  DshBridge,
  connectDsh,
  connectDshSession,
} from '@characters/dsh-plugin/bridge'
import { installCharacterContext } from '../plugins/dsh/dist/prompt.js'
import {
  initWorkspace,
  migrateService,
  addCharacter,
  bindingSchema,
  memoryV2Schema,
  sha256,
} from '@characters/core'
import { startService, managementRequest } from '@characters/service'
import { pairGateway } from '@characters/mcp'
import { z } from 'zod'
import { temporary, repository, koto } from './helpers.ts'

const execute = promisify(execFile)
const cli = path.join(repository, 'packages/cli/dist/index.js')

test('actual pinned DSH SDK loads plugin and registers only public role operations and diagnostics without model calls', async () => {
  const ctx = new Context()
  const prompt = ctx.plugin(SystemPrompt, {})
  await prompt.await()
  const tools = ctx.plugin(ToolRuntime, {})
  await tools.await()
  class DirectoryFixture extends Service {
    constructor(context: Context) {
      super(context, 'workingDirectory')
    }
    get() {
      return repository
    }
  }
  const directory = ctx.plugin(DirectoryFixture)
  await directory.await()
  const fiber = ctx.plugin(plugin, {})
  try {
    await fiber.await()
    const names = ctx.tools
      .schemas()
      .map((tool) => tool.name)
      .sort()
    assert.deepEqual(names, [
      'bindings_close',
      'bindings_open',
      'characters_list',
      'characters_status',
      'context_get',
      'memory_propose',
      'memory_search',
    ])
    assert.ok(!names.some((name) => /confirm|grant|write_file|exec/.test(name)))
    const assembly = await ctx.systemPrompt.assemble({})
    assert.ok(
      !assembly.sections.some(
        (section) => section.name === 'characters:coauthor',
      ),
    )
  } finally {
    await fiber.dispose()
    await directory.dispose()
    await tools.dispose()
    await prompt.dispose()
  }
})

test('native session bridge rejects session/CWD/authority spoofing and serializes per-session lifecycle', async (t) => {
  const root = await temporary(t)
  const blog = path.join(root, 'blog')
  const other = path.join(root, 'other')
  await mkdir(blog)
  await mkdir(other)
  const workspace = await initWorkspace(path.join(root, 'data'))
  const binding = bindingSchema.parse({
    schemaVersion: 1,
    id: `bind_${randomUUID()}`,
    revision: 1,
    workspaceId: workspace.config.id,
    connectionId: `conn_${randomUUID()}`,
    grantRevision: 1,
    serviceGeneration: randomUUID(),
    hostSessionRef: 'native-a',
    character: { id: 'koto', version: '0.1.0', digest: sha256('synthetic') },
    scope: { purpose: 'blog writing', projectKey: 'blog', contextKeys: [] },
    actions: ['bind', 'context.read'],
    evidenceId: `evd_${randomUUID()}`,
    isolationEffective: 'relaxed',
    status: 'active',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  })
  const calls: string[] = []
  const bridge = new DshBridge(
    {
      workspace: workspace.root,
      pairing: 'unused',
      projectRoot: blog,
      projectKey: 'blog',
    },
    {
      hostId: 'dsh',
      pluginId: 'characters-dsh',
      hostSessionRef: 'native-a',
      request: async (operation) => {
        calls.push(operation)
        return operation === 'bindings.close'
          ? { ...binding, status: 'closed', revision: 2 }
          : binding
      },
    },
  )
  const request = (
    operation = 'bindings.open',
    params: unknown = { characterId: 'koto', scope: binding.scope },
  ) => ({ protocolVersion: 1, requestId: randomUUID(), operation, params })
  await assert.rejects(
    bridge.invoke({ id: 'native-b', cwd: blog }, request()),
    { code: 'PERMISSION_DENIED' },
  )
  await assert.rejects(
    bridge.invoke({ id: 'native-a', cwd: other }, request()),
    { code: 'PERMISSION_DENIED' },
  )
  await assert.rejects(
    bridge.invoke({ id: 'native-a', cwd: blog }, request('memory.confirm', {})),
    { code: 'INVALID_INPUT' },
  )
  await assert.rejects(
    bridge.invoke(
      { id: 'native-a', cwd: blog },
      request('bindings.open', {
        characterId: 'koto',
        scope: { ...binding.scope, projectKey: 'other' },
      }),
    ),
    { code: 'PERMISSION_DENIED' },
  )
  assert.equal(calls.length, 0)
  const session = { id: 'native-a', cwd: blog }
  const opened = await Promise.allSettled([
    bridge.invoke(session, request()),
    bridge.invoke(session, request()),
  ])
  assert.equal(opened.filter((value) => value.status === 'fulfilled').length, 1)
  assert.equal(bridge.owns('native-b'), false)
  await assert.rejects(
    bridge.invoke(
      session,
      request('context.get', { bindingId: `bind_${randomUUID()}` }),
    ),
    { code: 'PERMISSION_DENIED' },
  )
  await bridge.close(session)
  await assert.rejects(bridge.invoke(session, request()), {
    code: 'BINDING_INACTIVE',
  })
})

test('paired DSH transport executes synthetic service memory flow and permanently refuses reuse after role close', async (t) => {
  let service: Awaited<ReturnType<typeof startService>> | undefined
  const root = await temporary(t, async () => {
    await service?.close()
  })
  const blog = path.join(root, 'blog')
  await mkdir(blog)
  const workspace = await initWorkspace(path.join(root, 'data'))
  await migrateService(workspace)
  await addCharacter(workspace, koto)
  service = await startService(workspace)
  const admin = (operation: string, params: unknown = {}) =>
    managementRequest(workspace, operation, params)
  const grant = async (session: string, isolation: 'strict' | 'relaxed') => {
    const result = z.object({ grant: z.object({ id: z.string() }) }).parse(
      await admin('connection.grant', {
        hostId: 'dsh',
        pluginId: 'characters-dsh',
        hostSessionRef: session,
        characterIds: ['koto'],
        allowedProjectKeys: ['blog'],
        allowedContextKeys: [],
        actions: [
          'discover',
          'bind',
          'context.read',
          'memory.search',
          'memory.propose',
        ],
        isolation,
        ttlSeconds: 300,
      }),
    )
    const pairing = await pairGateway(workspace, result.grant.id, session)
    const config = {
      workspace: workspace.root,
      pairing: pairing.pairingRef,
      projectRoot: blog,
      projectKey: 'blog',
    }
    return { bridge: await connectDsh(config), config }
  }
  const native = (id: string) => ({ id, cwd: blog })
  const call = (
    bridge: DshBridge,
    session: string,
    operation: string,
    params: unknown,
  ) =>
    bridge.invoke(native(session), {
      protocolVersion: 1,
      requestId: randomUUID(),
      operation,
      params,
    })
  const open = {
    characterId: 'koto',
    scope: {
      purpose: 'synthetic blog writing',
      projectKey: 'blog',
      contextKeys: [],
    },
  }
  await grant('strict-session', 'strict')
  const discovered = await connectDshSession(
    { workspace: workspace.root, projectRoot: blog },
    native('strict-session'),
  )
  await assert.rejects(
    call(discovered, 'strict-session', 'bindings.open', open),
    { code: 'ISOLATION_UNSUPPORTED' },
  )
  await assert.rejects(
    connectDshSession(
      { workspace: workspace.root, projectRoot: blog },
      native('unpaired-session'),
    ),
    { code: 'PERMISSION_DENIED' },
  )
  await assert.rejects(
    connectDshSession(
      { workspace: workspace.root, projectRoot: blog },
      { id: 'strict-session', cwd: root },
    ),
    { code: 'PERMISSION_DENIED' },
  )
  const a = await grant('session-a', 'relaxed')
  bindingSchema.parse(await call(a.bridge, 'session-a', 'bindings.open', open))
  const context = await a.bridge.context(native('session-a'))
  assert.ok(
    context?.entries.some(
      (entry) => entry.kind === 'mode' && entry.text.includes('合作写作'),
    ),
  )
  const promptContext = new Context()
  const prompt = promptContext.plugin(SystemPrompt, {
    includeRuntimeContext: false,
  })
  await prompt.await()
  const promptAdapter = promptContext.plugin({
    inject: ['systemPrompt'],
    apply(ctx: Context) {
      ctx.systemPrompt.section({
        name: 'test:complete',
        order: 0,
        complete: true,
        text: 'HOST_COMPLETE',
      })
      installCharacterContext(
        ctx,
        () => Promise.resolve(a.bridge),
        () => native('session-a'),
      )
    },
  })
  await promptAdapter.await()
  try {
    const delivered = await promptContext.systemPrompt.assemble({})
    assert.deepEqual(
      delivered.sections.map((entry) => entry.text),
      ['HOST_COMPLETE'],
    )
    assert.ok(
      delivered.contexts.some(
        (entry) =>
          entry.name === 'characters:coauthor' &&
          entry.text.includes('合作写作'),
      ),
    )
    await a.bridge.close(native('session-a'))
    const closed = await promptContext.systemPrompt.assemble({})
    assert.ok(
      closed.contexts.every((entry) => !entry.text.includes('合作写作')),
    )
  } finally {
    await promptAdapter.dispose()
    await prompt.dispose()
  }
  // Use a fresh grant for the remaining memory lifecycle after the prompt-close check.
  const reopened = await grant('session-a-memory', 'relaxed')
  const memorySession = 'session-a-memory'
  const memoryBinding = bindingSchema.parse(
    await call(reopened.bridge, memorySession, 'bindings.open', open),
  )
  const candidate = memoryV2Schema.parse(
    await call(reopened.bridge, memorySession, 'memory.propose', {
      bindingId: memoryBinding.id,
      candidate: {
        kind: 'opinion',
        content: 'DSH_SYNTHETIC_BLOG_MARKER',
        excerpt: 'Synthetic only, not a real blog preference.',
        tags: [],
        scope: { projectKey: 'blog' },
      },
    }),
  )
  const search = {
    bindingId: memoryBinding.id,
    query: 'DSH_SYNTHETIC_BLOG_MARKER',
    limit: 5,
  }
  const results = z.object({ matches: z.array(z.object({ id: z.string() })) })
  assert.equal(
    results.parse(
      await call(reopened.bridge, memorySession, 'memory.search', search),
    ).matches.length,
    0,
  )
  const confirmed = memoryV2Schema.parse(
    await admin('memory.confirm', {
      characterId: 'koto',
      id: candidate.id,
      expectedRevision: 1,
    }),
  )
  const b = await grant('session-b', 'relaxed')
  const bindingB = bindingSchema.parse(
    await call(b.bridge, 'session-b', 'bindings.open', open),
  )
  assert.equal(
    results.parse(
      await call(b.bridge, 'session-b', 'memory.search', {
        ...search,
        bindingId: bindingB.id,
      }),
    ).matches[0]?.id,
    candidate.id,
  )
  await admin('memory.retract', {
    characterId: 'koto',
    id: confirmed.id,
    expectedRevision: confirmed.revision,
  })
  assert.equal(
    results.parse(
      await call(b.bridge, 'session-b', 'memory.search', {
        ...search,
        bindingId: bindingB.id,
      }),
    ).matches.length,
    0,
  )
  await a.bridge.close(native('session-a'))
  const reloaded = await connectDsh(a.config)
  await assert.rejects(call(reloaded, 'session-a', 'bindings.open', open), {
    code: 'BUSY',
  })
  await b.bridge.close(native('session-b'))
  await reopened.bridge.close(native(memorySession))
})

test('DSH prepare builds a standalone native bundle with no workspace protocol dependencies, secrets or role data', async (t) => {
  const root = await temporary(t)
  const output = path.join(root, 'bundle')
  const { stdout } = await execute(
    process.execPath,
    [cli, 'plugin', 'dsh', 'prepare', '--output', output, '--json'],
    { cwd: repository, timeout: 30000 },
  )
  assert.equal(JSON.parse(stdout).data.installed, false)
  const manifest = JSON.parse(
    await readFile(path.join(output, 'package.json'), 'utf8'),
  )
  assert.equal(manifest.engines.dsh, '0.2.1-rc.3')
  assert.doesNotMatch(JSON.stringify(manifest), /workspace:\*|token|koto/)
  const patch = JSON.parse(
    await readFile(path.join(output, 'cordis.patch.yml'), 'utf8'),
  )
  assert.deepEqual(patch[0].insert[0].config, {})
  assert.ok((await readFile(path.join(output, 'index.js'))).length > 1000)
  await assert.rejects(
    execute(process.execPath, [
      cli,
      'plugin',
      'dsh',
      'prepare',
      '--output',
      output,
      '--json',
    ]),
  )
  const doctor = JSON.parse(
    (
      await execute(process.execPath, [
        cli,
        'plugin',
        'dsh',
        'doctor',
        '--json',
      ])
    ).stdout,
  )
  assert.equal(doctor.data.strictReady, false)
  assert.equal(doctor.data.nativeHostInstalled, 'unverified')
})
