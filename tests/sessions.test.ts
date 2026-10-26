import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import {
  initWorkspace,
  addCharacter,
  createWork,
  openSession,
  sendSession,
  showSession,
  showSessionRun,
  listSessions,
  setSessionStatus,
  showWork,
  applyProposal,
  updateWork,
  importSource,
  CharactersError,
  newId,
  sha256,
} from '@characters/core'
import type {
  CharacterAdapter,
  AdapterCapabilities,
  AdapterEvent,
  ExecutionRequest,
} from '@characters/core'
import { temporary, koto } from './helpers.ts'

class FixtureAdapter implements CharacterAdapter {
  requests: ExecutionRequest[] = []
  probes = 0
  mode: 'good' | 'bad-source' | 'throw' | 'tool' | 'duplicate' = 'good'
  proposal: 'none' | 'outline' | 'draft' = 'none'
  afterStarted?: () => Promise<void>
  async probe(): Promise<AdapterCapabilities> {
    this.probes++
    return {
      protocolVersion: 1,
      adapterId: 'fixture',
      adapterVersion: '1',
      hostVersion: 'fixture',
      freshExecution: 'supported',
      hostMemory: 'disabled',
      toolBoundary: 'enforced',
      defaultConfigDiscovery: 'controlled',
      cancellation: 'supported',
      providerRetention: 'unknown',
      evidence: {
        id: newId('evd'),
        verifiedAt: new Date().toISOString(),
        validUntil: new Date(Date.now() + 100000).toISOString(),
        hostBinaryDigest: sha256('fixture'),
        configurationDigest: sha256('fixture-policy'),
        suiteVersion: 'fixture-only',
        result: 'pass',
      },
    }
  }
  async *run(request: ExecutionRequest): AsyncIterable<AdapterEvent> {
    this.requests.push(request)
    yield { runId: request.runId, sequence: 1, type: 'started' }
    await this.afterStarted?.()
    if (this.mode === 'throw')
      throw new CharactersError('CANCELLED', 'cancelled', 'retry')
    if (this.mode === 'tool') {
      yield {
        runId: request.runId,
        sequence: 2,
        type: 'tool-request',
        requestId: randomUUID(),
        name: 'source.read',
        sourceId: newId('src'),
      }
      return
    }
    let sequence = 2
    if (this.proposal !== 'none')
      yield {
        runId: request.runId,
        sequence: sequence++,
        type: 'proposal',
        proposal: {
          target: this.proposal,
          baseRevision: request.work?.revision ?? 1,
          content: 'Fixture draft with a concrete observation.',
          sourceIds:
            this.mode === 'bad-source'
              ? [newId('src')]
              : request.allowedSourceIds,
        },
      }
    yield {
      runId: request.runId,
      sequence,
      type: 'completed',
      text: 'parz1，先把真正值得记录的问题说清楚。',
      isolationAudit: {
        globalMemoryMetadataUnchanged: true,
        executionDirectoryRemoved: true,
        toolCallsObserved: 0,
      },
    }
    if (this.mode === 'duplicate')
      yield {
        runId: request.runId,
        sequence: sequence + 1,
        type: 'completed',
        text: 'duplicate',
      }
  }
}
async function fixture(root: string) {
  const workspace = await initWorkspace(path.join(root, 'data'))
  await addCharacter(workspace, koto)
  const work = await createWork(workspace, {
    title: 'Koto articles',
    language: 'cn',
    kind: 'log',
    authors: ['character:koto'],
  })
  const session = await openSession(workspace, {
    characterId: 'koto',
    mode: 'coauthor',
    language: 'cn',
    workId: work.id,
  })
  return { workspace, work, session, adapter: new FixtureAdapter() }
}

test('role, discussion history and source snapshots form an explicit inspectable context', async (t) => {
  const { workspace, work, session, adapter } = await fixture(
    await temporary(t),
  )
  await importSource(workspace, work.id, {
    title: 'notes',
    text: 'SOURCE_CANARY',
  })
  const first = await sendSession(
    workspace,
    session.id,
    'Discuss the author repository.',
    adapter,
  )
  await sendSession(
    workspace,
    session.id,
    'Continue with your second idea.',
    adapter,
  )
  const second = adapter.requests[1]!
  assert.ok(JSON.stringify(second).includes('SOURCE_CANARY'))
  assert.ok(JSON.stringify(second).includes(first.reply))
  assert.ok(JSON.stringify(second).includes('角色资料 voice.md'))
  assert.equal((await showSession(workspace, session.id)).messages.length, 4)
  const run = await showSessionRun(workspace, session.id, first.runId)
  assert.equal(run.run.status, 'completed')
  assert.equal(run.context.workRevision, 2)
  assert.equal(run.result?.audit?.executionDirectoryRemoved, true)
})

