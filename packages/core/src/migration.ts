import { readdir } from 'node:fs/promises'
import { z } from 'zod'
import { CharactersError } from './errors.js'
import { containedPath, exists, readBytes } from './files.js'
import { sha256, utcNow } from './ids.js'
import {
  memorySchema,
  memoryV2Schema,
  migrationManifestSchema,
  serviceConfigSchema,
  characterIdSchema,
  idSchema,
} from './schemas.js'
import { canonicalJson, jsonBytes, readJson, withStore } from './storage.js'
import type { StorageOptions } from './storage.js'
import type { WorkspaceHandle } from './workspace.js'

export async function recordNames(
  workspace: WorkspaceHandle,
  ref: string,
): Promise<string[]> {
  const filename = await containedPath(workspace.root, ref)
  if (!(await exists(filename))) return []
  return (await readdir(filename)).sort()
}

/** Explicit, single WAL migration. Legacy workspace.yaml is never rewritten. */
export async function migrateService(
  workspace: WorkspaceHandle,
  rollback = false,
  options: StorageOptions = {},
) {
  return withStore(
    workspace,
    async (tx) => {
      if (
        await exists(
          await containedPath(workspace.root, '.runtime/service/instance.lock'),
        )
      )
        throw new CharactersError(
          'BUSY',
          '管理服务持有运行锁。',
          '先正常停止管理服务，再迁移。',
        )
      const manifestRef = 'migrations/service-v1/manifest.json'
      const present = await exists(
        await containedPath(workspace.root, manifestRef),
      )
      const previous = present
        ? await readJson(workspace.root, manifestRef, migrationManifestSchema)
        : undefined
      if (previous && previous.workspaceId !== workspace.config.id)
        throw new CharactersError(
          'STORE_CORRUPT',
          '迁移记录不属于当前工作区。',
          '检查备份。',
        )
      if (
        previous &&
        (new Set(previous.memories.map((item) => item.ref)).size !==
          previous.memories.length ||
          previous.memories.some((item) => {
            const match =
              /^states\/([a-z][a-z0-9-]*)\/memories\/(mem_[0-9a-f-]{36}\.json)$/.exec(
                item.ref,
              )
            return (
              !match ||
              item.backupRef !==
                `migrations/service-v1/backups/${match[1]}/${match[2]}`
            )
          }))
      )
        throw new CharactersError(
          'STORE_CORRUPT',
          '迁移备份路径无效。',
          '检查迁移记录。',
        )
      if (rollback && !previous)
        throw new CharactersError(
          'NOT_FOUND',
          '没有可回滚的迁移。',
          '先执行 workspace migrate。',
        )
      if (previous?.status === (rollback ? 'rolled-back' : 'applied'))
        return previous
      const configPresent = await exists(
        await containedPath(workspace.root, 'service.yaml'),
      )
      const config = configPresent
        ? await readJson(workspace.root, 'service.yaml', serviceConfigSchema)
        : undefined
      if (config && config.workspaceId !== workspace.config.id)
        throw new CharactersError(
          'STORE_CORRUPT',
          '服务配置不属于当前工作区。',
          '检查备份。',
        )
      // Rollback cannot discard any service-era records or edited memory.
      if (
        rollback &&
        ((await recordNames(workspace, 'connections')).length ||
          (await recordNames(workspace, 'bindings')).length)
      )
        throw new CharactersError(
          'CONFLICT',
          '已有服务数据，不能回滚。',
          '保留工作区，使用完整备份恢复。',
        )
      const memories: z.infer<typeof migrationManifestSchema>['memories'] = []
      for (const character of await recordNames(workspace, 'states')) {
        if (!characterIdSchema.safeParse(character).success)
          throw new CharactersError(
            'STORE_CORRUPT',
            '角色状态目录名无效。',
            '检查目录。',
          )
        for (const name of await recordNames(
          workspace,
          `states/${character}/memories`,
        )) {
          const id = name.endsWith('.json') ? name.slice(0, -5) : ''
          if (!idSchema('mem').safeParse(id).success)
            throw new CharactersError(
              'STORE_CORRUPT',
              '记忆目录包含未知文件。',
              '保留并检查目录。',
            )
          const ref = `states/${character}/memories/${name}`
          const bytes = await readBytes(workspace.root, ref, 1024 * 1024)
          const digest = sha256(bytes)
          if (rollback) {
            const entry = previous?.memories.find((item) => item.ref === ref)
            if (!entry || digest !== entry.after)
              throw new CharactersError(
                'CONFLICT',
                '迁移后记忆已改变，不能回滚。',
                '保留新版并从备份人工核对。',
              )
            const backup = await readBytes(
              workspace.root,
              entry.backupRef,
              1024 * 1024,
            )
            if (sha256(backup) !== entry.before)
              throw new CharactersError(
                'STORE_CORRUPT',
                '迁移备份损坏。',
                '恢复可信备份。',
              )
            await tx.put(ref, backup, digest)
            memories.push(entry)
          } else {
            const memory = await readJson(workspace.root, ref, memorySchema)
            if (memory.id !== id || memory.characterId !== character)
              throw new CharactersError(
                'STORE_CORRUPT',
                '记忆身份与路径不匹配。',
                '检查记忆文件。',
              )
            const upgraded = memoryV2Schema.parse({
              ...memory,
              schemaVersion: 2,
              workspaceId: workspace.config.id,
              scope: { purpose: 'legacy-import', contextKeys: [] },
            })
            const after = jsonBytes(upgraded)
            const backupRef = `migrations/service-v1/backups/${character}/${name}`
            await tx.put(backupRef, bytes)
            await tx.put(ref, after, digest)
            memories.push({
              ref,
              backupRef,
              before: digest,
              after: sha256(after),
            })
          }
        }
      }
      if (rollback && memories.length !== previous?.memories.length)
        throw new CharactersError(
          'CONFLICT',
          '迁移后的记忆丢失。',
          '先恢复文件再回滚。',
        )
      const manifest = migrationManifestSchema.parse({
        schemaVersion: 1,
        revision: (previous?.revision ?? 0) + 1,
        workspaceId: workspace.config.id,
        target: 'service-v1',
        status: rollback ? 'rolled-back' : 'applied',
        createdAt: previous?.createdAt ?? utcNow(),
        memories,
      })
      await tx.put(
        manifestRef,
        jsonBytes(manifest),
        present
          ? sha256(await readBytes(workspace.root, manifestRef, 1024 * 1024))
          : null,
      )
      await tx.put(
        'service.yaml',
        jsonBytes(
          serviceConfigSchema.parse({
            schemaVersion: 1,
            revision: (config?.revision ?? 0) + 1,
            workspaceId: workspace.config.id,
            enabled: !rollback,
            protocolVersion: 1,
            bindingTtlSeconds: 3600,
            defaultIsolation: 'strict',
            memoryWrite: 'confirm',
            contextBudgetBytes: 48000,
          }),
        ),
        configPresent
          ? sha256(await readBytes(workspace.root, 'service.yaml', 65536))
          : null,
      )
      return manifest
    },
    {
      ...options,
      fingerprint: sha256(
        canonicalJson({
          operation: 'workspace.migrate',
          target: 'service-v1',
          rollback,
        }),
      ),
    },
  )
}
