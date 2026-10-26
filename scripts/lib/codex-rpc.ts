import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export type JsonObject = Record<string, unknown>

export function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a protocol object')
  return value as JsonObject
}

// M0 laboratory client only. It never connects to the user's running daemon.
export function codexRpc(options: {
  executable: string
  cwd: string
  env: NodeJS.ProcessEnv
  args?: string[]
}) {
  const child = spawn(
    options.executable,
    ['app-server', '--stdio', ...(options.args ?? [])],
    { cwd: options.cwd, env: options.env, windowsHide: true, shell: false },
  )
  let nextId = 0
  let bytes = 0
  let stderr = ''
  let stopped = false
  const notifications: JsonObject[] = []
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  const fail = (error: Error) => {
    for (const task of pending.values()) {
      clearTimeout(task.timer)
      task.reject(error)
    }
    pending.clear()
  }
  const lines = createInterface({ input: child.stdout })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-16000)
  })
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.byteLength
    if (bytes > 16 * 1024 * 1024) {
      fail(new Error('M0 protocol output exceeded limit'))
      child.kill()
    }
  })
  child.on('error', () => fail(new Error('M0 Codex failed to start')))
  child.on('exit', () => {
    stopped = true
    fail(new Error('M0 Codex exited before replying'))
  })
  const send = (value: unknown) => {
    if (stopped) throw new Error('M0 Codex is stopped')
    child.stdin.write(`${JSON.stringify(value)}\n`)
  }
  lines.on('line', (line) => {
    try {
      const value = object(JSON.parse(line))
      if (typeof value.id === 'number' && !value.method) {
        const task = pending.get(value.id)
        if (!task) return
        clearTimeout(task.timer)
        pending.delete(value.id)
        if (value.error)
          task.reject(new Error(JSON.stringify(value.error).slice(0, 1500)))
        else task.resolve(value.result)
      } else if (value.method && value.id !== undefined) {
        // Never approve tools, permissions or network requests in this lab.
        send({ id: value.id, error: { code: -32601, message: 'M0 denied' } })
      } else {
        if (notifications.length >= 10000) notifications.shift()
        notifications.push(value)
      }
    } catch {
      fail(new Error('Invalid M0 protocol output'))
      child.kill()
    }
  })
  return {
    notifications,
    diagnostics: () => stderr,
    notify: (method: string) => send({ method }),
    request: (method: string, params: unknown = {}): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const id = ++nextId
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`M0 request timeout: ${method}`))
        }, 15000)
        pending.set(id, { resolve, reject, timer })
        try {
          send({ id, method, params })
        } catch (error) {
          clearTimeout(timer)
          pending.delete(id)
          reject(error)
        }
      }),
    async close() {
      if (!stopped) {
        const exited = new Promise<void>((resolve) =>
          child.once('exit', resolve),
        )
        child.stdin.end()
        const timer = setTimeout(() => child.kill(), 1500)
        await exited
        clearTimeout(timer)
      }
      lines.close()
    },
  }
}
