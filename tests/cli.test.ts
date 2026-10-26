import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { writeFile, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { temporary, koto, repository } from './helpers.ts'

const execute = promisify(execFile)
const cli = path.join(repository, 'packages/cli/dist/index.js')

test('CLI can initialize, install, list and inspect a role using JSON', async (t) => {
  const workspace = path.join(await temporary(t), 'data')
  const invoke = async (...args: string[]) => {
    const { stdout, stderr } = await execute(process.execPath, [
      cli,
      ...args,
      '--json',
    ])
    assert.equal(stderr, '')
    const result = JSON.parse(stdout) as {
      ok: boolean
      data: Record<string, unknown>
    }
    assert.equal(result.ok, true)
    return result.data
  }
  await invoke('workspace', 'init', workspace)
  await invoke('character', 'add', koto, '--workspace', workspace)
  const role = await invoke(
    'character',
    'show',
    'koto',
    '--workspace',
    workspace,
  )
  assert.equal(role.characterId, 'koto')
  const status = await invoke('workspace', 'status', '--workspace', workspace)
  assert.equal(status.recovery, 'clean')
  const roles = await invoke('character', 'list', '--workspace', workspace)
  assert.equal(Array.isArray(roles), true)
  const session = await invoke(
    'session',
    'open',
    '--character',
    'koto',
    '--workspace',
    workspace,
  )
  assert.equal(session.mode, 'conversation')
  await invoke('session', 'close', String(session.id), '--workspace', workspace)
  await invoke(
    'session',
    'resume',
    String(session.id),
    '--workspace',
    workspace,
  )
  const view = await invoke(
    'session',
    'show',
    String(session.id),
    '--workspace',
    workspace,
  )
  assert.equal((view.session as { status: string }).status, 'open')
})

test('CLI rejects an explicitly empty workspace instead of silently choosing a default', async () => {
  try {
    await execute(process.execPath, [
      cli,
      'character',
      'list',
      '--workspace',
      '',
      '--json',
    ])
    assert.fail('must fail')
  } catch (error) {
    assert.ok(error instanceof Error && 'code' in error && 'stdout' in error)
    assert.equal(error.code, 2)
    const result = JSON.parse(String(error.stdout)) as {
      ok: boolean
      error: { code: string }
    }
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'INVALID_INPUT')
  }
})

test('help is available without writing data, and unsupported commands do not pretend to work', async () => {
  const { stdout } = await execute(process.execPath, [cli, '--help'])
  assert.ok(stdout.includes('尚未实现'))
  await assert.rejects(
    execute(process.execPath, [
      cli,
      'session',
      'export',
      'ses_unknown',
      '--json',
    ]),
  )
})

test('CLI imports Unicode filenames, revises works, applies proposals and deduplicates retries', async (t) => {
  const root = await temporary(t)
  const workspace = path.join(root, 'data')
  const invoke = async (...args: string[]) => {
    const { stdout, stderr } = await execute(process.execPath, [
      cli,
      ...args,
      '--json',
    ])
    assert.equal(stderr, '')
    return (JSON.parse(stdout) as { data: Record<string, unknown> }).data
  }
  await invoke('workspace', 'init', workspace)
  const request = randomUUID()
  const create = [
    'work',
    'create',
    '--title',
    'CLI work',
    '--author',
    'person:parz1',
    '--lang',
    'cn',
    '--kind',
    'log',
    '--request-id',
    request,
    '--workspace',
    workspace,
  ]
  const record = await invoke(...create)
  assert.deepEqual(await invoke(...create), record)
  const id = String(record.id)
  const filename = path.join(root, '资料 notes.txt')
  await writeFile(filename, 'source snapshot')
  const imported = await invoke(
    'work',
    'source',
    'add',
    id,
    '--file',
    filename,
    '--title',
    'notes',
    '--visibility',
    'publishable',
    '--expect-revision',
    '1',
    '--workspace',
    workspace,
  )
  const source = imported.source as { id: string; visibility: string }
  assert.equal(source.visibility, 'publishable')
  await writeFile(filename, 'changed externally')
  const patch = path.join(root, 'patch.json')
  await writeFile(patch, JSON.stringify({ briefSourceId: source.id }))
  await invoke(
    'work',
    'update',
    id,
    '--patch',
    patch,
    '--expect-revision',
    '2',
    '--workspace',
    workspace,
  )
  const proposalFile = path.join(root, 'proposal.json')
  await writeFile(
    proposalFile,
    JSON.stringify({
      target: 'draft',
      content: '完整草稿',
      sourceIds: [source.id],
    }),
  )
  const proposal = await invoke(
    'work',
    'proposal',
    'add',
    id,
    '--file',
    proposalFile,
    '--expect-revision',
    '3',
    '--workspace',
    workspace,
  )
  const applyRequest = randomUUID()
  const apply = [
    'work',
    'apply',
    id,
    '--proposal',
    String(proposal.id),
    '--expect-revision',
    '3',
    '--request-id',
    applyRequest,
    '--workspace',
    workspace,
  ]
  const applied = await invoke(...apply)
  assert.deepEqual(await invoke(...apply), applied)
  const view = await invoke('work', 'show', id, '--workspace', workspace)
  assert.equal(view.draft, '完整草稿')
  assert.equal(view.brief, 'source snapshot')
  const previous = await invoke(
    'work',
    'show',
    id,
    '--revision',
    '1',
    '--workspace',
    workspace,
  )
  assert.equal(previous.brief, '')
  await invoke('work', 'proposal', 'list', id, '--workspace', workspace)
  assert.equal(
    (await invoke('workspace', 'recover', '--workspace', workspace)).recovery,
    'clean',
  )
  assert.equal(await readFile(filename, 'utf8'), 'changed externally')
  await assert.rejects(
    execute(process.execPath, [
      cli,
      'work',
      'update',
      id,
      '--patch',
      patch,
      '--expect-revision',
      '1',
      '--workspace',
      workspace,
      '--json',
    ]),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 4,
  )
})

test('CLI rejects ignored or incompatible flags rather than silently dropping them', async (t) => {
  const workspace = path.join(await temporary(t), 'data')
  await execute(process.execPath, [cli, 'workspace', 'init', workspace])
  await assert.rejects(
    execute(process.execPath, [
      cli,
      'workspace',
      'status',
      '--workspace',
      workspace,
      '--request-id',
      randomUUID(),
      '--json',
    ]),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 2,
  )
})
