import { mkdir, open, readdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { stringify } from 'yaml'
import { z } from 'zod'
import { CharactersError } from './errors.js'
import {
  containedPath,
  decodeUtf8,
  directoryRoot,
  exists,
  isErrno,
  readBytes,
} from './files.js'
import { loadCharacter, parseYaml } from './characters.js'
import { newId, sha256 } from './ids.js'
import {
  charactersLockSchema,
  characterIdSchema,
  workspaceSchema,
  serviceDescriptorSchema,
  writeLockSchema,
} from './schemas.js'
import type { InstalledCharacter, WorkspaceConfig } from './schemas.js'
import { validate } from './validation.js'
import {
  jsonBytes,
  readJson,
  withStore,
  recoverWorkspaceStorage,
  canonicalJson,
} from './storage.js'
import type { StorageOptions } from './storage.js'

const directories = [
  'packages',
  'contexts',
  'objects',
  'states',
  'sessions',
  'works',
  'exports',
  'indexes',
  '.runtime',
]
const bootstrapSchema = z.strictObject({
  schemaVersion: z.literal(1),
  config: workspaceSchema,
})
export interface WorkspaceHandle {
  readonly root: string
  readonly config: WorkspaceConfig
}

async function completeInitialization(
  root: string,
  config: WorkspaceConfig,
  options: StorageOptions = {},
): Promise<WorkspaceHandle> {
  const workspace = { root, config }
  for (const directory of directories) {
    await mkdir(await containedPath(root, directory), { recursive: true })
    await directoryRoot(await containedPath(root, directory))
  }
  await withStore(
    workspace,
    async (transaction) => {
      await transaction.put('.gitignore', Buffer.from('*\n!.gitignore\n'))
      await transaction.put(
        'characters.lock',
        jsonBytes({ schemaVersion: 1, revision: 1, characters: [] }),
      )
      await transaction.put('workspace.yaml', Buffer.from(stringify(config)))
      return { id: config.id }
    },
    options,
  )
  try {
    await unlink(await containedPath(root, '.initializing'))
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error
  }
  return workspace
}

export async function initWorkspace(
  directory: string,
  options: StorageOptions = {},
): Promise<WorkspaceHandle> {
  const absolute = path.resolve(directory)
  if (await exists(absolute)) {
    const existingRoot = await directoryRoot(absolute)
    if ((await readdir(existingRoot)).length)
      throw new CharactersError(
        'CONFLICT',
        '工作区初始化要求新目录或空目录。',
        '选择独立数据目录；不会覆盖现有文件。',
      )
  } else await mkdir(absolute, { recursive: true })
  const root = await directoryRoot(absolute)
  const config = validate(workspaceSchema, {
    schemaVersion: 1,
    id: newId('ws'),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    policy: {
      isolation: 'strict',
      memoryWrite: 'confirm',
      network: 'adapter-only',
      tools: ['source.read'],
    },
    runtime: {
      adapter: 'unconfigured',
      args: [],
      environmentAllowlist: [],
      contextBudget: { maxUtf8Bytes: 48000, maxOutputUtf8Bytes: 32000 },
    },
  })
  let marker
  try {
    marker = await open(await containedPath(root, '.initializing'), 'wx')
  } catch (error) {
    if (isErrno(error, 'EEXIST'))
      throw new CharactersError(
        'BUSY',
        '另一个进程正在初始化目录。',
        '等待初始化完成后查看状态。',
      )
    throw error
  }
  try {
    if ((await readdir(root)).some((name) => name !== '.initializing'))
      throw new CharactersError(
        'CONFLICT',
        '初始化期间目录发生变化。',
        '保留目录并检查新增文件。',
      )
    await marker.writeFile(jsonBytes({ schemaVersion: 1, config }))
    await marker.sync()
  } finally {
    await marker.close()
  }
  return completeInitialization(root, config, options)
}

export async function openWorkspace(
  directory: string,
  recoveryOptions: StorageOptions = {},
): Promise<WorkspaceHandle> {
  const root = await directoryRoot(directory)
  if (await exists(await containedPath(root, '.initializing'))) {
    let bootstrap
    try {
      bootstrap = await readJson(
        root,
        '.initializing',
        bootstrapSchema,
        64 * 1024,
      )
    } catch {
      throw new CharactersError(
        'RECOVERY_REQUIRED',
        '初始化记录不完整或来自旧版本，不能安全恢复。',
        '保留目录检查；不会猜测配置或覆盖已有文件。',
      )
    }
    return completeInitialization(root, bootstrap.config, recoveryOptions)
  }
  const bytes = await readBytes(root, 'workspace.yaml', 64 * 1024)
  let data: unknown
  try {
    data = parseYaml(decodeUtf8(bytes))
  } catch {
    throw new CharactersError(
      'STORE_CORRUPT',
      '工作区配置不是有效 YAML 文本。',
      '修正 workspace.yaml 或从备份恢复。',
    )
  }
  const config = validate(workspaceSchema, data, 'STORE_CORRUPT')
  try {
    new Intl.DateTimeFormat('en', { timeZone: config.timezone })
  } catch {
    throw new CharactersError(
      'STORE_CORRUPT',
      '工作区时区不合法。',
      '使用有效 IANA 时区。',
    )
  }
  for (const directory of directories)
    await directoryRoot(await containedPath(root, directory))
  const workspace = { root, config }
  await recoverWorkspaceStorage(workspace, recoveryOptions)
  return workspace
}

async function readLock(workspace: WorkspaceHandle) {
  const lock = await readJson(
    workspace.root,
    'characters.lock',
    charactersLockSchema,
    1024 * 1024,
  )
  if (
    new Set(lock.characters.map((item) => item.characterId)).size !==
      lock.characters.length ||
    lock.characters.some(
      (item) =>
        item.manifestRef !==
        `packages/${item.characterId}/${item.digest}/character.yaml`,
    )
  )
    throw new CharactersError(
      'STORE_CORRUPT',
      '角色锁文件包含重复 ID 或错误引用。',
      '从可信备份恢复锁文件。',
    )
  return lock
}
async function inspectCharacter(workspace: WorkspaceHandle, id: string) {
  validate(characterIdSchema, id)
  const item = (await readLock(workspace)).characters.find(
    (entry) => entry.characterId === id,
  )
  if (!item)
    throw new CharactersError(
      'NOT_FOUND',
      '工作区尚未安装该角色。',
      '使用 character add 安装角色包。',
    )
  const loaded = await loadCharacter(
    await containedPath(workspace.root, path.posix.dirname(item.manifestRef)),
  )
  if (
    loaded.digest !== item.digest ||
    loaded.manifest.id !== id ||
    loaded.manifest.version !== item.version
  )
    throw new CharactersError(
      'STORE_CORRUPT',
      '已安装的角色快照被修改。',
      '保留现场并从可信副本恢复。',
    )
  return { ...item, manifest: loaded.manifest }
}
export async function listCharacters(
  workspace: WorkspaceHandle,
): Promise<InstalledCharacter[]> {
  return withStore(
    workspace,
    async () => (await readLock(workspace)).characters,
  )
}
export async function showCharacter(workspace: WorkspaceHandle, id: string) {
  return withStore(workspace, async () => inspectCharacter(workspace, id))
}
export async function addCharacter(
  workspace: WorkspaceHandle,
  sourceDirectory: string,
  options: StorageOptions = {},
) {
  const loaded = await loadCharacter(sourceDirectory)
  return withStore(
    workspace,
    async (transaction) => {
      const lock = await readLock(workspace)
      const existing = lock.characters.find(
        (item) => item.characterId === loaded.manifest.id,
      )
      if (existing) {
        if (existing.digest !== loaded.digest)
          throw new CharactersError(
            'CONFLICT',
            '角色 ID 已安装不同内容，不能隐式替换。',
            '使用后续显式升级流程。',
          )
        await inspectCharacter(workspace, existing.characterId)
        return { installed: existing, unchanged: true }
      }
      const ref = `packages/${loaded.manifest.id}/${loaded.digest}`
      for (const [name, bytes] of loaded.files)
        await transaction.put(`${ref}/${name}`, bytes)
      const installed: InstalledCharacter = {
        characterId: loaded.manifest.id,
        version: loaded.manifest.version,
        digest: loaded.digest,
        manifestRef: `${ref}/character.yaml`,
      }
      const updated = validate(charactersLockSchema, {
        ...lock,
        revision: lock.revision + 1,
        characters: [...lock.characters, installed],
      })
      await transaction.put(
        'characters.lock',
        jsonBytes(updated),
        sha256(jsonBytes(lock)),
      )
      return { installed, unchanged: false }
    },
    {
      ...options,
      fingerprint: sha256(
        canonicalJson({ operation: 'character.add', digest: loaded.digest }),
      ),
    },
  )
}
export async function workspaceStatus(workspace: WorkspaceHandle) {
  return withStore(workspace, async () => {
    const characters = (await readLock(workspace)).characters
    for (const character of characters)
      await inspectCharacter(workspace, character.characterId)
    const runtimeFiles = (
      await readdir(await containedPath(workspace.root, '.runtime'))
    ).filter(
      (name) =>
        ![
          'write.lock',
          'transactions',
          'receipts',
          'codex-executions',
          'service',
        ].includes(name),
    )
    const executionRoot = await containedPath(
      workspace.root,
      '.runtime/codex-executions',
    )
    const executionDirectories = (await exists(executionRoot))
      ? (await readdir(executionRoot)).length
      : 0
    let serviceArtifacts = 0
    const serviceRoot = await containedPath(workspace.root, '.runtime/service')
    if (await exists(serviceRoot)) {
      const entries = await readdir(serviceRoot)
      for (const name of entries) {
        await containedPath(workspace.root, `.runtime/service/${name}`)
        if (
          !/^(?:conn_[0-9a-f-]{36}\.token|admin-[0-9a-f-]{36}\.token|descriptor\.json|instance\.lock)$/.test(
            name,
          )
        )
          serviceArtifacts++
      }
      if (
        entries.includes('descriptor.json') &&
        entries.includes('instance.lock')
      ) {
        const descriptor = await readJson(
          workspace.root,
          '.runtime/service/descriptor.json',
          serviceDescriptorSchema,
          4096,
        )
        const owner = await readJson(
          workspace.root,
          '.runtime/service/instance.lock/owner.json',
          writeLockSchema,
          4096,
        )
        if (
          descriptor.workspaceId !== workspace.config.id ||
          descriptor.pid !== owner.pid ||
          descriptor.host !== owner.host ||
          descriptor.adminCredentialRef !==
            `.runtime/service/admin-${descriptor.generation}.token` ||
          !entries.includes(`admin-${descriptor.generation}.token`)
        )
          serviceArtifacts++
      } else if (
        entries.includes('descriptor.json') ||
        entries.includes('instance.lock')
      )
        serviceArtifacts++
    }
    return {
      id: workspace.config.id,
      schemaVersion: workspace.config.schemaVersion,
      policy: workspace.config.policy,
      adapter: workspace.config.runtime.adapter,
      characters,
      recovery:
        runtimeFiles.length + executionDirectories + serviceArtifacts
          ? 'inspection-required'
          : 'clean',
      runtimeArtifacts:
        runtimeFiles.length + executionDirectories + serviceArtifacts,
      executionDirectories,
      executionImplemented: true,
    }
  })
}
