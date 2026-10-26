import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { hostname } from 'node:os'
import {
  initWorkspace,
  openWorkspace,
  createWork,
  showWork,
  updateWork,
  addCharacter,
  showCharacter,
  addProposal,
  applyProposal,
  importSource,
  workspaceStatus,
  withStore,
  sha256,
} from '@characters/core'
import { temporary, repository, koto } from './helpers.ts'

const execute = promisify(execFile)
const worker = path.join(repository, 'tests/fixtures/crash-worker.mjs')
const input = {
  title: 'crash-test',
  language: 'cn' as const,
  kind: 'log' as const,
  authors: ['person:parz1'],
}
async function crash(
  workspace: string,
  action: string,
  boundary: string,
  index = '-',
  requestId = '-',
  objectId = '-',
  argument = '-',
) {
  try {
    await execute(
      process.execPath,
      [
        worker,
        workspace,
        action,
        boundary,
        index,
        requestId,
        objectId,
        argument,
      ],
      { timeout: 15000 },
    )
    assert.fail('child must exit at a checkpoint')
  } catch (error) {
    assert.ok(error instanceof Error && 'code' in error)
    assert.equal(error.code, 86, String(error))
  }
}

const boundaries: Array<[string, string]> = [
  ['locked', '-'],
  ['staged', '-'],
  ['prepared', '-'],
  ...Array.from({ length: 7 }, (_, i): [string, string] => [
    'applied',
    String(i),
  ]),
  ['committed', '-'],
]
for (const [boundary, index] of boundaries) {
  test(`abrupt create exit at ${boundary}/${index} recovers a complete result and request receipt`, async (t) => {
    const workspace = await initWorkspace(path.join(await temporary(t), 'data'))
    const requestId = randomUUID()
    await crash(workspace.root, 'create', boundary, index, requestId)
    const recovered = await openWorkspace(workspace.root)
    const names = await readdir(path.join(recovered.root, 'works'))
    const committed = !['locked', 'staged'].includes(boundary)
    assert.equal(names.length, committed ? 1 : 0)
    const record = await createWork(recovered, input, { requestId })
    assert.equal((await showWork(recovered, record.id)).record.revision, 1)
    assert.equal((await readdir(path.join(recovered.root, 'works'))).length, 1)
    assert.deepEqual(await createWork(recovered, input, { requestId }), record)
    assert.equal((await workspaceStatus(recovered)).recovery, 'clean')
  })
}

test('update interrupted after pointer replacement recovers once and preserves version one', async (t) => {
  const workspace = await initWorkspace(path.join(await temporary(t), 'data'))
  const work = await createWork(workspace, input)
  const requestId = randomUUID()
  await crash(workspace.root, 'update', 'applied', '5', requestId, work.id)
  const recovered = await openWorkspace(workspace.root)
  const result = await updateWork(
    recovered,
    work.id,
    1,
    { title: 'updated' },
    { requestId },
  )
  assert.equal(result.revision, 2)
  assert.equal(
    (await showWork(recovered, work.id, 1)).record.title,
    'crash-test',
  )
  assert.equal((await showWork(recovered, work.id)).record.title, 'updated')
})

test('recovery itself can be interrupted repeatedly and remains idempotent', async (t) => {
  const workspace = await initWorkspace(path.join(await temporary(t), 'data'))
  const requestId = randomUUID()
  await crash(workspace.root, 'create', 'prepared', '-', requestId)
  await crash(workspace.root, 'recover', 'applied', '0')
  await crash(workspace.root, 'recover', 'applied', '4')
  const recovered = await openWorkspace(workspace.root)
  const work = await createWork(recovered, input, { requestId })
  assert.equal(work.revision, 1)
  assert.equal((await showWork(recovered, work.id)).record.id, work.id)
})

test('initialization has a recoverable plan before any workspace files exist', async (t) => {
  const root = await temporary(t)
  for (const boundary of [
    'locked',
    'staged',
    'prepared',
    'applied',
    'committed',
  ]) {
    const directory = path.join(root, boundary)
    await crash(directory, 'init', boundary, boundary === 'applied' ? '0' : '-')
    const workspace = await openWorkspace(directory)
    assert.equal((await workspaceStatus(workspace)).recovery, 'clean')
  }
})

test('character installation, source import and proposal apply recover their complete units', async (t) => {
  const root = await temporary(t)
  const workspace = await initWorkspace(path.join(root, 'data'))
  const roleRequest = randomUUID()
  await crash(workspace.root, 'character', 'applied', '0', roleRequest, koto)
  const recovered = await openWorkspace(workspace.root)
  assert.equal((await showCharacter(recovered, 'koto')).manifest.id, 'koto')
  assert.equal(
    (await addCharacter(recovered, koto, { requestId: roleRequest })).unchanged,
    false,
  )
  const work = await createWork(recovered, input)
  const proposal = await addProposal(recovered, work.id, 1, {
    target: 'draft',
    content: 'complete draft',
    sourceIds: [],
  })
  const requestId = randomUUID()
  await crash(
    workspace.root,
    'apply',
    'applied',
    '2',
    requestId,
    work.id,
    proposal.id,
  )
  const again = await openWorkspace(workspace.root)
  assert.equal(
    (await applyProposal(again, work.id, proposal.id, 1, { requestId }))
      .revision,
    2,
  )
  assert.equal((await showWork(again, work.id)).draft, 'complete draft')
  const second = await createWork(again, input)
  const sourceRequest = randomUUID()
  await crash(
    workspace.root,
    'source',
    'applied',
    '0',
    sourceRequest,
    second.id,
  )
  const last = await openWorkspace(workspace.root)
  const imported = await importSource(
    last,
    second.id,
    { title: 'source', text: 'snapshot source', expectedRevision: 1 },
    { requestId: sourceRequest },
  )
  assert.equal(imported.work.revision, 2)
  assert.equal((await showWork(last, second.id)).sources.length, 1)
})

