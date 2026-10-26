import assert from 'node:assert/strict'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  addCharacter,
  CharactersError,
  bindingSchema,
  contextDeliverySchema,
  failure,
  initWorkspace,
  memorySearchResultSchema,
  memoryV2Schema,
  migrateService,
} from '@characters/core'
import { managementRequest, startService } from '@characters/service'
import { pairGateway } from '@characters/mcp'
import { parseProtocolResponse } from '@characters/protocol'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// Synthetic local protocol demo. Never connects to Codex or claims host isolation.
async function demo() {
  const { values } = parseArgs({
    options: { workspace: { type: 'string' }, transport: { type: 'string' } },
    strict: true,
    allowPositionals: false,
  })
  if (values.transport && values.transport !== 'mcp')
    throw new CharactersError(
      'INVALID_INPUT',
      '演示传输仅支持 mcp 或默认 HTTP。',
      '检查 --transport。',
    )
  if (!values.workspace)
    throw new CharactersError(
      'INVALID_INPUT',
      '演示需要新的空 --workspace 目录。',
      '显式提供演示工作区路径，不使用个人记忆工作区。',
    )
  const workspace = await initWorkspace(values.workspace)
  await migrateService(workspace)
  await addCharacter(
    workspace,
    fileURLToPath(new URL('../characters/koto', import.meta.url)),
  )
  const service = await startService(workspace)
  const clients: Client[] = []
  let report: unknown
  try {
    const admin = (operation: string, params: unknown = {}) =>
      managementRequest(workspace, operation, params)
    const connect = async () => {
      const session = `synthetic-${randomUUID()}`
      const grant = z.object({ credentialRef: z.string() }).parse(
        await admin('connection.grant', {
          hostId: 'local-demo',
          pluginId: 'm3-demo',
          hostSessionRef: session,
          characterIds: ['koto'],
          allowedProjectKeys: ['demo'],
          allowedContextKeys: [],
          actions: [
            'discover',
            'bind',
            'context.read',
            'memory.search',
            'memory.propose',
          ],
          isolation: 'relaxed',
          ttlSeconds: 300,
        }),
      )
      let call = (operation: string, params: unknown): Promise<unknown> =>
        managementRequest(
          workspace,
          operation,
          params,
          randomUUID(),
          grant.credentialRef,
        )
      if (values.transport === 'mcp') {
        const id = grant.credentialRef.split('/').at(-1)!.replace('.token', '')
        const pairing = await pairGateway(workspace, id, session)
        const client = new Client({
          name: 'synthetic-m4-demo',
          version: '0.1.0',
        })
        clients.push(client)
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [
              fileURLToPath(
                new URL('../packages/mcp/dist/stdio.js', import.meta.url),
              ),
              '--workspace',
              workspace.root,
              '--pairing',
              pairing.pairingRef,
            ],
          }),
        )
        assert.equal((await client.listTools()).tools.length, 6)
        call = async (operation, params) => {
          const result = await client.callTool({
            name: operation.replace('.', '_'),
            arguments: { requestId: randomUUID(), params },
            _meta: { threadId: session },
          })
          const envelope = parseProtocolResponse(result.structuredContent)
          if (!envelope.ok) throw new Error(envelope.error.code)
          return envelope.data
        }
      }
      const binding = bindingSchema.parse(
        await call('bindings.open', {
          characterId: 'koto',
          scope: {
            purpose: 'synthetic M3 demonstration',
            projectKey: 'demo',
            contextKeys: [],
          },
        }),
      )
      return { binding, call }
    }
    const a = await connect()
    const context = contextDeliverySchema.parse(
      await a.call('context.get', { bindingId: a.binding.id }),
    )
    assert.ok(context.entries.some((entry) => entry.kind === 'persona'))
    const candidate = memoryV2Schema.parse(
      await a.call('memory.propose', {
        bindingId: a.binding.id,
        candidate: {
          kind: 'preference',
          content: 'M3_SYNTHETIC_MARKER: prefer an explicit review step',
          tags: ['demo'],
          scope: { projectKey: 'demo' },
          excerpt:
            'Synthetic fixture, not a real conversation or user preference.',
        },
      }),
    )
    const search = async (client: typeof a) =>
      memorySearchResultSchema.parse(
        await client.call('memory.search', {
          bindingId: client.binding.id,
          query: 'M3_SYNTHETIC_MARKER',
          limit: 20,
        }),
      )
    assert.equal((await search(a)).matches.length, 0)
    const confirmed = memoryV2Schema.parse(
      await admin('memory.confirm', {
        characterId: 'koto',
        id: candidate.id,
        expectedRevision: 1,
        reason: 'Explicit approval of synthetic demonstration data',
      }),
    )
    const b = await connect()
    assert.equal((await search(b)).matches[0]?.id, candidate.id)
    await admin('memory.retract', {
      characterId: 'koto',
      id: confirmed.id,
      expectedRevision: confirmed.revision,
      reason: 'End of synthetic demonstration',
    })
    assert.equal((await search(b)).matches.length, 0)
    for (const client of [a, b])
      await client.call('bindings.close', {
        bindingId: client.binding.id,
        expectedRevision: client.binding.revision,
      })
    report = {
      ok: true,
      workspace: workspace.root,
      isolation: 'relaxed',
      hostIsolationVerified: false,
      transport: values.transport ?? 'http',
      checks: [
        'role-context',
        'candidate-hidden',
        'human-confirmation',
        'new-session-retrieval',
        'retraction-hidden',
      ],
      memoryId: candidate.id,
      contextDeliveryId: context.id,
      serviceStoppedOnExit: true,
    }
  } finally {
    for (const client of clients) await client.close()
    await service.close()
  }
  process.stdout.write(`${JSON.stringify(report)}\n`)
}
try {
  await demo()
} catch (error) {
  process.stderr.write(`${JSON.stringify(failure(error))}\n`)
  process.exitCode = 1
}
