import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { schemaDocuments } from '@characters/core'

const directory = fileURLToPath(new URL('../schemas/', import.meta.url))
const check = process.argv.includes('--check')
await mkdir(directory, { recursive: true })
const expected = new Set<string>()
for (const [filename, schema] of Object.entries(schemaDocuments())) {
  expected.add(filename)
  const content = `${JSON.stringify(schema, null, 2)}\n`
  const full = `${directory}/${filename}`
  if (check) {
    const current = await readFile(full, 'utf8').catch(() => '')
    if (current !== content)
      throw new Error(
        `${filename} 与 Core 定义不一致，请运行 pnpm schemas:generate。`,
      )
  } else await writeFile(full, content)
}
const stale = (await readdir(directory)).filter(
  (name) => name.endsWith('.schema.json') && !expected.has(name),
)
if (stale.length) throw new Error(`存在过期 schema：${stale.join(', ')}`)
console.log(`${check ? '已校验' : '已生成'} ${expected.size} 个 JSON Schema。`)
