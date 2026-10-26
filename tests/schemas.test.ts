import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  newId,
  utcNow,
  utcSchema,
  idSchema,
  sha256,
  relativePathSchema,
  sessionSchema,
  memorySchema,
  messageSchema,
  validate,
  failure,
  CharactersError,
  workspaceSchema,
  adapterCapabilitiesSchema,
  schemaDocuments,
  sourceSchema,
} from '@characters/core'

test('typed IDs and UTC timestamps reject mismatched domains and offsets', () => {
  assert.ok(idSchema('ses').safeParse(newId('ses')).success)
  assert.equal(idSchema('ses').safeParse(newId('work')).success, false)
  assert.ok(utcSchema.safeParse(utcNow()).success)
  assert.equal(utcSchema.safeParse('2026-10-25T12:00:00+09:00').success, false)
  assert.equal(utcSchema.safeParse('2026-02-30T00:00:00Z').success, false)
  assert.equal(
    sha256('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
})

test('portable references reject traversal, drive paths, streams and Windows special names', () => {
  for (const reference of [
    '../private.md',
    'examples/../../private.md',
    '/etc/passwd',
    'C:/private',
    'a\\b',
    'a//b',
    'a/./b',
    'a/NUL.md',
    'CON',
    'x/aux',
    'a/file:stream',
    'a/trailing.',
    'a/..',
  ]) {
    assert.equal(
      relativePathSchema.safeParse(reference).success,
      false,
      reference,
    )
  }
  for (const reference of [
    'persona.md',
    'examples/good.md',
    '.runtime/write.lock',
    'packages/koto/abc/character.yaml',
  ]) {
    assert.ok(relativePathSchema.safeParse(reference).success, reference)
  }
})

test('coauthor sessions require a work, character messages require an author and run', () => {
  const base = {
    schemaVersion: 1,
    id: newId('ses'),
    revision: 1,
    character: { id: 'koto', version: '0.1.0', digest: sha256('koto') },
    language: 'cn',
    status: 'open',
    lastMessageSequence: 0,
    createdAt: utcNow(),
    updatedAt: utcNow(),
  }
  assert.ok(sessionSchema.safeParse({ ...base, mode: 'conversation' }).success)
  assert.equal(
    sessionSchema.safeParse({ ...base, mode: 'coauthor' }).success,
    false,
  )
  assert.ok(
    sessionSchema.safeParse({
      ...base,
      mode: 'coauthor',
      workId: newId('work'),
    }).success,
  )
  assert.equal(
    messageSchema.safeParse({
      id: newId('msg'),
      sessionId: base.id,
      sequence: 1,
      role: 'character',
      text: 'hello',
      createdAt: utcNow(),
    }).success,
    false,
  )
})

test('memories require provenance and reject implicit or model-owned decisions', () => {
  const memory = {
    schemaVersion: 1,
    id: newId('mem'),
    revision: 1,
    characterId: 'koto',
    kind: 'event',
    status: 'candidate',
    content: '候选',
    tags: [],
    visibility: 'private',
    recordedAt: utcNow(),
    sources: [],
    decisions: [],
  }
  assert.equal(memorySchema.safeParse(memory).success, false)
  const sourced = {
    ...memory,
    sources: [
      { type: 'message', sessionId: newId('ses'), messageId: newId('msg') },
    ],
  }
  assert.ok(memorySchema.safeParse(sourced).success)
  assert.equal(
    memorySchema.safeParse({
      ...sourced,
      decisions: [{ action: 'confirm', actor: 'model', at: utcNow() }],
    }).success,
    false,
  )
  assert.equal(
    memorySchema.safeParse({ ...sourced, globalMemory: true }).success,
    false,
  )
})

test('validation errors and unknown failures do not echo input contents', () => {
  const secret = 'PRIVATE_SENTINEL_DO_NOT_ECHO'
  let failureResult
  try {
    validate(workspaceSchema, { schemaVersion: secret, apiKey: secret })
  } catch (error) {
    failureResult = failure(error)
  }
  assert.ok(failureResult)
  assert.equal(JSON.stringify(failureResult).includes(secret), false)
  assert.equal(
    JSON.stringify(failure(new Error(secret))).includes(secret),
    false,
  )
  assert.equal(failure(new CharactersError('BUSY', 'busy', 'retry')).ok, false)
})

test('generated schemas contain all persisted records and strict adapter boundaries', () => {
  assert.equal(Object.keys(schemaDocuments()).length, 31)
  assert.equal(
    adapterCapabilitiesSchema.safeParse({ protocolVersion: 2 }).success,
    false,
  )
  const document = schemaDocuments()['character.schema.json']
  assert.equal(document?.additionalProperties, false)
})

test('runtime configuration requires a command only for stdio and rejects embedded credentials in origins', () => {
  const config = {
    schemaVersion: 1,
    id: newId('ws'),
    timezone: 'Asia/Tokyo',
    policy: {
      isolation: 'strict',
      memoryWrite: 'confirm',
      network: 'adapter-only',
      tools: [],
    },
    runtime: {
      adapter: 'unconfigured',
      args: [],
      environmentAllowlist: [],
      contextBudget: { maxUtf8Bytes: 48000, maxOutputUtf8Bytes: 32000 },
    },
  }
  assert.ok(workspaceSchema.safeParse(config).success)
  assert.equal(
    workspaceSchema.safeParse({
      ...config,
      runtime: { ...config.runtime, adapter: 'stdio' },
    }).success,
    false,
  )
  assert.equal(
    workspaceSchema.safeParse({
      ...config,
      runtime: { ...config.runtime, command: 'hidden-worker' },
    }).success,
    false,
  )
  const origin = sourceSchema.shape.origin
  assert.ok(origin.safeParse('https://example.com/article').success)
  assert.equal(
    origin.safeParse('https://user:password@example.com/article').success,
    false,
  )
  assert.equal(origin.safeParse('file:///private').success, false)
})
