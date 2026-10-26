import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile, rename, symlink } from 'node:fs/promises'
import path from 'node:path'
import {
  initWorkspace,
  openWorkspace,
  workspaceStatus,
  createWork,
  addCharacter,
  showCharacter,
  listCharacters,
} from '@characters/core'
import { temporary, copyKoto, koto } from './helpers.ts'

test('initialization defaults to strict isolation and an unconfigured runtime', async (t) => {
  const root = await temporary(t)
  const workspace = await initWorkspace(path.join(root, 'writing'))
  const status = await workspaceStatus(await openWorkspace(workspace.root))
  assert.equal(status.policy.isolation, 'strict')
  assert.equal(status.adapter, 'unconfigured')
  assert.equal(status.executionImplemented, true)
  assert.equal(status.recovery, 'clean')
  assert.equal(
    await readFile(path.join(workspace.root, '.gitignore'), 'utf8'),
    '*\n!.gitignore\n',
  )
  await assert.rejects(initWorkspace(workspace.root), { code: 'CONFLICT' })
})

test('initialization preserves an unrelated nonempty directory', async (t) => {
  const root = await temporary(t)
  await writeFile(path.join(root, 'keep.txt'), 'unchanged')
  await assert.rejects(initWorkspace(root), { code: 'CONFLICT' })
  assert.equal(await readFile(path.join(root, 'keep.txt'), 'utf8'), 'unchanged')
})

test('installation is idempotent, snapshots are detached, and changes cannot replace a role', async (t) => {
  const root = await temporary(t)
  const workspace = await initWorkspace(path.join(root, 'writing'))
  const source = await copyKoto(root)
  const first = await addCharacter(workspace, source)
  const second = await addCharacter(workspace, source)
  assert.equal(first.unchanged, false)
  assert.equal(second.unchanged, true)
  assert.equal((await listCharacters(workspace)).length, 1)
  await writeFile(path.join(source, 'voice.md'), 'new contents')
  assert.equal(
    (await showCharacter(workspace, 'koto')).digest,
    first.installed.digest,
  )
  await assert.rejects(addCharacter(workspace, source), { code: 'CONFLICT' })
  assert.equal((await listCharacters(workspace)).length, 1)
})

test('installed snapshot tampering is detected before use', async (t) => {
  const root = await temporary(t)
  const workspace = await initWorkspace(path.join(root, 'writing'))
  const { installed } = await addCharacter(workspace, koto)
  await writeFile(
    path.join(workspace.root, path.dirname(installed.manifestRef), 'voice.md'),
    'tampered',
  )
  await assert.rejects(showCharacter(workspace, 'koto'), {
    code: 'STORE_CORRUPT',
  })
  await assert.rejects(addCharacter(workspace, koto), { code: 'STORE_CORRUPT' })
})

test('workspaces have distinct IDs and do not discover each other', async (t) => {
  const root = await temporary(t)
  const a = await initWorkspace(path.join(root, 'a'))
  const b = await initWorkspace(path.join(root, 'b'))
  await addCharacter(a, koto)
  assert.notEqual(a.config.id, b.config.id)
  assert.equal((await listCharacters(a)).length, 1)
  assert.equal((await listCharacters(b)).length, 0)
})

test('a write lock blocks installation instead of being removed automatically', async (t) => {
  const workspace = await initWorkspace(
    path.join(await temporary(t), 'writing'),
  )
  await writeFile(
    path.join(workspace.root, '.runtime/write.lock'),
    'active-or-stale',
  )
  await assert.rejects(addCharacter(workspace, koto), { code: 'BUSY' })
  assert.equal(
    await readFile(path.join(workspace.root, '.runtime/write.lock'), 'utf8'),
    'active-or-stale',
  )
})

test('partial initialization and unknown data versions fail closed', async (t) => {
  const root = await temporary(t)
  const partial = path.join(root, 'partial')
  await mkdir(partial)
  await writeFile(path.join(partial, '.initializing'), '')
  await assert.rejects(openWorkspace(partial), { code: 'RECOVERY_REQUIRED' })
  const workspace = await initWorkspace(path.join(root, 'valid'))
  const filename = path.join(workspace.root, 'workspace.yaml')
  const config = await readFile(filename, 'utf8')
  await writeFile(
    filename,
    config.replace('schemaVersion: 1', 'schemaVersion: 2'),
  )
  await assert.rejects(openWorkspace(workspace.root), { code: 'STORE_CORRUPT' })
})

test('junction in a workspace cannot redirect installation writes outside the root', async (t) => {
  const root = await temporary(t)
  const workspace = await initWorkspace(path.join(root, 'writing'))
  const original = path.join(workspace.root, '.runtime')
  await rename(original, path.join(workspace.root, 'runtime-old'))
  const outside = path.join(root, 'outside')
  await mkdir(outside)
  await symlink(outside, original, 'junction')
  await assert.rejects(addCharacter(workspace, koto), {
    code: 'PERMISSION_DENIED',
  })
  await assert.rejects(openWorkspace(workspace.root), {
    code: 'PERMISSION_DENIED',
  })
})

test('a previously opened root cannot be replaced by a junction before writes', async (t) => {
  const root = await temporary(t)
  const workspace = await initWorkspace(path.join(root, 'writing'))
  await rename(workspace.root, path.join(root, 'writing-old'))
  const outside = path.join(root, 'outside')
  await mkdir(outside)
  await symlink(outside, workspace.root, 'junction')
  await assert.rejects(addCharacter(workspace, koto), {
    code: 'PERMISSION_DENIED',
  })
})

test('a stale handle cannot write to a different ordinary workspace at the same path', async (t) => {
  const root = await temporary(t)
  const a = await initWorkspace(path.join(root, 'a'))
  const b = await initWorkspace(path.join(root, 'b'))
  await rename(a.root, path.join(root, 'a-old'))
  await rename(b.root, a.root)
  await assert.rejects(
    createWork(a, {
      title: 'wrong workspace',
      language: 'cn',
      kind: 'log',
      authors: ['person:parz1'],
    }),
    { code: 'PERMISSION_DENIED' },
  )
})
