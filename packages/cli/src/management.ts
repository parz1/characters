import { parseArgs } from 'node:util'
import {
  CharactersError,
  migrateService,
  openWorkspace,
  readImportText,
} from '@characters/core'
import { managementRequest, startService } from '@characters/service'
import { workspacePath } from './paths.js'

export async function runManagement(argv: string[]): Promise<boolean> {
  const group = argv[0],
    command = argv[1]
  if (
    !(
      ['service', 'connection', 'binding', 'memory', 'context'].includes(
        group ?? '',
      ) ||
      (group === 'workspace' && ['migrate', 'rollback'].includes(command ?? ''))
    )
  )
    return false
  let args
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        workspace: { type: 'string' },
        json: { type: 'boolean' },
        target: { type: 'string' },
        host: { type: 'string' },
        plugin: { type: 'string' },
        'host-session': { type: 'string' },
        character: { type: 'string', multiple: true },
        project: { type: 'string', multiple: true },
        context: { type: 'string', multiple: true },
        action: { type: 'string', multiple: true },
        isolation: { type: 'string' },
        ttl: { type: 'string' },
        'expect-revision': { type: 'string' },
        'request-id': { type: 'string' },
        file: { type: 'string' },
        binding: { type: 'string' },
        content: { type: 'boolean' },
        reason: { type: 'string' },
        'fact-basis': { type: 'string' },
        'replace-expect-revision': { type: 'string' },
        status: { type: 'string' },
        limit: { type: 'string' },
        after: { type: 'string' },
      },
    })
  } catch {
    throw new CharactersError(
      'INVALID_INPUT',
      '管理命令参数无效。',
      '检查命令及选项。',
    )
  }
  const values = args.values
  const required = (value: string | undefined, name: string): string => {
    if (!value)
      throw new CharactersError(
        'INVALID_INPUT',
        `缺少 ${name}。`,
        '提供显式参数。',
      )
    return value
  }
  const key = `${group} ${command}`
  const allowed: Record<string, string[]> = {
    'memory list': ['character', 'status', 'limit', 'after'],
    'memory show': ['character'],
    'memory confirm': [
      'character',
      'expect-revision',
      'reason',
      'fact-basis',
      'replace-expect-revision',
    ],
    'memory reject': ['character', 'expect-revision', 'reason'],
    'memory retract': ['character', 'expect-revision', 'reason'],
    'context import': ['file', 'expect-revision'],
    'context revoke': ['expect-revision'],
    'context explain': ['binding', 'content'],
    'workspace migrate': ['target'],
    'workspace rollback': ['target'],
    'service serve': [],
    'service status': [],
    'service stop': [],
    'connection grant': [
      'host',
      'plugin',
      'host-session',
      'character',
      'project',
      'context',
      'action',
      'isolation',
      'ttl',
    ],
    'connection list': [],
    'connection revoke': ['expect-revision'],
    'binding list': [],
    'binding show': [],
    'binding revoke': ['expect-revision'],
  }
  const extraPosition = [
    'connection revoke',
    'binding show',
    'binding revoke',
    'memory show',
    'memory confirm',
    'memory reject',
    'memory retract',
    'context import',
    'context revoke',
    'context explain',
  ].includes(key)
  if (
    !allowed[key] ||
    args.positionals.length !== (extraPosition ? 3 : 2) ||
    Object.keys(values).some(
      (option) =>
        !['workspace', 'json', 'request-id', ...(allowed[key] ?? [])].includes(
          option,
        ),
    )
  )
    throw new CharactersError(
      'INVALID_INPUT',
      '管理命令或选项不受支持。',
      '查看 docs/service.md。',
    )
  const workspace = await openWorkspace(workspacePath(values.workspace))
  const output = (data: unknown) =>
    process.stdout.write(
      `${JSON.stringify({ ok: true, data, error: null }, null, values.json ? undefined : 2)}\n`,
    )
  if (group === 'workspace') {
    if (values.target !== 'service-v1')
      throw new CharactersError(
        'INVALID_INPUT',
        '迁移需要 --target service-v1。',
        '显式确认迁移目标。',
      )
    output(
      await migrateService(
        workspace,
        command === 'rollback',
        values['request-id']
          ? {
              requestId: values['request-id'],
              fingerprint: `${key}:service-v1`,
            }
          : {},
      ),
    )
  } else if (key === 'service serve') {
    const service = await startService(workspace)
    const shutdown = () => {
      void service.close().catch(() => {
        process.exitCode = 7
      })
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
    output({ status: 'running', ...service.descriptor })
    await service.closed
    process.off('SIGINT', shutdown)
    process.off('SIGTERM', shutdown)
  } else {
    let params: unknown = {}
    if (group === 'memory') {
      if (values.character?.length !== 1)
        throw new CharactersError(
          'INVALID_INPUT',
          '记忆操作需要一个明确的 --character。',
          '指定记忆所属角色。',
        )
      params = {
        characterId: values.character[0],
        ...(command === 'list'
          ? {
              ...(values.status ? { status: values.status } : {}),
              ...(values.limit ? { limit: Number(values.limit) } : {}),
              ...(values.after ? { after: values.after } : {}),
            }
          : { id: args.positionals[2] }),
        ...(['confirm', 'reject', 'retract'].includes(command ?? '')
          ? {
              expectedRevision: Number(
                required(values['expect-revision'], '--expect-revision'),
              ),
            }
          : {}),
        ...(values.reason ? { reason: values.reason } : {}),
        ...(values['fact-basis'] ? { factBasis: values['fact-basis'] } : {}),
        ...(values['replace-expect-revision']
          ? {
              replaceExpectedRevision: Number(
                values['replace-expect-revision'],
              ),
            }
          : {}),
      }
    } else if (group === 'context') {
      if (command === 'explain')
        params = {
          bindingId: required(values.binding, '--binding'),
          snapshotId: args.positionals[2],
          content: values.content ?? false,
        }
      else
        params = {
          key: args.positionals[2],
          expectedRevision: Number(
            required(values['expect-revision'], '--expect-revision'),
          ),
          ...(command === 'import'
            ? {
                text: await readImportText(
                  required(values.file, '--file'),
                  16384,
                ),
              }
            : {}),
        }
    } else if (key === 'connection grant')
      params = {
        hostId: required(values.host, '--host'),
        pluginId: required(values.plugin, '--plugin'),
        hostSessionRef: required(values['host-session'], '--host-session'),
        characterIds: values.character ?? [],
        allowedProjectKeys: values.project ?? [],
        allowedContextKeys: values.context ?? [],
        actions: values.action ?? ['discover', 'bind'],
        isolation: values.isolation ?? 'strict',
        ttlSeconds: Number(values.ttl ?? '3600'),
      }
    else if (extraPosition)
      params = {
        id: args.positionals[2],
        ...(key.endsWith('revoke')
          ? {
              expectedRevision: Number(
                required(values['expect-revision'], '--expect-revision'),
              ),
            }
          : {}),
      }
    output(
      await managementRequest(
        workspace,
        `${group}.${command}`,
        params,
        values['request-id'],
      ),
    )
  }
  return true
}
