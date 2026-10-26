import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { mkdir, readFile, writeFile, readdir, cp } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  initWorkspace,
  openWorkspace,
  migrateService,
  addCharacter,
  bindingSchema,
  memoryV2Schema,
  newId,
  sha256,
  readJson,
  connectionGrantSchema,
  withStore,
  jsonBytes,
  workspaceStatus,
} from '@characters/core'
import { managementRequest, startService } from '@characters/service'
import type { HostVerifier } from '@characters/service'
import { parseProtocolResponse, negotiateVersion } from '@characters/protocol'
import { temporary, koto, repository } from './helpers.ts'

const execute = promisify(execFile)
const grantResultSchema = z.object({
  grant: connectionGrantSchema.omit({ credentialDigest: true }),
  credentialRef: z.string(),
})
async function fixture(t: TestContext, verifier?: HostVerifier) {
  const services: Array<Awaited<ReturnType<typeof startService>>> = []
  const root = await temporary(t, async () => {
    for (const service of services.toReversed()) await service.close()
  })
  const workspace = await initWorkspace(path.join(root, 'data'))
  await migrateService(workspace)
  await addCharacter(workspace, koto)
  const service = await startService(workspace, verifier ? { verifier } : {})
  services.push(service)
  const admin = (op: string, params: unknown = {}, id?: string) =>
    managementRequest(workspace, op, params, id)
  const grant = async (session: string, extra: Record<string, unknown> = {}) =>
    grantResultSchema.parse(
      await admin('connection.grant', {
        hostId: 'mock',
        pluginId: 'test',
        hostSessionRef: session,
        characterIds: ['koto'],
        allowedProjectKeys: ['blog'],
        allowedContextKeys: ['people/parz1'],
        actions: ['discover', 'bind', 'context.read'],
        isolation: 'strict',
        ttlSeconds: 3600,
        ...extra,
      }),
    )
  const agent = (
    credentialRef: string,
    op: string,
    params: unknown = {},
    id?: string,
  ) => managementRequest(workspace, op, params, id, credentialRef)
  return { root, workspace, service, admin, grant, agent, services }
}
const verified: HostVerifier = async (grant) => ({
  assessment: {
    source: 'trusted-host-session',
    hostSessionRef: grant.hostSessionRef,
    subjectSessionRef: grant.hostSessionRef,
    scopedPluginControl: 'verified',
    memoryRead: 'disabled',
    memoryGeneration: 'disabled',
    changesOtherSessions: false,
    requiresSharedConfigWrite: false,
    checkedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + 60000).toISOString(),
  },
  hostVersion: 'test-host',
  pluginVersion: 'test-plugin',
  verifierVersion: 'test-only',
  configurationDigest: sha256('test-configuration'),
})
const scope = {
  purpose: 'design',
  projectKey: 'blog',
  contextKeys: ['people/parz1'],
}
const code = (expected: string) => (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === expected

test('service is authenticated, bounded, origin/host guarded and version negotiated', async (t) => {
  const f = await fixture(t)
  assert.equal((await workspaceStatus(f.workspace)).recovery, 'clean')
  const token = (
    await readFile(
      path.join(f.workspace.root, f.service.descriptor.adminCredentialRef),
      'utf8',
    )
  ).trim()
  const url = `http://127.0.0.1:${f.service.descriptor.port}/v1/rpc`
  const body = JSON.stringify({
    protocolVersion: 1,
    requestId: randomUUID(),
    operation: 'service.status',
    params: {},
  })
  for (const extra of [
    {},
    { Authorization: `Bearer ${token}`, Origin: 'https://example.com' },
  ]) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extra },
      body,
    })
    const wire = parseProtocolResponse(await response.json())
    assert.equal(wire.ok, false)
    if (!wire.ok) assert.equal(wire.error.code, 'PERMISSION_DENIED')
  }
  const wrongHost = await new Promise<string>((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          Host: 'evil.example',
        },
      },
      (response) => {
        let result = ''
        response.on('data', (bytes) => {
          result += String(bytes)
        })
        response.on('end', () => resolve(result))
      },
    )
    req.on('error', reject)
    req.end(body)
  })
  assert.equal(parseProtocolResponse(JSON.parse(wrongHost)).ok, false)
  const desc = (await f.admin('service.describe')) as {
    operations: string[]
    supportedVersions: number[]
  }
  assert.equal(negotiateVersion(desc.supportedVersions), 1)
  assert.deepEqual(desc.operations, [
    'characters.list',
    'bindings.open',
    'bindings.close',
    'context.get',
    'memory.search',
    'memory.propose',
  ])
  assert.throws(() => negotiateVersion([2]))
  const invalid = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body.replace('"protocolVersion":1', '"protocolVersion":2'),
  })
  assert.equal(
    ((await invalid.json()) as { error: { code: string } }).error.code,
    'PROTOCOL_UNSUPPORTED',
  )
  const large = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: 'x'.repeat(262145),
  })
  assert.equal(
    ((await large.json()) as { error: { code: string } }).error.code,
    'INVALID_INPUT',
  )
})

