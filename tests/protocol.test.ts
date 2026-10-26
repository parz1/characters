import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { newId } from '@characters/core'
import {
  parseAgentRequest,
  mcpOperations,
  strictActivationDecision,
} from '@characters/protocol'

const make = (operation: string, params: unknown) => ({
  protocolVersion: 1,
  requestId: randomUUID(),
  operation,
  params,
})

test('agent protocol has six bounded operations without management authority', () => {
  const bindingId = newId('bind')
  const requests = [
    make('characters.list', {}),
    make('bindings.open', {
      characterId: 'koto',
      scope: { purpose: 'design', contextKeys: [] },
    }),
    make('context.get', { bindingId }),
    make('memory.search', { bindingId, query: 'project', limit: 20 }),
    make('memory.propose', {
      bindingId,
      candidate: {
        kind: 'opinion',
        content: 'proposal',
        tags: [],
        scope: {},
        excerpt: 'user asked to save',
      },
    }),
    make('bindings.close', { bindingId, expectedRevision: 1 }),
  ]
  assert.equal(new Set(Object.values(mcpOperations)).size, 6)
  for (const value of requests)
    assert.equal(parseAgentRequest(value).operation, value.operation)
  for (const operation of [
    'memory.confirm',
    'connection.grant',
    'config.write',
    'service.describe',
  ])
    assert.throws(() => parseAgentRequest(make(operation, {})))
})

test('request validation rejects forged authority, paths, cross-domain IDs and secret-bearing extras', () => {
  const valid = make('context.get', { bindingId: newId('bind') })
  for (const field of [
    'workspace',
    'token',
    'actor',
    'characterId',
    'hostSessionRef',
  ])
    assert.throws(
      () =>
        parseAgentRequest({
          ...valid,
          params: {
            ...(valid.params as object),
            [field]: 'PRIVATE_INPUT_MARKER',
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message.includes('PRIVATE_INPUT_MARKER'), false)
        return true
      },
    )
  assert.throws(() =>
    parseAgentRequest(make('context.get', { bindingId: newId('ses') })),
  )
  assert.throws(() => parseAgentRequest({ ...valid, protocolVersion: 2 }))
  assert.throws(() => parseAgentRequest({ ...valid, actor: 'user' }))
  assert.throws(() =>
    parseAgentRequest(
      make('bindings.open', {
        characterId: 'koto',
        scope: { purpose: 'design', projectKey: '../secret', contextKeys: [] },
      }),
    ),
  )
})

test('candidate byte budgets count UTF-8 and prohibit model confirmation fields', () => {
  const candidate = {
    kind: 'fact',
    content: '界'.repeat(1365),
    tags: [],
    scope: {},
    excerpt: 'requested excerpt',
  }
  const bindingId = newId('bind')
  assert.doesNotThrow(() =>
    parseAgentRequest(make('memory.propose', { bindingId, candidate })),
  )
  assert.throws(() =>
    parseAgentRequest(
      make('memory.propose', {
        bindingId,
        candidate: { ...candidate, content: '界'.repeat(1366) },
      }),
    ),
  )
  assert.throws(() =>
    parseAgentRequest(
      make('memory.propose', {
        bindingId,
        candidate: { ...candidate, status: 'confirmed', actor: 'user' },
      }),
    ),
  )
  assert.throws(() =>
    parseAgentRequest(
      make('memory.search', { bindingId, query: 'x', limit: 21 }),
    ),
  )
})

test('strict admission requires scoped, current host evidence and separate memory read/write controls', () => {
  const now = new Date('2026-10-25T12:00:00Z')
  const evidence = {
    source: 'trusted-host-session',
    hostSessionRef: 'A',
    subjectSessionRef: 'A',
    scopedPluginControl: 'verified',
    memoryRead: 'disabled',
    memoryGeneration: 'disabled',
    changesOtherSessions: false,
    requiresSharedConfigWrite: false,
    checkedAt: '2026-10-25T11:59:00Z',
    validUntil: '2026-10-25T12:30:00Z',
  }
  assert.equal(strictActivationDecision(evidence, now).allowed, true)
  for (const patch of [
    { source: 'lab-probe' },
    { source: 'self-report' },
    { subjectSessionRef: 'B' },
    { scopedPluginControl: 'unknown' },
    { memoryRead: 'enabled' },
    { memoryGeneration: 'unknown' },
    { changesOtherSessions: true },
    { requiresSharedConfigWrite: true },
    { validUntil: '2026-10-25T12:00:00Z' },
    { validUntil: '2026-10-25T13:30:00Z' },
    { checkedAt: '2026-10-25T12:01:00Z' },
  ])
    assert.equal(
      strictActivationDecision({ ...evidence, ...patch }, now).allowed,
      false,
    )
  assert.equal(
    strictActivationDecision({ ...evidence, token: 'unused' }, now).allowed,
    false,
  )
})