test('a generated proposal is saved with its real run origin and never auto-applied', async (t) => {
  const { workspace, work, session, adapter } = await fixture(
    await temporary(t),
  )
  adapter.proposal = 'draft'
  const result = await sendSession(
    workspace,
    session.id,
    'Write the draft.',
    adapter,
    { intent: 'draft' },
  )
  assert.ok(result.proposalId)
  assert.equal((await showWork(workspace, work.id)).draft, '')
  const proposal = JSON.parse(
    await readFile(
      path.join(
        workspace.root,
        'works',
        work.id,
        'proposals',
        `${result.proposalId}.json`,
      ),
      'utf8',
    ),
  ) as { origin: { type: string; runId: string } }
  assert.deepEqual(proposal.origin, {
    type: 'run',
    sessionId: session.id,
    runId: result.runId,
  })
  await applyProposal(workspace, work.id, result.proposalId, 1)
  assert.ok(
    (await showWork(workspace, work.id)).draft.includes('concrete observation'),
  )
})

test('retrying a completed send returns its original result without probing or invoking again', async (t) => {
  const { workspace, session, adapter } = await fixture(await temporary(t))
  const requestId = randomUUID()
  const first = await sendSession(workspace, session.id, 'Discuss', adapter, {
    requestId,
  })
  assert.deepEqual(
    await sendSession(workspace, session.id, 'Discuss', adapter, { requestId }),
    first,
  )
  assert.equal(adapter.requests.length, 1)
  assert.equal(adapter.probes, 1)
  await assert.rejects(
    sendSession(workspace, session.id, 'Different', adapter, { requestId }),
    { code: 'CONFLICT' },
  )
})

test('send request IDs share the workspace namespace with work mutations', async (t) => {
  const { workspace, session, adapter } = await fixture(await temporary(t))
  const requestId = randomUUID()
  await createWork(
    workspace,
    {
      title: 'Receipt owner',
      language: 'cn',
      kind: 'log',
      authors: ['person:parz1'],
    },
    { requestId },
  )
  await assert.rejects(
    sendSession(workspace, session.id, 'collision', adapter, { requestId }),
    { code: 'CONFLICT' },
  )
  assert.equal(adapter.probes, 0)
  assert.equal((await showSession(workspace, session.id)).messages.length, 0)
})

test('result corruption is detected before replay and input changes invalidate audit inspection', async (t) => {
  const { workspace, session, adapter } = await fixture(await temporary(t))
  const requestId = randomUUID()
  const result = await sendSession(workspace, session.id, 'audit', adapter, {
    requestId,
  })
  const root = path.join(
    workspace.root,
    'sessions',
    session.id,
    'runs',
    result.runId,
  )
  const record = JSON.parse(
    await readFile(path.join(root, 'result.json'), 'utf8'),
  ) as { reply: string }
  record.reply = 'altered'
  await writeFile(path.join(root, 'result.json'), JSON.stringify(record))
  await assert.rejects(
    sendSession(workspace, session.id, 'audit', adapter, { requestId }),
    { code: 'STORE_CORRUPT' },
  )
  assert.equal(adapter.requests.length, 1)
  const input = JSON.parse(
    await readFile(path.join(root, 'input.json'), 'utf8'),
  ) as { input: { digest: string } }
  input.input.digest = sha256('altered')
  await writeFile(path.join(root, 'input.json'), JSON.stringify(input))
  await assert.rejects(showSessionRun(workspace, session.id, result.runId), {
    code: 'STORE_CORRUPT',
  })
})