test('strict refuses unknown/self-reported isolation; agents cannot grant or downgrade', async (t) => {
  const f = await fixture(t)
  const g = await f.grant('thread-a')
  assert.deepEqual(
    (
      (await f.agent(g.credentialRef, 'characters.list')) as Array<{
        id: string
      }>
    ).map((x) => x.id),
    ['koto'],
  )
  await assert.rejects(
    f.agent(g.credentialRef, 'bindings.open', { characterId: 'koto', scope }),
    code('ISOLATION_UNSUPPORTED'),
  )
  await assert.rejects(
    f.agent(g.credentialRef, 'connection.grant', {}),
    code('INVALID_INPUT'),
  )
  await assert.rejects(
    f.agent(g.credentialRef, 'bindings.open', {
      characterId: 'koto',
      scope,
      isolation: 'relaxed',
    }),
    code('INVALID_INPUT'),
  )
  const relaxed = await f.grant('thread-relaxed', { isolation: 'relaxed' })
  const b = bindingSchema.parse(
    await f.agent(relaxed.credentialRef, 'bindings.open', {
      characterId: 'koto',
      scope,
    }),
  )
  assert.equal(b.isolationEffective, 'relaxed')
  assert.equal(
    (await readdir(path.join(f.workspace.root, 'bindings'))).length,
    1,
  )
})

test('two sessions and two roles remain independent through close/revoke/retry', async (t) => {
  const f = await fixture(t, verified)
  const second = path.join(f.root, 'second')
  await cp(koto, second, { recursive: true })
  const manifestPath = path.join(second, 'character.yaml')
  await writeFile(
    manifestPath,
    (await readFile(manifestPath, 'utf8')).replace('id: koto', 'id: second'),
  )
  await addCharacter(f.workspace, second)
  const a = await f.grant('thread-a')
  const b = await f.grant('thread-b', { characterIds: ['second'] })
  const request = randomUUID()
  const ba = bindingSchema.parse(
    await f.agent(
      a.credentialRef,
      'bindings.open',
      { characterId: 'koto', scope },
      request,
    ),
  )
  const bb = bindingSchema.parse(
    await f.agent(b.credentialRef, 'bindings.open', {
      characterId: 'second',
      scope,
    }),
  )
  assert.deepEqual(
    await f.agent(
      a.credentialRef,
      'bindings.open',
      { characterId: 'koto', scope },
      request,
    ),
    ba,
  )
  await assert.rejects(
    f.agent(
      a.credentialRef,
      'bindings.open',
      { characterId: 'koto', scope: { ...scope, purpose: 'changed' } },
      request,
    ),
    code('CONFLICT'),
  )
  await assert.rejects(
    f.agent(a.credentialRef, 'bindings.open', { characterId: 'second', scope }),
    code('PERMISSION_DENIED'),
  )
  await assert.rejects(
    f.agent(a.credentialRef, 'bindings.open', {
      characterId: 'koto',
      scope: { ...scope, projectKey: 'other' },
    }),
    code('PERMISSION_DENIED'),
  )
  await assert.rejects(
    f.agent(a.credentialRef, 'bindings.open', { characterId: 'koto', scope }),
    code('CONFLICT'),
  )
  const sameSession = await f.grant('thread-a')
  await assert.rejects(
    f.agent(sameSession.credentialRef, 'bindings.open', {
      characterId: 'koto',
      scope,
    }),
    code('CONFLICT'),
  )
  await assert.rejects(
    f.agent(a.credentialRef, 'bindings.close', {
      bindingId: bb.id,
      expectedRevision: 1,
    }),
    code('PERMISSION_DENIED'),
  )
  await assert.rejects(
    f.agent(a.credentialRef, 'bindings.close', {
      bindingId: ba.id,
      expectedRevision: 2,
    }),
    code('CONFLICT'),
  )
  const closeId = randomUUID()
  const closed = await f.agent(
    a.credentialRef,
    'bindings.close',
    { bindingId: ba.id, expectedRevision: 1 },
    closeId,
  )
  assert.deepEqual(
    await f.agent(
      a.credentialRef,
      'bindings.close',
      { bindingId: ba.id, expectedRevision: 1 },
      closeId,
    ),
    closed,
  )
  await assert.rejects(
    f.agent(
      a.credentialRef,
      'bindings.open',
      { characterId: 'koto', scope },
      request,
    ),
    code('BINDING_INACTIVE'),
  )
  assert.equal(
    bindingSchema.parse(await f.admin('binding.show', { id: bb.id })).status,
    'active',
  )
  await f.admin('connection.revoke', { id: a.grant.id, expectedRevision: 1 })
  await assert.rejects(
    f.agent(a.credentialRef, 'characters.list'),
    code('PERMISSION_DENIED'),
  )
  await assert.rejects(
    f.agent(
      a.credentialRef,
      'bindings.close',
      { bindingId: ba.id, expectedRevision: 1 },
      closeId,
    ),
    code('PERMISSION_DENIED'),
  )
  assert.equal(
    bindingSchema.parse(await f.admin('binding.show', { id: bb.id })).status,
    'active',
  )
  const token = (
    await readFile(path.join(f.workspace.root, a.credentialRef), 'utf8')
  ).trim()
  const audits = await readdir(path.join(f.workspace.root, 'audit'))
  for (const name of audits)
    assert.equal(
      (
        await readFile(path.join(f.workspace.root, 'audit', name), 'utf8')
      ).includes(token),
      false,
    )
})

