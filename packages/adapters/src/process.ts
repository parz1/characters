import { spawn } from 'node:child_process'
import { CharactersError } from '@characters/core'
import path from 'node:path'

export interface Command {
  executable: string
  prefixArgs?: string[]
}
export interface ProcessResult {
  stdout: string
  stderr: string
  code: number
}

export async function execute(
  command: Command,
  args: string[],
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
    input?: string
    signal?: AbortSignal
    timeoutMs?: number
    maxBytes?: number
    onStdout?: (line: string) => void
  },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      command.executable,
      [...(command.prefixArgs ?? []), ...args],
      {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    let stdout = '',
      stderr = '',
      pending = '',
      size = 0
    let failure: CharactersError | undefined
    const stop = (error: CharactersError) => {
      if (failure) return
      failure = error
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn(
          path.join(
            process.env.SystemRoot ?? 'C:/Windows',
            'System32/taskkill.exe',
          ),
          ['/PID', String(child.pid), '/T', '/F'],
          { shell: false, windowsHide: true, stdio: 'ignore' },
        )
        killer.once('error', () => child.kill())
      } else child.kill('SIGKILL')
    }
    const cancel = () =>
      stop(
        new CharactersError(
          'CANCELLED',
          '执行已取消。',
          '已保存本次输入，可在同一会话继续。',
        ),
      )
    const timer = setTimeout(
      () =>
        stop(
          new CharactersError(
            'ADAPTER_TIMEOUT',
            'Codex 执行超时。',
            '检查登录与网络后重试。',
          ),
        ),
      options.timeoutMs ?? 180000,
    )
    options.signal?.addEventListener('abort', cancel, { once: true })
    if (options.signal?.aborted) cancel()
    const collect = (chunk: Buffer, channel: 'stdout' | 'stderr') => {
      size += chunk.length
      if (size > (options.maxBytes ?? 2 * 1024 * 1024)) {
        stop(
          new CharactersError(
            'CONTEXT_LIMIT',
            'Codex 运行输出超过限制。',
            '缩减本次任务。',
          ),
        )
        return
      }
      const text = chunk.toString('utf8')
      if (channel === 'stderr') stderr += text
      else {
        stdout += text
        pending += text
        let index
        while ((index = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, index)
          pending = pending.slice(index + 1)
          try {
            if (line.trim()) options.onStdout?.(line)
          } catch {
            stop(
              new CharactersError(
                'ISOLATION_UNSUPPORTED',
                'Codex 返回了未授权工具调用或无效事件。',
                '本次结果未采纳，请重新执行隔离检查。',
              ),
            )
          }
        }
      }
    }
    child.stdout.on('data', (chunk) => collect(chunk, 'stdout'))
    child.stderr.on('data', (chunk) => collect(chunk, 'stderr'))
    child.stdin.on('error', () => {})
    child.stdin.end(options.input ?? '')
    child.once('error', () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', cancel)
      reject(
        new CharactersError(
          'ADAPTER_FAILED',
          '无法启动 Codex CLI。',
          '检查 --codex 路径。',
        ),
      )
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', cancel)
      if (!failure && pending.trim()) {
        try {
          options.onStdout?.(pending)
        } catch {
          failure = new CharactersError(
            'ADAPTER_PROTOCOL',
            'Codex 事件不完整。',
            '检查 CLI 版本后重试。',
          )
        }
      }
      if (failure) reject(failure)
      else resolve({ stdout, stderr, code: code ?? 1 })
    })
  })
}
