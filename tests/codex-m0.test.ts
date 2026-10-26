import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveCodex } from '@characters/adapters'
import { probeCodexHost } from '../scripts/lib/codex-m0-probe.ts'

test('M0 captures real Codex host behavior without touching real sessions or credentials', async (t) => {
  let executable: string
  try {
    executable = await resolveCodex()
  } catch {
    t.skip('Codex is not installed; no live model or real credentials are used')
    return
  }
  const report = await probeCodexHost(executable)
  assert.equal(report.realModelUsed, false)
  assert.equal(report.realCredentialsUsed, false)
  assert.equal(report.cleanup, true)
  for (const key of [
    'compatibilityPluginLoaded',
    'perThreadPluginSelection',
    'mcpCallCarriesThreadId',
    'threadMetadataIsNotToolArgument',
    'roleToolResultReachesModelInput',
    'activeThreadMemoryReadDisabled',
    'baselineThreadMemoryReadPreserved',
    'memoryGenerationEligibilityIsThreadScoped',
    'otherSessionUnaffected',
    'disabledPluginIdsActuallyRemovesTools',
    'disabledPluginBlocksDirectCall',
    'reenabledPluginRestoresTools',
    'otherActivePluginSessionUnaffected',
    'lifecycleDoesNotWriteSharedConfig',
    'memoryFileUnchanged',
  ] as const)
    assert.equal(report.checks[key], true, key)
  // A successful lab must never be promoted to real installed-plugin evidence.
  assert.equal(report.strictPluginReady, false)
  assert.match(report.scope, /not-existing-tui-or-desktop/)
})
