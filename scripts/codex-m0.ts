import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { probeCodexHost } from './lib/codex-m0-probe.ts'

const { values } = parseArgs({
  options: {
    codex: { type: 'string' },
    output: { type: 'string' },
  },
})
const report = await probeCodexHost(values.codex)
const text = `${JSON.stringify(report, null, 2)}\n`
if (values.output) {
  const filename = values.output
  await mkdir(path.dirname(path.resolve(filename)), { recursive: true })
  await writeFile(path.resolve(filename), text, { flag: 'wx' })
}
process.stdout.write(text)
