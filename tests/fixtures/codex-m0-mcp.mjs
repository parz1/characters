import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

// Artificial role data only. This server is never installed into real Codex.
const instance = randomUUID()
const log = process.env.M0_MCP_LOG
if (!log) throw new Error('M0 log path is required')
const write = (value) => appendFileSync(log, `${JSON.stringify(value)}\n`)
write({
  event: 'start',
  instance,
  pid: process.pid,
  threadEnv: process.env.CODEX_THREAD_ID ?? null,
})
const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  write({
    event: 'request',
    instance,
    method: request.method,
    params: request.params,
  })
  let result
  if (request.method === 'initialize') {
    result = {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'characters-m0-fixture', version: '0.0.0' },
    }
  } else if (request.method === 'tools/list') {
    result = {
      tools: [
        {
          name: 'context_get',
          description: 'Return artificial M0 role data',
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false,
          },
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    }
  } else if (request.method === 'tools/call') {
    result = {
      content: [{ type: 'text', text: 'M0_ROLE_CONTEXT_CANARY' }],
      structuredContent: { instance, marker: 'M0_ROLE_CONTEXT_CANARY' },
    }
  } else if (request.method === 'ping') {
    result = {}
  } else {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unknown fixture method' } })}\n`,
    )
    return
  }
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`,
  )
})
process.stdin.on('end', () => process.exit(0))
