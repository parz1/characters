import { mkdtemp, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'

export const repository = fileURLToPath(new URL('../', import.meta.url))
export const koto = path.join(repository, 'characters/koto')

export async function temporary(
  t: TestContext,
  beforeCleanup?: () => Promise<void>,
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'characters-test-'))
  t.after(async () => {
    await beforeCleanup?.()
    // Only remove the exact directory created by this fixture, inside the OS temp root.
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()))
    assert.ok(path.basename(root).startsWith('characters-test-'))
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    })
  })
  return root
}

export async function copyKoto(root: string): Promise<string> {
  const target = path.join(root, 'koto')
  await cp(koto, target, { recursive: true })
  return target
}