test('grant retry never returns a secret or duplicates authorization; changed request conflicts', async (t) => {
  const f = await fixture(t)
  const input = {
    hostId: 'mock',
    pluginId: 'test',
    hostSessionRef: 'thread',
    characterIds: ['koto'],
    allowedProjectKeys: [],
    allowedContextKeys: [],
    actions: ['discover'],
    isolation: 'strict',
    ttlSeconds: 3600,
  }
  const request = randomUUID()
  const first = await f.admin('connection.grant', input, request)
  assert.deepEqual(await f.admin('connection.grant', input, request), first)
  await assert.rejects(
    f.admin(
      'connection.grant',
      { ...input, hostSessionRef: 'different' },
      request,
    ),
    code('CONFLICT'),
  )
  assert.equal(
    (await readdir(path.join(f.workspace.root, 'connections'))).length,
    1,
  )
  const saved = await readFile(
    path.join(f.workspace.root, `.runtime/receipts/${request}.json`),
    'utf8',
  )
  assert.equal(saved.includes('.token'), false)
  assert.equal(JSON.stringify(first).includes('credentialDigest'), false)
})

test('restart interrupts bindings, rotates admin authority and never reactivates history', async (t) => {
  const f = await fixture(t, verified)
  const g = await f.grant('thread')
  const b = bindingSchema.parse(
    await f.agent(g.credentialRef, 'bindings.open', {
      characterId: 'koto',
      scope,
    }),
  )
  await assert.rejects(startService(f.workspace), code('BUSY'))
  await f.service.close()
  const restarted = await startService(f.workspace, { verifier: verified })
  f.services.push(restarted)
  assert.notEqual(
    restarted.descriptor.generation,
    f.service.descriptor.generation,
  )
  assert.equal(
    bindingSchema.parse(await f.admin('binding.show', { id: b.id })).status,
    'interrupted',
  )
  await assert.rejects(
    f.agent(g.credentialRef, 'bindings.close', {
      bindingId: b.id,
      expectedRevision: 1,
    }),
    code('PERMISSION_DENIED'),
  )
  const newBinding = bindingSchema.parse(
    await f.agent(g.credentialRef, 'bindings.open', {
      characterId: 'koto',
      scope,
    }),
  )
  assert.notEqual(newBinding.id, b.id)
})

test('expired grant and changed trusted host configuration invalidate cached results', async (t) => {
  let configuration = 'first'
  const f = await fixture(t, async (grant, signal) => {
    const value = await verified(grant, signal)
    return value
      ? { ...value, configurationDigest: sha256(configuration) }
      : undefined
  })
  const g = await f.grant('thread')
  const request = randomUUID()
  await f.agent(
    g.credentialRef,
    'bindings.open',
    { characterId: 'koto', scope },
    request,
  )
  configuration = 'changed'
  await assert.rejects(
    f.agent(
      g.credentialRef,
      'bindings.open',
      { characterId: 'koto', scope },
      request,
    ),
    code('EVIDENCE_EXPIRED'),
  )
  const ref = `connections/${g.grant.id}.json`
  await withStore(f.workspace, async (tx) => {
    const old = await readJson(f.workspace.root, ref, connectionGrantSchema)
    await tx.put(
      ref,
      jsonBytes({ ...old, expiresAt: new Date(Date.now() - 1).toISOString() }),
      sha256(await readFile(path.join(f.workspace.root, ref))),
    )
  })
  await assert.rejects(
    f.agent(g.credentialRef, 'characters.list'),
    code('PERMISSION_DENIED'),
  )
})

