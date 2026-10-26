#!/usr/bin/env node
import path from 'node:path'
import { parseArgs } from 'node:util'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { connectGateway, gatewayWorkspace } from './index.js'
import { CharactersError } from '@characters/core'

try {
  const { values } = parseArgs({
    options: { workspace: { type: 'string' }, pairing: { type: 'string' } },
    allowPositionals: false,
    strict: true,
  })
  if (!values.workspace || !values.pairing)
    throw new Error('explicit-configuration-required')
  const gateway = await connectGateway(
    await gatewayWorkspace(path.resolve(values.workspace)),
    values.pairing,
  )
  const transport = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: 262144,
  })
  const close = () => {
    void gateway.close().catch(() => {
      process.exitCode = 1
    })
  }
  gateway.server.onerror = () => {
    process.stderr.write(
      'characters-mcp: invalid protocol message; connection closed\n',
    )
    close()
  }
  process.stdin.once('end', close)
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
  await gateway.server.connect(transport)
} catch (error) {
  if (error instanceof CharactersError)
    process.stderr.write(`characters-mcp: ${error.code}\n`)
  process.stderr.write(
    'characters-mcp: unavailable; check explicit workspace, pairing, service generation and agent credential\n',
  )
  process.exitCode = 1
}
