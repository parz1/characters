import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  schemaDocuments,
  CharactersError,
  sha256,
  utcNow,
} from '@characters/core'
import { execute } from './process.js'
import type { Command } from './process.js'
import { codexArguments, inspectEvent } from './policy.js'
import {
  executionDirectory,
  isolatedEnvironment,
  removeExecutionDirectory,
} from './environment.js'

export interface ProbeReport {
  method: 'codex-local-capture-v1'
  passed: boolean
  requests: number
  fileToolsAbsent: boolean
  exposedTools: string[]
  canaryAbsent: boolean
  canaryUnchanged: boolean
  cleanup: boolean
  checkedAt: string
}

export async function probeIsolation(
  workspaceRoot: string,
  command: Command,
): Promise<ProbeReport> {
  const temp = await executionDirectory(workspaceRoot)
  const canary = `characters-memory-${randomUUID()}`
  let requests = 0,
    toolsAbsent = true,
    canaryAbsent = true,
    captured = false
  const observed = new Set<string>()
  const toolNames = new Set<string>()
  const output = JSON.stringify({
    reply: '隔离测试通过。',
    proposal: { target: 'none', content: '', sourceIds: [] },
  })
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += String(chunk)
      if (body.length > 1024 * 1024) request.destroy()
    })
    request.on('end', () => {
      if (!request.url?.includes('/responses')) {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end('{"data":[]}')
        return
      }
      requests++
      try {
        const value = JSON.parse(body) as {
          tools?: Array<{ name?: string; type?: string }>
          input?: unknown
        }
        for (const tool of value.tools ?? [])
          if (/^[a-zA-Z0-9_.-]+$/.test(tool.name ?? tool.type ?? ''))
            toolNames.add(tool.name ?? tool.type ?? '')
        toolsAbsent &&= (value.tools ?? []).every(
          (tool) =>
            tool.type === 'function' && tool.name === 'request_user_input',
        )
        canaryAbsent &&= !body.includes(canary)
        captured ||= JSON.stringify(value.input).includes(
          'characters-isolation-probe',
        )
      } catch {
        toolsAbsent = false
        canaryAbsent = false
      }
      const item = {
        id: 'msg_probe',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: output, annotations: [] }],
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const send = (event: unknown) =>
        response.write(`data: ${JSON.stringify(event)}\n\n`)
      send({
        type: 'response.created',
        response: {
          id: 'resp_probe',
          object: 'response',
          created_at: 1,
          status: 'in_progress',
          output: [],
        },
      })
      send({
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...item, status: 'in_progress', content: [] },
      })
      send({
        type: 'response.content_part.added',
        output_index: 0,
        content_index: 0,
        item_id: item.id,
        part: { type: 'output_text', text: '', annotations: [] },
      })
      send({
        type: 'response.output_text.delta',
        output_index: 0,
        content_index: 0,
        item_id: item.id,
        delta: output,
      })
      send({
        type: 'response.output_text.done',
        output_index: 0,
        content_index: 0,
        item_id: item.id,
        text: output,
      })
      send({ type: 'response.output_item.done', output_index: 0, item })
      send({
        type: 'response.completed',
        response: {
          id: 'resp_probe',
          object: 'response',
          created_at: 1,
          status: 'completed',
          output: [item],
          usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
        },
      })
      response.end()
    })
  })
  try {
    await mkdir(path.join(temp.home, 'memories'))
    const memoryFile = path.join(temp.home, 'memories/memory_summary.md')
    await writeFile(memoryFile, canary)
    const parentHome = path.join(temp.directory, 'parent-home')
    await mkdir(parentHome)
    await writeFile(
      path.join(parentHome, 'AGENTS.md'),
      `GLOBAL_INSTRUCTION_${canary}`,
    )
    const schema = path.join(temp.directory, 'schema.json')
    await writeFile(
      schema,
      JSON.stringify(schemaDocuments()['codex-reply.schema.json']),
    )
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('listen')
    const result = await execute(
      command,
      codexArguments({
        cwd: temp.cwd,
        home: temp.home,
        schema,
        output: path.join(temp.directory, 'output.json'),
        model: 'characters-probe',
        overrides: [
          'model_provider="characters_probe"',
          'model_providers.characters_probe.name="Characters probe"',
          `model_providers.characters_probe.base_url="http://127.0.0.1:${address.port}/v1"`,
          'model_providers.characters_probe.wire_api="responses"',
          'model_providers.characters_probe.requires_openai_auth=false',
        ],
      }),
      {
        cwd: temp.cwd,
        env: isolatedEnvironment(temp.directory, {
          ...process.env,
          CODEX_HOME: parentHome,
          HOME: parentHome,
          USERPROFILE: parentHome,
        }),
        input:
          'characters-isolation-probe: return the requested JSON. Do not use any tools.',
        timeoutMs: 20000,
        onStdout: (line) => {
          try {
            const event = JSON.parse(line) as {
              type?: string
              item?: { type?: string }
            }
            const label = `${event.type ?? 'unknown'}/${event.item?.type ?? 'none'}`
            if (/^[a-zA-Z_./-]+$/.test(label)) observed.add(label)
          } catch {
            observed.add('non-json')
          }
          inspectEvent(line)
        },
      },
    ).catch((error) => {
      throw new CharactersError(
        'ISOLATION_UNSUPPORTED',
        `Codex 探测事件不兼容：${[...observed].join(', ')}。`,
        error instanceof CharactersError ? error.nextStep : '检查 CLI 版本。',
      )
    })
    const canaryUnchanged =
      sha256(await readFile(memoryFile)) === sha256(canary)
    const passed =
      result.code === 0 &&
      captured &&
      requests > 0 &&
      toolsAbsent &&
      canaryAbsent &&
      canaryUnchanged
    if (!passed)
      throw new CharactersError(
        'ISOLATION_UNSUPPORTED',
        `Codex 隔离探测未通过（exit=${result.code}, requests=${requests}, toolsAbsent=${toolsAbsent}, captured=${captured}, canaryAbsent=${canaryAbsent}, canaryUnchanged=${canaryUnchanged}, tools=${[...toolNames].join('|')}）。`,
        '检查当前 CLI 版本是否支持隔离配置。',
      )
    return {
      method: 'codex-local-capture-v1',
      passed,
      requests,
      fileToolsAbsent: toolsAbsent,
      exposedTools: [...toolNames],
      canaryAbsent,
      canaryUnchanged,
      cleanup: true,
      checkedAt: utcNow(),
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await removeExecutionDirectory(temp.root, temp.directory)
  }
}