test('binding expiry is enforced without a timer and records become expired', async (t) => {
  const f = await fixture(t, verified)
  const g = await f.grant('thread')
  const b = bindingSchema.parse(
    await f.agent(g.credentialRef, 'bindings.open', {
      characterId: 'koto',
      scope,
    }),
  )
  const ref = `bindings/${b.id}/binding.json`
  await withStore(f.workspace, async (tx) => {
    const bytes = await readFile(path.join(f.workspace.root, ref))
    await tx.put(
      ref,
      jsonBytes({ ...b, expiresAt: new Date(Date.now() - 1).toISOString() }),
      sha256(bytes),
    )
  })
  const records = (await f.admin('binding.list')) as unknown[]
  assert.equal(bindingSchema.parse(records[0]).status, 'expired')
  await assert.rejects(
    f.agent(g.credentialRef, 'bindings.close', {
      bindingId: b.id,
      expectedRevision: 1,
    }),
    code('BINDING_INACTIVE'),
  )
})

test('host verification holds no storage lock and authorization is checked again afterwards', async (t) => {
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const pause = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = await fixture(t, async (grant, signal) => {
    enter()
    await pause
    return verified(grant, signal)
  })
  const g = await f.grant('thread')
  const opening = f.agent(g.credentialRef, 'bindings.open', {
    characterId: 'koto',
    scope,
  })
  await entered
  try {
    // Simulate a concurrent trusted management write while the host is pending.
    await withStore(f.workspace, async (tx) => {
      const ref = `connections/${g.grant.id}.json`
      const record = await readJson(
        f.workspace.root,
        ref,
        connectionGrantSchema,
      )
      await tx.put(
        ref,
        jsonBytes({ ...record, revision: 2, status: 'revoked' }),
        sha256(await readFile(path.join(f.workspace.root, ref))),
      )
    })
  } finally {
    release()
  }
  await assert.rejects(opening, code('PERMISSION_DENIED'))
  assert.equal(((await f.admin('binding.list')) as unknown[]).length, 0)
})

test('foreground CLI lifecycle preserves unrelated host configuration and memory bytes', async (t) => {
  const root = await temporary(t, async () => {
    await cleanup?.()
  })
  let cleanup: (() => Promise<void>) | undefined
  const home = path.join(root, 'host-home')
  await mkdir(home)
  const markers = new Map([
    ['config.toml', 'other-session-enabled = true\n'],
    ['memory.md', 'OTHER_SESSION_PRIVATE_SENTINEL\n'],
  ])
  for (const [name, bytes] of markers)
    await writeFile(path.join(home, name), bytes)
  const workspace = await initWorkspace(path.join(root, 'data'))
  await migrateService(workspace)
  const child = spawn(
    process.execPath,
    [
      path.join(repository, 'packages/cli/dist/index.js'),
      'service',
      'serve',
      '--workspace',
      workspace.root,
      '--json',
    ],
    {
      env: {
        ...process.env,
        HOME: path.join(root, 'os-profile'),
        USERPROFILE: path.join(root, 'os-profile'),
        CODEX_HOME: home,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  cleanup = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, 'exit')
      child.kill()
      await done
    }
  }
  let output = ''
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.stdout.on('data', (bytes) => {
      output += String(bytes)
      if (output.includes('"status":"running"')) resolve()
    })
    child.once('exit', (value) => {
      if (!output.includes('"status":"running"'))
        reject(new Error(`CLI exited ${value}`))
    })
  })
  assert.equal(
    (
      (await managementRequest(workspace, 'service.status')) as {
        status: string
      }
    ).status,
    'running',
  )
  const done = once(child, 'exit')
  await managementRequest(workspace, 'service.stop')
  assert.deepEqual(await done, [0, null])
  for (const [name, bytes] of markers)
    assert.equal(await readFile(path.join(home, name), 'utf8'), bytes)
  assert.deepEqual((await readdir(home)).sort(), ['config.toml', 'memory.md'])
  await assert.rejects(
    managementRequest(workspace, 'service.status'),
    code('SERVICE_UNAVAILABLE'),
  )
})