test('other sessions and private character state are not read into a new conversation', async (t) => {
  const { workspace, session, adapter } = await fixture(await temporary(t))
  await sendSession(
    workspace,
    session.id,
    'SESSION_A_PRIVATE_SENTINEL',
    adapter,
  )
  const second = await openSession(workspace, {
    characterId: 'koto',
    mode: 'conversation',
    language: 'cn',
  })
  await mkdir(path.join(workspace.root, 'states/koto'), { recursive: true })
  await writeFile(
    path.join(workspace.root, 'states/koto/private.txt'),
    'STATE_PRIVATE_SENTINEL',
  )
  await sendSession(workspace, second.id, 'Hello', adapter)
  const context = JSON.stringify(adapter.requests.at(-1))
  assert.equal(context.includes('SESSION_A_PRIVATE_SENTINEL'), false)
  assert.equal(context.includes('STATE_PRIVATE_SENTINEL'), false)
  assert.equal((await listSessions(workspace)).length, 2)
})

test('cancelled execution saves the user input, releases session ownership and permits a new request', async (t) => {
  const { workspace, session, adapter } = await fixture(await temporary(t))
  adapter.mode = 'throw'
  const requestId = randomUUID()
  await assert.rejects(
    sendSession(workspace, session.id, 'Cancel this', adapter, { requestId }),
    { code: 'CANCELLED' },
  )
  assert.equal(
    (await showSession(workspace, session.id)).session.activeRunId,
    undefined,
  )
  assert.equal((await showSession(workspace, session.id)).messages.length, 1)
  await assert.rejects(
    sendSession(workspace, session.id, 'Cancel this', adapter, { requestId }),
    { code: 'CANCELLED' },
  )
  assert.equal(adapter.requests.length, 1)
  adapter.mode = 'good'
  await sendSession(workspace, session.id, 'Try again', adapter)
  assert.equal((await showSession(workspace, session.id)).messages.length, 3)
})

test('unauthorized tools, duplicate terminal events and unknown sources are rejected atomically', async (t) => {
  const root = await temporary(t)
  for (const mode of ['tool', 'duplicate', 'bad-source'] as const) {
    const { workspace, work, session, adapter } = await fixture(
      path.join(root, mode),
    )
    adapter.mode = mode
    if (mode === 'bad-source') adapter.proposal = 'draft'
    await assert.rejects(
      sendSession(workspace, session.id, 'Test', adapter, {
        intent: mode === 'bad-source' ? 'draft' : 'discuss',
      }),
      { code: 'ADAPTER_PROTOCOL' },
    )
    assert.equal((await showWork(workspace, work.id)).record.revision, 1)
    assert.equal((await showSession(workspace, session.id)).messages.length, 1)
    assert.equal(
      (await showSession(workspace, session.id)).session.activeRunId,
      undefined,
    )
  }
})

test('a work edited during generation keeps the old-base proposal for explicit conflict handling', async (t) => {
  const { workspace, work, session, adapter } = await fixture(
    await temporary(t),
  )
  adapter.proposal = 'outline'
  adapter.afterStarted = async () => {
    await updateWork(workspace, work.id, 1, { title: 'Changed concurrently' })
  }
  const result = await sendSession(workspace, session.id, 'Outline', adapter, {
    intent: 'outline',
  })
  assert.ok(result.proposalId)
  await assert.rejects(
    applyProposal(workspace, work.id, result.proposalId, 2),
    { code: 'CONFLICT' },
  )
})

test('a running session rejects another send and closing, while other work remains writable', async (t) => {
  const { workspace, session, adapter } = await fixture(await temporary(t))
  adapter.afterStarted = async () => {
    await assert.rejects(
      sendSession(workspace, session.id, 'second', new FixtureAdapter()),
      { code: 'BUSY' },
    )
    await assert.rejects(setSessionStatus(workspace, session.id, 'closed'), {
      code: 'BUSY',
    })
  }
  await sendSession(workspace, session.id, 'first', adapter)
  await setSessionStatus(workspace, session.id, 'closed')
  await assert.rejects(sendSession(workspace, session.id, 'closed', adapter), {
    code: 'BUSY',
  })
  await setSessionStatus(workspace, session.id, 'open')
})

test('context overflow is explicit and does not claim a run or append a message', async (t) => {
  const { workspace, session, adapter } = await fixture(await temporary(t))
  await assert.rejects(
    sendSession(workspace, session.id, 'x'.repeat(50000), adapter),
    { code: 'CONTEXT_LIMIT' },
  )
  assert.equal((await showSession(workspace, session.id)).messages.length, 0)
  assert.equal(
    (await showSession(workspace, session.id)).session.activeRunId,
    undefined,
  )
})
