import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { initWorkspace, workspaceStatus } from '@characters/core'
import {
  isolatedEnvironment,
  codexArguments,
  probeIsolation,
  resolveCodex,
} from '@characters/adapters'
import { inspectEvent } from '../packages/adapters/dist/policy.js'
import { execute } from '../packages/adapters/dist/process.js'
import { temporary } from './helpers.ts'
import path from 'node:path'

test('execution environment redirects every home/config directory and does not inherit secrets', () => {
  const env = isolatedEnvironment('D:/isolated', {
    CODEX_HOME: 'D:/global',
    HOME: 'D:/user',
    OPENAI_API_KEY: 'DO_NOT_FORWARD',
    CODEX_API_KEY: 'DO_NOT_FORWARD',
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'DO_NOT_FORWARD',
    PATH: 'system-path',
  })
  assert.equal(env.CODEX_HOME, path.join('D:/isolated', 'home'))
  assert.equal(env.HOME, path.join('D:/isolated', 'profile'))
  assert.equal(env.USERPROFILE, env.HOME)
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.CODEX_API_KEY, undefined)
  assert.equal(env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, undefined)
  assert.equal(env.PATH, 'system-path')
})
test('Codex arguments disable memories, persistence, project docs and command tools without bypassing the sandbox', () => {
  const args = codexArguments({
    cwd: 'D:/work',
    home: 'D:/home',
    output: 'D:/output',
    schema: 'D:/schema',
  })
  for (const expected of [
    '--ephemeral',
    '--ignore-user-config',
    '--strict-config',
    'read-only',
    'memories.use_memories=false',
    'memories.generate_memories=false',
    'project_doc_max_bytes=0',
    'shell_tool',
  ])
    assert.ok(args.includes(expected))
  assert.equal(
    args.includes('--dangerously-bypass-approvals-and-sandbox'),
    false,
  )
  assert.equal(args.at(-1), '-')
})
test('tool execution events are rejected before accepting model output', () => {
  assert.throws(() =>
    inspectEvent(
      JSON.stringify({
        type: 'item.started',
        item: { type: 'command_execution' },
      }),
    ),
  )
  assert.throws(() =>
    inspectEvent(
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'mcp_tool_call' },
      }),
    ),
  )
  assert.doesNotThrow(() =>
    inspectEvent(
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message' },
      }),
    ),
  )
})
test('cancellation terminates the owned child process', async (t) => {
  const root = await temporary(t)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 100)
  try {
    await assert.rejects(
      execute(
        { executable: process.execPath },
        ['-e', 'setTimeout(()=>{},10000)'],
        {
          cwd: root,
          env: process.env,
          signal: controller.signal,
          timeoutMs: 5000,
        },
      ),
      { code: 'CANCELLED' },
    )
  } finally {
    clearTimeout(timer)
  }
})
test('installed Codex sends no memory canary or file tools to a local capture endpoint', async (t) => {
  let executable
  try {
    executable = await resolveCodex()
  } catch {
    t.skip(
      'Codex CLI is not installed; no live model calls are made by this suite.',
    )
    return
  }
  const root = path.join(await temporary(t), 'data')
  await initWorkspace(root)
  const report = await probeIsolation(root, { executable })
  assert.equal(report.passed, true)
  assert.equal(report.fileToolsAbsent, true)
  assert.equal(report.canaryAbsent, true)
  assert.equal(report.canaryUnchanged, true)
  assert.equal(report.cleanup, true)
  assert.ok(report.exposedTools.every((tool) => tool === 'request_user_input'))
  const ignore = await readFile(path.join(root, '.gitignore'), 'utf8')
  assert.equal(ignore, '*\n!.gitignore\n')
})

test('unfinished execution directories remain visible in workspace status', async (t) => {
  const workspace = await initWorkspace(path.join(await temporary(t), 'data'))
  await mkdir(
    path.join(workspace.root, '.runtime/codex-executions/codex-orphan'),
    { recursive: true },
  )
  const status = await workspaceStatus(workspace)
  assert.equal(status.recovery, 'inspection-required')
  assert.equal(status.executionDirectories, 1)
})
