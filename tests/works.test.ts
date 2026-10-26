import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  mkdir,
  writeFile,
  readFile,
  readdir,
  rename,
  symlink,
  link,
  unlink,
} from 'node:fs/promises'
import path from 'node:path'
import {
  initWorkspace,
  createWork,
  showWork,
  updateWork,
  importSource,
  addProposal,
  listProposals,
  applyProposal,
  CharactersError,
} from '@characters/core'
import { temporary } from './helpers.ts'

const input = {
  title: 'Initial',
  language: 'cn' as const,
  kind: 'log' as const,
  authors: ['person:parz1'],
}

test('work versions preserve metadata, body and source provenance', async (t) => {
  const workspace = await initWorkspace(path.join(await temporary(t), 'data'))
  const work = await createWork(workspace, input)
  assert.equal(work.revision, 1)
  const imported = await importSource(workspace, work.id, {
    title: 'notes',
    text: 'actual notes',
    visibility: 'publishable',
    expectedRevision: 1,
  })
  assert.equal(imported.work.revision, 2)
  await updateWork(workspace, work.id, 2, {
    title: 'Revised',
    briefSourceId: imported.source.id,
  })
  const latest = await showWork(workspace, work.id)
  assert.equal(latest.record.revision, 3)
  assert.equal(latest.record.title, 'Revised')
  assert.equal(latest.brief, 'actual notes')
  assert.equal(latest.sources[0]?.visibility, 'publishable')
  const initial = await showWork(workspace, work.id, 1)
  assert.equal(initial.record.title, 'Initial')
  assert.deepEqual(initial.sources, [])
  assert.equal(initial.brief, '')
})

test('stale metadata and proposals conflict without overwriting revisions', async (t) => {
  const workspace = await initWorkspace(path.join(await temporary(t), 'data'))
  const work = await createWork(workspace, input)
  const a = await addProposal(workspace, work.id, 1, {
    target: 'draft',
    content: 'first draft',
    sourceIds: [],
  })
  const b = await addProposal(workspace, work.id, 1, {
    target: 'draft',
    content: 'second draft',
    sourceIds: [],
  })
  await applyProposal(workspace, work.id, a.id, 1)
  await assert.rejects(applyProposal(workspace, work.id, b.id, 1), {
    code: 'CONFLICT',
  })
  await assert.rejects(applyProposal(workspace, work.id, b.id, 2), {
    code: 'CONFLICT',
  })
  await assert.rejects(
    updateWork(workspace, work.id, 1, { title: 'overwrite' }),
    { code: 'CONFLICT' },
  )
  assert.equal((await showWork(workspace, work.id)).draft, 'first draft')
  assert.equal((await listProposals(workspace, work.id)).length, 2)
})

test('request receipts deduplicate create, import and apply; mismatched payload conflicts', async (t) => {
  const workspace = await initWorkspace(path.join(await temporary(t), 'data'))
  const createOptions = { requestId: randomUUID() }
  const first = await createWork(workspace, input, createOptions)
  assert.deepEqual(await createWork(workspace, input, createOptions), first)
  await assert.rejects(
    createWork(workspace, { ...input, title: 'different' }, createOptions),
    { code: 'CONFLICT' },
  )
  const sourceOptions = { requestId: randomUUID() }
  const notes = { title: 'notes', text: 'source material', expectedRevision: 1 }
  const source = await importSource(workspace, first.id, notes, sourceOptions)
  assert.deepEqual(
    await importSource(workspace, first.id, notes, sourceOptions),
    source,
  )
  const proposal = await addProposal(workspace, first.id, 2, {
    target: 'draft',
    content: 'draft',
    sourceIds: [source.source.id],
  })
  const applyOptions = { requestId: randomUUID() }
  const applied = await applyProposal(
    workspace,
    first.id,
    proposal.id,
    2,
    applyOptions,
  )
  assert.deepEqual(
    await applyProposal(workspace, first.id, proposal.id, 2, applyOptions),
    applied,
  )
  assert.equal((await showWork(workspace, first.id)).record.revision, 3)
  assert.equal((await readdir(path.join(workspace.root, 'works'))).length, 1)
})

test('explicitly imported sources default private and cannot be borrowed from another work', async (t) => {
  const workspace = await initWorkspace(path.join(await temporary(t), 'data'))
  const a = await createWork(workspace, input)
  const b = await createWork(workspace, input)
  const { source } = await importSource(workspace, a.id, {
    title: 'private',
    text: 'private notes',
  })
  assert.equal(source.visibility, 'private')
  await assert.rejects(
    updateWork(workspace, b.id, 1, { briefSourceId: source.id }),
    { code: 'NOT_FOUND' },
  )
  await assert.rejects(
    addProposal(workspace, b.id, 1, {
      target: 'draft',
      content: 'borrowed',
      sourceIds: [source.id],
    }),
    { code: 'NOT_FOUND' },
  )
  assert.equal((await showWork(workspace, b.id)).record.revision, 1)
})