test('migration is explicit and foreign service owners are never reaped', async (t) => {
  const root = await temporary(t)
  const workspace = await initWorkspace(path.join(root, 'data'))
  await assert.rejects(startService(workspace), code('RECOVERY_REQUIRED'))
  await migrateService(workspace)
  const lock = path.join(workspace.root, '.runtime/service/instance.lock')
  await mkdir(lock)
  const owner = JSON.stringify({
    schemaVersion: 1,
    token: randomUUID(),
    pid: process.pid,
    host: 'a-different-host',
    createdAt: new Date().toISOString(),
  })
  await writeFile(path.join(lock, 'owner.json'), owner)
  await assert.rejects(startService(workspace), code('BUSY'))
  assert.equal(await readFile(path.join(lock, 'owner.json'), 'utf8'), owner)
})

test('explicit legacy migration backs up, rolls back exact bytes and recovers prepared WAL', async (t) => {
  const root = await temporary(t)
  const workspace = await initWorkspace(path.join(root, 'data'))
  const originalConfig = await readFile(
    path.join(workspace.root, 'workspace.yaml'),
  )
  const id = newId('mem')
  const ref = `states/koto/memories/${id}.json`
  await mkdir(path.dirname(path.join(workspace.root, ref)), { recursive: true })
  const original = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      id,
      revision: 1,
      characterId: 'koto',
      kind: 'fact',
      status: 'candidate',
      content: 'private',
      tags: [],
      visibility: 'private',
      recordedAt: new Date().toISOString(),
      sources: [{ type: 'user-statement', statementRef: 'objects/test.txt' }],
      decisions: [],
    }),
  )
  await writeFile(path.join(workspace.root, ref), original)
  const worker = path.join(repository, 'tests/fixtures/service-worker.mjs')
  await assert.rejects(
    execute(process.execPath, [worker, workspace.root, 'migrate']),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 86,
  )
  const reopened = await openWorkspace(workspace.root)
  const upgraded = memoryV2Schema.parse(
    JSON.parse(await readFile(path.join(workspace.root, ref), 'utf8')),
  )
  assert.equal(upgraded.workspaceId, workspace.config.id)
  assert.deepEqual(
    await readFile(path.join(workspace.root, 'workspace.yaml')),
    originalConfig,
  )
  const migration = await migrateService(reopened)
  assert.equal(migration.revision, 1)
  await migrateService(reopened, true)
  assert.deepEqual(await readFile(path.join(workspace.root, ref)), original)
  await migrateService(reopened)
  assert.equal(
    memoryV2Schema.parse(
      JSON.parse(await readFile(path.join(workspace.root, ref), 'utf8')),
    ).schemaVersion,
    2,
  )
})

test('crashed service owner is recovered and old-generation active binding interrupted', async (t) => {
  let cleanup: (() => Promise<void>) | undefined
  const root = await temporary(t, async () => {
    await cleanup?.()
  })
  const workspace = await initWorkspace(path.join(root, 'data'))
  await migrateService(workspace)
  await addCharacter(workspace, koto)
  const child = spawn(
    process.execPath,
    [
      path.join(repository, 'tests/fixtures/service-worker.mjs'),
      workspace.root,
      'serve',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  )
  cleanup = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, 'exit')
      child.kill()
      await done
    }
  }
  let output = ''
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.stdout.on('data', (data) => {
      output += String(data)
      if (output.includes('ready')) resolve()
    })
    child.once('exit', (code) => {
      if (!output.includes('ready')) reject(new Error(`worker exited ${code}`))
    })
  })
  const input = {
    hostId: 'mock',
    pluginId: 'test',
    hostSessionRef: 'thread',
    characterIds: ['koto'],
    allowedProjectKeys: [],
    allowedContextKeys: [],
    actions: ['discover', 'bind'],
    isolation: 'relaxed',
    ttlSeconds: 3600,
  }
  const g = grantResultSchema.parse(
    await managementRequest(workspace, 'connection.grant', input),
  )
  const b = bindingSchema.parse(
    await managementRequest(
      workspace,
      'bindings.open',
      { characterId: 'koto', scope: { purpose: 'test', contextKeys: [] } },
      randomUUID(),
      g.credentialRef,
    ),
  )
  const exit = once(child, 'exit')
  child.kill('SIGKILL')
  await exit
  const service = await startService(await openWorkspace(workspace.root))
  cleanup = () => service.close()
  assert.equal(
    bindingSchema.parse(
      await managementRequest(workspace, 'binding.show', { id: b.id }),
    ).status,
    'interrupted',
  )
})
