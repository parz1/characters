import { characterManifestSchema } from './schemas.js'
import type { CharacterManifest } from './schemas.js'
import { CharactersError } from './errors.js'
import { validate } from './validation.js'
import {
  decodeUtf8,
  directoryRoot,
  listPackageFiles,
  readBytes,
} from './files.js'
import { sha256 } from './ids.js'
import { parseDocument } from 'yaml'

export interface LoadedCharacter {
  manifest: CharacterManifest
  digest: string
  files: ReadonlyMap<string, Buffer>
}

export function parseYaml(content: string): unknown {
  try {
    const document = parseDocument(content, {
      uniqueKeys: true,
      schema: 'core',
      logLevel: 'silent',
      prettyErrors: false,
    })
    if (document.errors.length || document.warnings.length)
      throw new Error('invalid')
    return document.toJS({ maxAliasCount: 0 }) as unknown
  } catch {
    throw new CharactersError(
      'INVALID_INPUT',
      'YAML 结构不合法或使用了别名。',
      '使用无重复字段、无别名的普通 YAML。',
    )
  }
}

export async function loadCharacter(
  directory: string,
): Promise<LoadedCharacter> {
  const root = await directoryRoot(directory)
  const manifestBytes = await readBytes(root, 'character.yaml', 128 * 1024)
  const manifest = validate(
    characterManifestSchema,
    parseYaml(decodeUtf8(manifestBytes)),
  )
  if (
    !manifest.languages.includes(manifest.defaultLanguage) ||
    new Set(manifest.languages).size !== manifest.languages.length
  ) {
    throw new CharactersError(
      'INVALID_INPUT',
      '默认语言必须包含在不重复的 languages 中。',
      '修正角色语言配置。',
    )
  }
  const declared = [
    ...Object.values(manifest.files),
    ...Object.values(manifest.modes),
    ...Object.values(manifest.examples),
  ]
  if (
    new Set(declared.map((ref) => ref.toLowerCase())).size !==
      declared.length ||
    declared.some((ref) => !ref.endsWith('.md'))
  ) {
    throw new CharactersError(
      'INVALID_INPUT',
      '角色入口必须分别引用不同的 Markdown 文件。',
      '为人格、文风、关系、模式和样本分别提供文件。',
    )
  }
  const allowed = new Set(['character.yaml', 'README.md', ...declared])
  const paths = await listPackageFiles(root)
  if (paths.some((ref) => !allowed.has(ref))) {
    throw new CharactersError(
      'INVALID_INPUT',
      '角色包包含未声明的文件。',
      '第一阶段仅接收清单、README 和已声明的 Markdown，私人记忆应放在工作区。',
    )
  }
  const files = new Map<string, Buffer>()
  let totalBytes = 0
  for (const ref of paths) {
    const bytes =
      ref === 'character.yaml'
        ? manifestBytes
        : await readBytes(root, ref, 128 * 1024)
    if (!decodeUtf8(bytes).trim())
      throw new CharactersError(
        'INVALID_INPUT',
        '角色包不能包含空文档。',
        '补全角色资料。',
      )
    totalBytes += bytes.length
    if (totalBytes > 2 * 1024 * 1024)
      throw new CharactersError(
        'INVALID_INPUT',
        '角色包超过 2 MiB。',
        '缩减样本和设定。',
      )
    files.set(ref, bytes)
  }
  if (declared.some((ref) => !files.has(ref)))
    throw new CharactersError(
      'INVALID_INPUT',
      '角色清单引用了缺失文件。',
      '补全清单中的 Markdown 文件。',
    )
  const canonical = JSON.stringify(
    [...files].map(([ref, bytes]) => ({ path: ref, digest: sha256(bytes) })),
  )
  return { manifest, digest: sha256(canonical), files }
}