test('ready requires a separate decision, and later changes invalidate it', async (t) => {
  const workspace = await initWorkspace(path.join(await temporary(t), 'data'))
  const work = await createWork(workspace, input)
  await assert.rejects(
    updateWork(workspace, work.id, 1, { title: 'change', stage: 'ready' }),
    { code: 'INVALID_INPUT' },
  )
  await updateWork(workspace, work.id, 1, { stage: 'ready' })
  await updateWork(workspace, work.id, 2, { title: 'changed after review' })
  assert.equal((await showWork(workspace, work.id)).record.stage, 'review')
})

test('current metadata, current body and historical manifests detect tampering', async (t) => {
  const root = await temporary(t)
  for (const target of ['metadata', 'body', 'history']) {
    const workspace = await initWorkspace(path.join(root, target))
    const work = await createWork(workspace, input)
    await updateWork(workspace, work.id, 1, { title: 'second' })
    const base = path.join(workspace.root, 'works', work.id)
    if (target === 'metadata') {
      const filename = path.join(base, 'work.json')
      const record = JSON.parse(await readFile(filename, 'utf8')) as Record<
        string,
        unknown
      >
      await writeFile(
        filename,
        JSON.stringify({ ...record, title: 'tampered' }),
      )
    } else if (target === 'body')
      await writeFile(path.join(base, 'revisions/2/draft.md'), 'tampered')
    else await writeFile(path.join(base, 'revisions/1/revision.json'), '{}')
    await assert.rejects(
      showWork(workspace, work.id, target === 'history' ? 1 : undefined),
      { code: 'STORE_CORRUPT' },
    )
  }
})

test('source contents are immutable snapshots and are checked on read', async (t) => {
  const workspace = await initWorkspace(path.join(await temporary(t), 'data'))
  const work = await createWork(workspace, input)
  const { source } = await importSource(workspace, work.id, {
    title: 'notes',
    text: 'original',
  })
  await writeFile(path.join(workspace.root, source.snapshotRef), 'changed')
  await assert.rejects(showWork(workspace, work.id), { code: 'STORE_CORRUPT' })
})

test('missing revision files and corrupted receipts stop without creating replacements', async (t) => {
  const workspace = await initWorkspace(path.join(await temporary(t), 'data'))
  const requestId = randomUUID()
  const work = await createWork(workspace, input, { requestId })
  await unlink(
    path.join(workspace.root, 'works', work.id, 'revisions/1/draft.md'),
  )
  await assert.rejects(showWork(workspace, work.id), { code: 'STORE_CORRUPT' })
  const filename = path.join(
    workspace.root,
    '.runtime/receipts',
    `${requestId}.json`,
  )
  const receipt = JSON.parse(await readFile(filename, 'utf8')) as {
    result: unknown
  }
  receipt.result = { altered: true }
  await writeFile(filename, JSON.stringify(receipt))
  await assert.rejects(createWork(workspace, input, { requestId }), {
    code: 'STORE_CORRUPT',
  })
  assert.equal((await readdir(path.join(workspace.root, 'works'))).length, 1)
})

test('simultaneous writers never overwrite the winning revision', async (t) => {
  const workspace = await initWorkspace(path.join(await temporary(t), 'data'))
  const work = await createWork(workspace, input)
  const results = await Promise.allSettled([
    updateWork(workspace, work.id, 1, { title: 'a' }),
    updateWork(workspace, work.id, 1, { title: 'b' }),
  ])
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  )
  const rejected = results.find((result) => result.status === 'rejected')
  assert.ok(
    rejected?.status === 'rejected' &&
      rejected.reason instanceof CharactersError,
  )
  assert.ok(['BUSY', 'CONFLICT'].includes(rejected.reason.code))
  assert.equal((await showWork(workspace, work.id)).record.revision, 2)
})

test('source writes reject junctions, and record reads reject hard links', async (t) => {
  const root = await temporary(t)
  const workspace = await initWorkspace(path.join(root, 'data'))
  const work = await createWork(workspace, input)
  const outside = path.join(root, 'outside')
  await mkdir(outside)
  await rename(
    path.join(workspace.root, 'objects'),
    path.join(workspace.root, 'objects-old'),
  )
  await symlink(outside, path.join(workspace.root, 'objects'), 'junction')
  await assert.rejects(
    importSource(workspace, work.id, { title: 'escape', text: 'no' }),
    { code: 'PERMISSION_DENIED' },
  )
  assert.deepEqual(await readdir(outside), [])
  const workFile = path.join(workspace.root, 'works', work.id, 'work.json')
  await link(workFile, path.join(outside, 'linked.json'))
  await assert.rejects(showWork(workspace, work.id), {
    code: 'PERMISSION_DENIED',
  })
})
