import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import {
  cp,
  mkdir,
  readdir,
  symlink,
  writeFile,
  readFile,
} from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { workspacePath } from '../packages/cli/dist/paths.js'
import { temporary, repository } from './helpers.ts'

const execute = promisify(execFile)
test('data location belongs to the application, with an explicit override', () => {
  const module = pathToFileURL(
    path.join(repository, 'packages/cli/dist/paths.js'),
  ).href
  assert.equal(
    workspacePath(undefined, module),
    path.join(repository, '.local/data'),
  )
  assert.equal(workspacePath('another-directory', module), 'another-directory')
  assert.throws(() => workspacePath('   ', module))
})

test('default init, management and service commands work from another CWD without writing there', async (t) => {
  let shutdown: (() => Promise<void>) | undefined
  const root = await temporary(t, async () => {
    await shutdown?.()
  })
  const installation = path.join(root, 'characters-app')
  const dist = path.join(installation, 'packages/cli/dist')
  await cp(path.join(repository, 'packages/cli/dist'), dist, {
    recursive: true,
  })
  await writeFile(path.join(installation, 'package.json'), '{"type":"module"}')
  // This fixture only reads dependencies. rm removes the junction itself, not its target.
  const modules = path.join(installation, 'node_modules/@characters')
  await mkdir(modules, { recursive: true })
  for (const name of ['core', 'service', 'adapters', 'protocol', 'mcp'])
    await symlink(
      path.join(repository, 'packages', name),
      path.join(modules, name),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
  const cwd = path.join(root, 'unrelated-project')
  await mkdir(cwd)
  await writeFile(path.join(cwd, 'AGENTS.md'), 'UNRELATED_PROJECT_SENTINEL')
  const cli = path.join(dist, 'index.js')
  const invoke = async (...args: string[]) => {
    const { stdout } = await execute(
      process.execPath,
      [cli, ...args, '--json'],
      { cwd },
    )
    return JSON.parse(stdout) as { ok: boolean; data: Record<string, unknown> }
  }
  const initialized = await invoke('workspace', 'init')
  assert.equal(initialized.data.root, path.join(installation, '.local/data'))
  await invoke('workspace', 'migrate', '--target', 'service-v1')
  assert.equal(
    (await invoke('workspace', 'status')).data.id,
    initialized.data.id,
  )
  const child = spawn(process.execPath, [cli, 'service', 'serve', '--json'], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  shutdown = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
  }
  let output = ''
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.stdout.on('data', (bytes) => {
      output += String(bytes)
      if (output.includes('"status":"running"')) resolve()
    })
    child.once('exit', (code) => {
      if (!output.includes('"status":"running"'))
        reject(new Error(`Fixture service exited ${code}`))
    })
  })
  assert.equal((await invoke('service', 'status')).data.status, 'running')
  assert.equal((await invoke('memory', 'list', '--character', 'koto')).ok, true)
  const exited = once(child, 'exit')
  await invoke('service', 'stop')
  assert.deepEqual(await exited, [0, null])
  assert.deepEqual(await readdir(cwd), ['AGENTS.md'])
  assert.equal(
    await readFile(path.join(cwd, 'AGENTS.md'), 'utf8'),
    'UNRELATED_PROJECT_SENTINEL',
  )
})