test('readers see BUSY while a transaction is partially applied', async (t) => {
  const workspace = await initWorkspace(path.join(await temporary(t), 'data'))
  const work = await createWork(workspace, input)
  let checked = false
  await updateWork(
    workspace,
    work.id,
    1,
    { title: 'new' },
    {
      checkpoint: async (boundary, index) => {
        if (boundary === 'applied' && index === 0) {
          await assert.rejects(showWork(workspace, work.id), { code: 'BUSY' })
          checked = true
        }
      },
    },
  )
  assert.ok(checked)
  assert.equal((await showWork(workspace, work.id)).record.title, 'new')
})

test('corrupt prepared WAL, foreign workspace WAL and unapproved targets fail closed', async (t) => {
  const root = await temporary(t)
  for (const corruption of ['checksum', 'foreign', 'target', 'truncated']) {
    const workspace = await initWorkspace(path.join(root, corruption))
    await crash(workspace.root, 'create', 'prepared', '-', randomUUID())
    const transactions = path.join(workspace.root, '.runtime/transactions')
    const name = (await readdir(transactions))[0]!
    const filename = path.join(transactions, name, 'journal.json')
    const journal = JSON.parse(await readFile(filename, 'utf8')) as {
      workspaceId: string
      operations: Array<{ ref: string; after: string }>
    }
    if (corruption === 'checksum')
      journal.operations[0]!.after = sha256('not the payload')
    if (corruption === 'foreign')
      journal.workspaceId = (
        await initWorkspace(path.join(root, 'other'))
      ).config.id
    if (corruption === 'target')
      journal.operations[0]!.ref = 'contexts/unapproved.md'
    await writeFile(
      filename,
      corruption === 'truncated' ? '{' : JSON.stringify(journal),
    )
    await assert.rejects(openWorkspace(workspace.root), {
      code: corruption === 'target' ? 'PERMISSION_DENIED' : 'STORE_CORRUPT',
    })
    assert.deepEqual(await readdir(path.join(workspace.root, 'works')), [])
    assert.ok((await readFile(filename)).length)
  }
})

test('a changed destination is never overwritten by recovery', async (t) => {
  const workspace = await initWorkspace(path.join(await temporary(t), 'data'))
  await crash(workspace.root, 'create', 'applied', '0', randomUUID())
  const workId = (await readdir(path.join(workspace.root, 'works')))[0]!
  const filename = path.join(
    workspace.root,
    'works',
    workId,
    'revisions/1/brief.md',
  )
  await writeFile(filename, 'external modification')
  await assert.rejects(openWorkspace(workspace.root), { code: 'STORE_CORRUPT' })
  assert.equal(await readFile(filename, 'utf8'), 'external modification')
})

test('an external edit between staging and applying is preserved rather than overwritten', async (t) => {
  const workspace = await initWorkspace(path.join(await temporary(t), 'data'))
  const work = await createWork(workspace, input)
  const filename = path.join(workspace.root, 'works', work.id, 'work.json')
  const edited = { ...work, title: 'external edit' }
  await assert.rejects(
    updateWork(
      workspace,
      work.id,
      1,
      { title: 'our edit' },
      {
        checkpoint: async (boundary) => {
          if (boundary === 'staged')
            await writeFile(filename, JSON.stringify(edited))
        },
      },
    ),
    { code: 'STORE_CORRUPT' },
  )
  assert.equal(
    JSON.parse(await readFile(filename, 'utf8')).title,
    'external edit',
  )
  await assert.rejects(openWorkspace(workspace.root), { code: 'STORE_CORRUPT' })
})

test('live and foreign-host lock owners cannot be stolen', async (t) => {
  const root = await temporary(t)
  for (const host of [hostname(), 'different-host.invalid']) {
    const workspace = await initWorkspace(
      path.join(root, host === hostname() ? 'live' : 'foreign'),
    )
    const lock = path.join(workspace.root, '.runtime/write.lock')
    await mkdir(lock)
    const owner = {
      schemaVersion: 1,
      token: randomUUID(),
      pid: process.pid,
      host,
      createdAt: new Date(0).toISOString(),
    }
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify(owner))
    await assert.rejects(openWorkspace(workspace.root), { code: 'BUSY' })
    assert.equal(
      JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8')).token,
      owner.token,
    )
  }
})

test('storage API rejects arbitrary paths and does not write before prepare', async (t) => {
  const workspace = await initWorkspace(path.join(await temporary(t), 'data'))
  await assert.rejects(
    withStore(workspace, async (transaction) => {
      await transaction.put('../escape', Buffer.from('no'))
      return null
    }),
    { code: 'PERMISSION_DENIED' },
  )
  await assert.rejects(
    withStore(workspace, async (transaction) => {
      await transaction.put('contexts/unapproved.md', Buffer.from('no'))
      return null
    }),
    { code: 'PERMISSION_DENIED' },
  )
  assert.deepEqual(await readdir(path.join(workspace.root, 'contexts')), [])
})

test('conflicting targets in one transaction are rejected before preparing a WAL', async (t) => {
  const workspace = await initWorkspace(path.join(await temporary(t), 'data'))
  const ref = `objects/${sha256('same')}.txt`
  await assert.rejects(
    withStore(workspace, async (transaction) => {
      await transaction.put(ref, Buffer.from('one'))
      await transaction.put(ref, Buffer.from('two'))
      return null
    }),
    { code: 'INVALID_INPUT' },
  )
  assert.deepEqual(await readdir(path.join(workspace.root, 'objects')), [])
  assert.equal((await workspaceStatus(workspace)).recovery, 'clean')
})
