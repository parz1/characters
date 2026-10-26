import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile, unlink, mkdir, symlink } from 'node:fs/promises'
import path from 'node:path'
import { loadCharacter, CharactersError } from '@characters/core'
import { temporary, copyKoto, koto } from './helpers.ts'

test('Koto has complete, deterministic, independently addressed role documents', async () => {
  const first = await loadCharacter(koto)
  const second = await loadCharacter(koto)
  assert.equal(first.digest, second.digest)
  assert.equal(first.manifest.id, 'koto')
  assert.deepEqual(first.manifest.languages, ['cn', 'ja', 'en'])
  assert.equal(first.files.size, 9)
  const samples =
    first.files.get(first.manifest.examples.good)?.toString('utf8') ?? ''
  for (const marker of ['post', 'log', 'crap', '虚构'])
    assert.ok(samples.includes(marker))
})

test('digest covers all installed bytes and does not depend on directory location', async (t) => {
  const root = await temporary(t)
  const source = await copyKoto(root)
  const before = await loadCharacter(source)
  assert.equal(before.digest, (await loadCharacter(koto)).digest)
  await writeFile(path.join(source, 'voice.md'), '不同的声音\n')
  assert.notEqual((await loadCharacter(source)).digest, before.digest)
})

test('a missing referenced sample rejects the whole package', async (t) => {
  const source = await copyKoto(await temporary(t))
  await unlink(path.join(source, 'examples/bad.md'))
  await assert.rejects(loadCharacter(source), { code: 'INVALID_INPUT' })
})

test('unlisted memory and executable files are never silently packaged', async (t) => {
  const source = await copyKoto(await temporary(t))
  await writeFile(path.join(source, 'MEMORY.md'), '私人经历')
  await assert.rejects(loadCharacter(source), { code: 'INVALID_INPUT' })
})

test('unknown schema versions, duplicate YAML keys and aliases are rejected', async (t) => {
  const source = await copyKoto(await temporary(t))
  const filename = path.join(source, 'character.yaml')
  const original = await readFile(filename, 'utf8')
  for (const invalid of [
    original.replace('schemaVersion: 1', 'schemaVersion: 2'),
    `${original}\nid: other\n`,
    original.replace('name: koto chan', 'name: &name koto\nextra: *name'),
  ]) {
    await writeFile(filename, invalid)
    await assert.rejects(loadCharacter(source), { code: 'INVALID_INPUT' })
  }
})

test('manifest cannot escape to external files or grant execution permissions', async (t) => {
  const source = await copyKoto(await temporary(t))
  const filename = path.join(source, 'character.yaml')
  const original = await readFile(filename, 'utf8')
  for (const invalid of [
    original.replace('persona: persona.md', 'persona: ../outside.md'),
    `${original}\ntools: [shell]\n`,
  ]) {
    await writeFile(filename, invalid)
    await assert.rejects(loadCharacter(source), { code: 'INVALID_INPUT' })
  }
})

test('case aliases and inconsistent language declarations are rejected before installation', async (t) => {
  const source = await copyKoto(await temporary(t))
  const filename = path.join(source, 'character.yaml')
  const original = await readFile(filename, 'utf8')
  for (const invalid of [
    original.replace(
      'relationships: relationships.md',
      'relationships: VOICE.md',
    ),
    original.replace('languages: [cn, ja, en]', 'languages: [ja, en]'),
    original.replace('languages: [cn, ja, en]', 'languages: [cn, cn, en]'),
  ]) {
    await writeFile(filename, invalid)
    await assert.rejects(loadCharacter(source), { code: 'INVALID_INPUT' })
  }
})

test('oversized and invalid UTF-8 content is rejected', async (t) => {
  const source = await copyKoto(await temporary(t))
  const voice = path.join(source, 'voice.md')
  await writeFile(voice, Buffer.alloc(128 * 1024 + 1, 65))
  await assert.rejects(loadCharacter(source), { code: 'INVALID_INPUT' })
  await writeFile(voice, Buffer.from([0xc3, 0x28]))
  await assert.rejects(loadCharacter(source), { code: 'INVALID_INPUT' })
})

test('directory junctions cannot import undeclared external contents', async (t) => {
  const root = await temporary(t)
  const source = await copyKoto(root)
  const outside = path.join(root, 'outside')
  await mkdir(outside)
  await writeFile(path.join(outside, 'private.md'), 'DO_NOT_IMPORT')
  await symlink(outside, path.join(source, 'linked'), 'junction')
  await assert.rejects(
    loadCharacter(source),
    (error: unknown) =>
      error instanceof CharactersError && error.code === 'PERMISSION_DENIED',
  )
  assert.equal(
    await readFile(path.join(outside, 'private.md'), 'utf8'),
    'DO_NOT_IMPORT',
  )
})
