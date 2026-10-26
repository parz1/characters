import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  addCharacter,
  bindingSchema,
  contextDeliverySchema,
  initWorkspace,
  jsonBytes,
  memoryV2Schema,
  memorySearchResultSchema,
  migrateService,
  openWorkspace,
  sha256,
  withStore,
  usageScopeSchema,
} from '@characters/core'
import { managementRequest, startService } from '@characters/service'
import type { HostVerifier } from '@characters/service'
import { temporary, koto, repository } from './helpers.ts'

const execute = promisify(execFile)
const code = (expected: string) => (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === expected
const scope = {
  purpose: 'development',
  projectKey: 'blog',
  contextKeys: ['people/parz1'],
}
const verifier: HostVerifier = async (grant) => ({
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
  hostVersion: 'test',
  pluginVersion: 'test',
  verifierVersion: 'test-only',
  configurationDigest: sha256('fixture'),
})
async function setup(t: TestContext) {
  let service: Awaited<ReturnType<typeof startService>> | undefined
  const root = await temporary(t, async () => {
    await service?.close()
  })
  const workspace = await initWorkspace(path.join(root, 'data'))
  await migrateService(workspace)
  await addCharacter(workspace, koto)
  service = await startService(workspace, { verifier })
  const admin = (operation: string, params: unknown = {}, id?: string) =>
    managementRequest(workspace, operation, params, id)
  const connect = async (
    session: string,
    character = 'koto',
    bindingScope: z.infer<typeof usageScopeSchema> = scope,
    actions = [
      'discover',
      'bind',
      'context.read',
      'memory.search',
      'memory.propose',
    ],
  ) => {
    const grant = z.object({ credentialRef: z.string() }).parse(
      await admin('connection.grant', {
        hostId: 'test',
        pluginId: 'test-plugin',
        hostSessionRef: session,
        characterIds: [character],
        allowedProjectKeys: ['blog', 'other'],
        allowedContextKeys: ['people/parz1', 'projects/kotolog'],
        actions,
        isolation: 'strict',
        ttlSeconds: 3600,
      }),
    )
    const call = (operation: string, params: unknown, id?: string) =>
      managementRequest(workspace, operation, params, id, grant.credentialRef)
    const binding = bindingSchema.parse(
      await call('bindings.open', {
        characterId: character,
        scope: bindingScope,
      }),
    )
    return {
      binding,
      call,
      grant,
      context: async () =>
        contextDeliverySchema.parse(
          await call('context.get', { bindingId: binding.id }),
        ),
      search: async (query: string) =>
        memorySearchResultSchema.parse(
          await call('memory.search', {
            bindingId: binding.id,
            query,
            limit: 20,
          }),
        ),
      propose: async (
        content: string,
        extra: Record<string, unknown> = {},
        requestId?: string,
      ) =>
        memoryV2Schema.parse(
          await call(
            'memory.propose',
            {
              bindingId: binding.id,
              candidate: {
                kind: 'opinion',
                content,
                tags: ['design'],
                scope: bindingScope.projectKey
                  ? { projectKey: bindingScope.projectKey }
                  : {},
                excerpt:
                  'PRIVATE_SOURCE_EXCERPT supplied explicitly by the host',
                ...extra,
              },
            },
            requestId,
          ),
        ),
    }
  }
  const confirm = async (
    record: z.infer<typeof memoryV2Schema>,
    extra: Record<string, unknown> = {},
  ) =>
    memoryV2Schema.parse(
      await admin('memory.confirm', {
        characterId: record.characterId,
        id: record.id,
        expectedRevision: record.revision,
        ...extra,
      }),
    )
  const restart = async () => {
    await service?.close()
    service = await startService(workspace, { verifier })
  }
  return { root, workspace, admin, connect, confirm, restart }
}

test('M3 complete loop delivers definitions, reviews candidate, shares confirmed memory and retracts it', async (t) => {
  const f = await setup(t)
  const a = await f.connect('session-a')
  const initial = await a.context()
  assert.deepEqual(
    initial.entries.map((entry) => entry.kind),
    ['persona', 'voice', 'relationship', 'mode'],
  )
  const candidateRequest = randomUUID()
  const candidate = await a.propose(
    'Prefer explicit authorization boundaries',
    {},
    candidateRequest,
  )
  assert.deepEqual(
    await a.propose(candidate.content, {}, candidateRequest),
    candidate,
  )
  assert.equal((await a.search('authorization')).matches.length, 0)
  const pending = (await f.admin('memory.list', {
    characterId: 'koto',
    status: 'candidate',
  })) as { items: unknown[] }
  assert.equal(pending.items.length, 1)
  const inspection = (await f.admin('memory.show', {
    characterId: 'koto',
    id: candidate.id,
  })) as { sourceExcerpts: Array<{ text: string }> }
  assert.match(
    inspection.sourceExcerpts[0]?.text ?? '',
    /PRIVATE_SOURCE_EXCERPT/,
  )
  const confirmed = await f.confirm(candidate)
  assert.equal(confirmed.status, 'confirmed')
  await assert.rejects(
    a.propose(candidate.content, {}, candidateRequest),
    code('CONFLICT'),
  )
  const b = await f.connect('session-b')
  const search = await b.search('authorization')
  assert.deepEqual(
    search.matches.map((match) => match.id),
    [candidate.id],
  )
  assert.equal(JSON.stringify(search).includes('PRIVATE_SOURCE_EXCERPT'), false)
  assert.equal(JSON.stringify(search).includes('session-a'), false)
  const delivery = await b.context()
  const repeated = randomUUID()
  assert.equal(
    memorySearchResultSchema.parse(
      await b.call(
        'memory.search',
        { bindingId: b.binding.id, query: 'authorization', limit: 20 },
        repeated,
      ),
    ).matches.length,
    1,
  )
  assert.equal(
    delivery.entries.some((entry) => entry.text === candidate.content),
    true,
  )
  const manifest = (await f.admin('context.explain', {
    bindingId: b.binding.id,
    snapshotId: delivery.id,
  })) as { entries: unknown[] }
  assert.equal(
    manifest.entries.some(
      (entry) => entry !== null && typeof entry === 'object' && 'text' in entry,
    ),
    false,
  )
  await f.admin('memory.retract', {
    characterId: 'koto',
    id: confirmed.id,
    expectedRevision: confirmed.revision,
    reason: 'No longer wanted',
  })
  assert.equal((await b.search('authorization')).matches.length, 0)
  assert.equal(
    (await b.context()).entries.some(
      (entry) => entry.text === candidate.content,
    ),
    false,
  )
  // A reused read request always computes current state; no cached snapshot replay.
  const result = await b.call(
    'memory.search',
    { bindingId: b.binding.id, query: 'authorization', limit: 20 },
    repeated,
  )
  assert.equal(memorySearchResultSchema.parse(result).matches.length, 0)
  const historical = contextDeliverySchema.parse(
    await f.admin('context.explain', {
      bindingId: b.binding.id,
      snapshotId: delivery.id,
      content: true,
    }),
  )
  assert.equal(
    historical.entries.some((entry) => entry.text === candidate.content),
    true,
  )
  await assert.rejects(
    b.call('context.explain', {
      bindingId: b.binding.id,
      snapshotId: delivery.id,
    }),
    code('INVALID_INPUT'),
  )
})

test('roles, projects, context keys and pending/rejected records are filtered before ranking', async (t) => {
  const f = await setup(t)
  const second = path.join(f.root, 'second')
  await cp(koto, second, { recursive: true })
  const manifest = path.join(second, 'character.yaml')
  await writeFile(
    manifest,
    (await readFile(manifest, 'utf8')).replace('id: koto', 'id: second'),
  )
  await addCharacter(f.workspace, second)
  const a = await f.connect('a')
  const otherRole = await f.connect('second', 'second')
  const otherProject = await f.connect('other', 'koto', {
    ...scope,
    projectKey: 'other',
  })
  const withoutContext = await f.connect('no-context', 'koto', {
    ...scope,
    contextKeys: [],
  })
  await f.confirm(await a.propose('COMMON_QUERY authorized koto'))
  await f.confirm(await otherRole.propose('COMMON_QUERY OTHER_ROLE_SECRET'))
  await f.confirm(
    await otherProject.propose('COMMON_QUERY OTHER_PROJECT_SECRET'),
  )
  const rejected = await a.propose('COMMON_QUERY REJECTED_SECRET')
  await f.admin('memory.reject', {
    characterId: 'koto',
    id: rejected.id,
    expectedRevision: 1,
  })
  await a.propose('COMMON_QUERY CANDIDATE_SECRET')
  await assert.rejects(
    otherProject.propose('probe rejected record', { replaces: rejected.id }),
    code('NOT_FOUND'),
  )
  assert.deepEqual(
    (await a.search('COMMON_QUERY')).matches.map((match) => match.content),
    ['COMMON_QUERY authorized koto'],
  )
  assert.equal((await withoutContext.search('COMMON_QUERY')).matches.length, 0)
  const common = await f.connect('global', 'koto', {
    purpose: 'shared memory',
    contextKeys: [],
  })
  await f.confirm(await common.propose('COMMON_QUERY GLOBAL_MEMORY'))
  assert.equal((await a.search('COMMON_QUERY')).matches.length, 2)
  assert.equal(
    (await otherProject.search('COMMON_QUERY')).matches.some(
      (match) => match.content === 'COMMON_QUERY GLOBAL_MEMORY',
    ),
    true,
  )
  assert.equal(
    (await otherRole.search('COMMON_QUERY')).matches.some(
      (match) => match.content === 'COMMON_QUERY GLOBAL_MEMORY',
    ),
    false,
  )
  await assert.rejects(
    a.propose('widen', { scope: {} }),
    code('PERMISSION_DENIED'),
  )
  await assert.rejects(
    a.call('memory.search', {
      bindingId: otherRole.binding.id,
      query: 'COMMON_QUERY',
      limit: 20,
    }),
    code('PERMISSION_DENIED'),
  )
  await assert.rejects(
    a.call('memory.confirm', {
      characterId: 'koto',
      id: rejected.id,
      expectedRevision: 2,
    }),
    code('INVALID_INPUT'),
  )
})

test('shared backgrounds require explicit import and scoped approval; revocation and updates are immediate', async (t) => {
  const f = await setup(t)
  const a = await f.connect('a')
  await f.admin('context.import', {
    key: 'people/parz1',
    text: 'APPROVED_CONTEXT_V1',
    expectedRevision: 0,
  })
  await f.admin('context.import', {
    key: 'projects/kotolog',
    text: 'UNSELECTED_BACKGROUND',
    expectedRevision: 0,
  })
  const first = await a.context()
  assert.equal(
    first.entries.some((entry) => entry.text === 'APPROVED_CONTEXT_V1'),
    true,
  )
  assert.equal(JSON.stringify(first).includes('UNSELECTED_BACKGROUND'), false)
  await assert.rejects(
    f.admin('context.import', {
      key: 'people/parz1',
      text: 'stale',
      expectedRevision: 0,
    }),
    code('CONFLICT'),
  )
  await f.admin('context.import', {
    key: 'people/parz1',
    text: 'APPROVED_CONTEXT_V2',
    expectedRevision: 1,
  })
  assert.equal(
    (await a.context()).entries.some(
      (entry) => entry.text === 'APPROVED_CONTEXT_V2' && entry.revision === 2,
    ),
    true,
  )
  await f.admin('context.revoke', { key: 'people/parz1', expectedRevision: 2 })
  const final = await a.context()
  assert.equal(
    final.entries.some((entry) => entry.kind === 'context'),
    false,
  )
  assert.equal(
    final.excluded.some((entry) => entry.reason === 'revoked'),
    true,
  )
})

test('memory decisions are versioned, replacement is atomic and fact confirmation requires human basis', async (t) => {
  const f = await setup(t)
  const a = await f.connect('a')
  const first = await f.confirm(await a.propose('old design'))
  const second = await a.propose('new design', { replaces: first.id })
  await assert.rejects(f.confirm(second), code('CONFLICT'))
  await assert.rejects(
    f.confirm(second, { replaceExpectedRevision: 99 }),
    code('CONFLICT'),
  )
  const updated = await f.confirm(second, {
    replaceExpectedRevision: first.revision,
  })
  assert.equal(updated.status, 'confirmed')
  assert.equal((await a.search('design')).matches.length, 1)
  const old = (await f.admin('memory.show', {
    characterId: 'koto',
    id: first.id,
  })) as { record: { status: string } }
  assert.equal(old.record.status, 'superseded')
  await assert.rejects(
    f.confirm(second, { replaceExpectedRevision: first.revision }),
    code('CONFLICT'),
  )
  const fact = await a.propose('The user chose this identifier', {
    kind: 'fact',
  })
  await assert.rejects(f.confirm(fact), code('INVALID_INPUT'))
  assert.equal(
    (
      await f.confirm(fact, {
        factBasis: 'I reviewed the quoted user statement against my own notes',
      })
    ).factReview?.actor,
    'user',
  )
})

test('permissions, close/revoke and old request IDs cannot release private data', async (t) => {
  const f = await setup(t)
  const a = await f.connect('a')
  const candidate = await a.propose('permission marker')
  await f.confirm(candidate)
  const limited = await f.connect('limited', 'koto', scope, [
    'discover',
    'bind',
  ])
  await assert.rejects(limited.context(), code('PERMISSION_DENIED'))
  await assert.rejects(limited.search('marker'), code('PERMISSION_DENIED'))
  await assert.rejects(limited.propose('marker'), code('PERMISSION_DENIED'))
  const id = randomUUID()
  await a.call('context.get', { bindingId: a.binding.id }, id)
  await a.call('bindings.close', {
    bindingId: a.binding.id,
    expectedRevision: 1,
  })
  await assert.rejects(
    a.call('context.get', { bindingId: a.binding.id }, id),
    code('BINDING_INACTIVE'),
  )
  const b = await f.connect('b')
  assert.equal((await b.search('marker')).matches.length, 1)
  await f.admin('binding.revoke', { id: b.binding.id, expectedRevision: 1 })
  await assert.rejects(b.search('marker'), code('BINDING_INACTIVE'))
})

test('budgets are explicit, ranking deterministic and a corrupted excerpt cannot be confirmed', async (t) => {
  const f = await setup(t)
  const a = await f.connect('a')
  await f.confirm(await a.propose('alpha beta', { tags: ['beta'] }))
  await f.confirm(await a.propose('beta'))
  const one = await a.search('beta'),
    two = await a.search('beta')
  assert.deepEqual(one.matches, two.matches)
  assert.equal(one.matches[0]?.score, 3)
  const bad = await a.propose('bad source')
  const source = bad.sources[0]
  assert.ok(source?.type === 'host-excerpt')
  await writeFile(path.join(f.workspace.root, source.excerptRef), 'tampered')
  await assert.rejects(f.confirm(bad), code('STORE_CORRUPT'))
  await f.admin('memory.reject', {
    characterId: 'koto',
    id: bad.id,
    expectedRevision: 1,
  })
  await withStore(f.workspace, async (tx) => {
    const filename = path.join(f.workspace.root, 'service.yaml')
    const bytes = await readFile(filename)
    await tx.put(
      'service.yaml',
      jsonBytes({ ...JSON.parse(bytes.toString()), contextBudgetBytes: 1024 }),
      sha256(bytes),
    )
  })
  await assert.rejects(a.context(), code('CONTEXT_LIMIT'))
  // Optional memory overflow is recorded, never truncated.
  await f.confirm(await a.propose('oversized '.repeat(200)))
  const bounded = await a.search('oversized')
  assert.equal(bounded.matches.length, 0)
  assert.equal(bounded.delivery.excluded[0]?.reason, 'byte-budget')
})

test('CLI reviews memory and imports context through the authenticated management service', async (t) => {
  const f = await setup(t)
  const a = await f.connect('a')
  const candidate = await a.propose('CLI review marker')
  const cli = async (...args: string[]) => {
    const { stdout } = await execute(process.execPath, [
      path.join(repository, 'packages/cli/dist/index.js'),
      ...args,
      '--workspace',
      f.workspace.root,
      '--json',
    ])
    return JSON.parse(stdout) as { ok: boolean; data: unknown }
  }
  assert.equal((await cli('memory', 'list', '--character', 'koto')).ok, true)
  assert.equal(
    (await cli('memory', 'show', candidate.id, '--character', 'koto')).ok,
    true,
  )
  await cli(
    'memory',
    'confirm',
    candidate.id,
    '--character',
    'koto',
    '--expect-revision',
    '1',
  )
  assert.equal((await a.search('CLI')).matches.length, 1)
  const background = path.join(f.root, 'background.md')
  await writeFile(background, 'CLI context background')
  await cli(
    'context',
    'import',
    'people/parz1',
    '--file',
    background,
    '--expect-revision',
    '0',
  )
  const delivery = await a.context()
  const explain = await cli(
    'context',
    'explain',
    delivery.id,
    '--binding',
    a.binding.id,
  )
  assert.equal(
    JSON.stringify(explain).includes('CLI context background'),
    false,
  )
  await cli(
    'memory',
    'retract',
    candidate.id,
    '--character',
    'koto',
    '--expect-revision',
    '2',
  )
  assert.equal((await a.search('CLI')).matches.length, 0)
})

test('replacement interrupted after its first mutation recovers both statuses, audit and receipt once', async (t) => {
  const f = await setup(t)
  const a = await f.connect('a')
  const old = await f.confirm(await a.propose('before crash'))
  const candidate = await a.propose('after crash', { replaces: old.id })
  const request = {
    protocolVersion: 1,
    requestId: randomUUID(),
    operation: 'memory.confirm',
    params: {
      characterId: 'koto',
      id: candidate.id,
      expectedRevision: 1,
      replaceExpectedRevision: 2,
    },
  }
  await assert.rejects(
    execute(process.execPath, [
      path.join(repository, 'tests/fixtures/service-worker.mjs'),
      f.workspace.root,
      'memory-decision',
      JSON.stringify(request),
    ]),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 86,
  )
  await openWorkspace(f.workspace.root)
  const result = memoryV2Schema.parse(
    await f.admin(request.operation, request.params, request.requestId),
  )
  assert.equal(result.revision, 2)
  assert.deepEqual(
    (await a.search('crash')).matches.map((match) => match.id),
    [candidate.id],
  )
  const oldRecord = (await f.admin('memory.show', {
    characterId: 'koto',
    id: old.id,
  })) as { record: { revision: number; status: string } }
  assert.deepEqual(
    { revision: oldRecord.record.revision, status: oldRecord.record.status },
    { revision: 3, status: 'superseded' },
  )
  const auditNames = await readdir(path.join(f.workspace.root, 'audit'))
  let confirmations = 0
  for (const name of auditNames) {
    const bytes = await readFile(
      path.join(f.workspace.root, 'audit', name),
      'utf8',
    )
    const record = JSON.parse(bytes) as { operation: string; memoryId?: string }
    if (
      record.operation === 'memory.confirm' &&
      record.memoryId === candidate.id
    )
      confirmations++
    assert.equal(bytes.includes('PRIVATE_SOURCE_EXCERPT'), false)
  }
  assert.equal(confirmations, 1)
})

test('standalone M3 demonstration uses a fresh workspace, marks relaxed and stops its service', async (t) => {
  const root = await temporary(t)
  const directory = path.join(root, 'demo')
  const { stdout } = await execute(
    process.execPath,
    [
      '--experimental-strip-types',
      path.join(repository, 'scripts/m3-demo.ts'),
      '--workspace',
      directory,
    ],
    { timeout: 20000 },
  )
  const result = JSON.parse(stdout) as {
    ok: boolean
    hostIsolationVerified: boolean
    checks: string[]
  }
  assert.equal(result.ok, true)
  assert.equal(result.hostIsolationVerified, false)
  assert.equal(result.checks.length, 5)
  await assert.rejects(
    managementRequest(await openWorkspace(directory), 'service.status'),
    code('SERVICE_UNAVAILABLE'),
  )
  await assert.rejects(
    execute(process.execPath, [
      '--experimental-strip-types',
      path.join(repository, 'scripts/m3-demo.ts'),
      '--workspace',
      directory,
    ]),
  )
})

test('confirmed memory persists across restart, while pending candidates and old bindings remain inactive', async (t) => {
  const f = await setup(t)
  const a = await f.connect('before-restart')
  const record = await f.confirm(await a.propose('PERSISTENT_MARKER'))
  await a.propose('PENDING_MARKER')
  await f.restart()
  await assert.rejects(a.context(), code('BINDING_INACTIVE'))
  const b = await f.connect('after-restart')
  assert.deepEqual(
    (await b.search('PERSISTENT_MARKER')).matches.map((hit) => hit.id),
    [record.id],
  )
  assert.equal((await b.search('PENDING_MARKER')).matches.length, 0)
})

test('another workspace cannot retrieve memory and rejects a copied foreign record', async (t) => {
  const one = await setup(t),
    two = await setup(t)
  const a = await one.connect('a'),
    b = await two.connect('b')
  const record = await one.confirm(await a.propose('FOREIGN_WORKSPACE_SECRET'))
  assert.equal((await b.search('FOREIGN_WORKSPACE_SECRET')).matches.length, 0)
  const directory = path.join(two.workspace.root, 'states/koto/memories')
  await mkdir(directory, { recursive: true })
  await writeFile(
    path.join(directory, `${record.id}.json`),
    JSON.stringify(record),
  )
  await assert.rejects(
    b.search('FOREIGN_WORKSPACE_SECRET'),
    code('STORE_CORRUPT'),
  )
})
