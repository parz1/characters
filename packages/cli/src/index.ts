#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { runManagement } from './management.js'
import { runPlugin } from './plugin.js'
import { workspacePath } from './paths.js'
import {
  CharactersError,
  addCharacter,
  exitCode,
  failure,
  initWorkspace,
  listCharacters,
  openWorkspace,
  showCharacter,
  workspaceStatus,
  createWork,
  showWork,
  updateWork,
  importSource,
  addProposal,
  listProposals,
  applyProposal,
  readImportText,
  validate,
  revisionSchema,
  workSchema,
  sourceSchema,
  openSession,
  showSession,
  listSessions,
  setSessionStatus,
  sendSession,
  showSessionRun,
} from '@characters/core'
import { CodexCliAdapter, resolveCodex } from '@characters/adapters'
import type { StorageOptions } from '@characters/core'

const help = `characters — 本地角色、记忆与会话绑定管理

  workspace init [PATH]
  workspace status | workspace recover
  workspace migrate | workspace rollback --target service-v1
  service serve | service status | service stop
  gateway pair --workspace PATH --connection ID --host-session REF
  plugin codex prepare --output EMPTY_PATH [--workspace PATH --pairing REF]
  plugin codex doctor
  connection grant --host HOST --plugin PLUGIN --host-session REF --character ID [--project KEY] [--context KEY] [--action ACTION] [--ttl 3600] [--isolation strict|relaxed]
  connection list | connection revoke ID --expect-revision N
  binding list | binding show ID | binding revoke ID --expect-revision N
  memory list --character ID [--status candidate] [--limit 50] [--after MEMORY_ID]
  memory show MEMORY_ID --character ID
  memory confirm MEMORY_ID --character ID --expect-revision N [--fact-basis TEXT] [--replace-expect-revision N]
  memory reject | memory retract MEMORY_ID --character ID --expect-revision N [--reason TEXT]
  context import KEY --file FILE --expect-revision N
  context revoke KEY --expect-revision N
  context explain SNAPSHOT_ID --binding BINDING_ID [--content]
  character add PATH | character list | character show ID
  work create --title TEXT --author character:koto --lang cn --kind log [--mode character]
  work show ID [--revision N]
  work update ID --patch FILE --expect-revision N
  work source add ID --file FILE --title TEXT [--origin URL] [--visibility publishable] [--expect-revision N]
  work proposal add ID --file FILE --expect-revision N
  work proposal list ID
  work apply ID --proposal ID --expect-revision N [--request-id UUID]
  adapter doctor [--codex PATH]
  session open --character koto [--work ID] [--mode coauthor] [--lang cn]
  session list | session show ID | session close ID | session resume ID
  session send ID (--message TEXT | --file FILE) [--intent discuss|outline|draft] [--codex PATH] [--model MODEL]
  session run ID --run RUN_ID

默认数据目录为 characters 程序根目录下的 .local/data，与当前终端目录无关。
--workspace PATH 可覆盖默认位置。支持 --json。
角色安装与作品写入支持 --request-id UUID。打开工作区先恢复已准备事务。
数据仅写入显式工作区，不配置宿主全局人格或记忆。
session send 是早期独立 Codex CLI 试用，不自动读取新记忆。记忆业务使用管理服务。
管理服务先显式迁移，前台运行；默认 strict，无可信宿主会话证据时拒绝绑定。
service 不调用模型、不修改 Codex 全局配置；MCP 网关需显式配对，生产宿主验证器尚未实现，Codex strict 尚未验收。见 docs/mcp.md。
`

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const jsonRequested = argv.includes('--json')
  try {
    if (await runPlugin(argv)) return
    if (await runManagement(argv)) return
    let args
    try {
      args = parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        options: {
          workspace: { type: 'string' },
          json: { type: 'boolean' },
          help: { type: 'boolean', short: 'h' },
          title: { type: 'string' },
          author: { type: 'string', multiple: true },
          lang: { type: 'string' },
          kind: { type: 'string' },
          mode: { type: 'string' },
          patch: { type: 'string' },
          file: { type: 'string' },
          origin: { type: 'string' },
          visibility: { type: 'string' },
          proposal: { type: 'string' },
          'expect-revision': { type: 'string' },
          revision: { type: 'string' },
          'request-id': { type: 'string' },
          character: { type: 'string' },
          work: { type: 'string' },
          message: { type: 'string' },
          intent: { type: 'string' },
          codex: { type: 'string' },
          model: { type: 'string' },
          run: { type: 'string' },
        },
      })
    } catch {
      throw new CharactersError(
        'INVALID_INPUT',
        '命令参数不合法。',
        '使用 --help 查看命令格式。',
      )
    }
    const p = args.positionals
    const [group, action, value] = p
    const v = args.values
    if (v.help || !group) {
      if (v.json)
        console.log(JSON.stringify({ ok: true, data: { help }, error: null }))
      else process.stdout.write(help)
      return
    }
    const requireOption = (
      name:
        | 'workspace'
        | 'file'
        | 'title'
        | 'patch'
        | 'proposal'
        | 'character'
        | 'run',
    ): string => {
      const result = v[name]
      if (!result)
        throw new CharactersError(
          'INVALID_INPUT',
          `必须显式提供 --${name}。`,
          '使用 --help 检查格式；不会从 HOME 推断工作区。',
        )
      return result
    }
    const revision = (
      name: 'expect-revision' | 'revision',
      required = true,
    ): number | undefined => {
      const raw = v[name]
      if (raw === undefined && !required) return undefined
      if (!raw || !/^[1-9][0-9]*$/.test(raw))
        throw new CharactersError(
          'INVALID_INPUT',
          `--${name} 必须是正整数。`,
          '从 work show 读取版本。',
        )
      return validate(revisionSchema, Number(raw))
    }
    const jsonFile = async (filename: string): Promise<unknown> => {
      const contents = await readImportText(filename)
      try {
        return JSON.parse(contents) as unknown
      } catch {
        throw new CharactersError(
          'INVALID_INPUT',
          '导入文件不是有效 JSON。',
          '修正文件后重试。',
        )
      }
    }
    const options: StorageOptions = v['request-id']
      ? { requestId: v['request-id'] }
      : {}
    let commandOptions: string[] = []
    if (group === 'character' && action === 'add')
      commandOptions = ['request-id']
    if (group === 'adapter' && action === 'doctor') commandOptions = ['codex']
    if (group === 'session') {
      if (action === 'open')
        commandOptions = ['character', 'work', 'mode', 'lang', 'request-id']
      if (action === 'send')
        commandOptions = [
          'message',
          'file',
          'intent',
          'codex',
          'model',
          'request-id',
        ]
      if (action === 'run') commandOptions = ['run']
    }
    if (group === 'work') {
      if (action === 'create')
        commandOptions = [
          'title',
          'author',
          'lang',
          'kind',
          'mode',
          'request-id',
        ]
      if (action === 'show') commandOptions = ['revision']
      if (action === 'update')
        commandOptions = ['patch', 'expect-revision', 'request-id']
      if (action === 'apply')
        commandOptions = ['proposal', 'expect-revision', 'request-id']
      if (action === 'source')
        commandOptions = [
          'file',
          'title',
          'origin',
          'visibility',
          'expect-revision',
          'request-id',
        ]
      if (action === 'proposal' && value === 'add')
        commandOptions = ['file', 'expect-revision', 'request-id']
    }
    const allowed = new Set(['workspace', 'json', 'help', ...commandOptions])
    if (Object.keys(v).some((name) => !allowed.has(name)))
      throw new CharactersError(
        'INVALID_INPUT',
        '该命令不接受提供的选项。',
        '按 --help 选择当前命令的参数。',
      )
    let data: unknown
    if (
      group === 'workspace' &&
      action === 'init' &&
      (p.length === 2 || p.length === 3)
    ) {
      if (v.workspace || v['request-id'])
        throw new CharactersError(
          'INVALID_INPUT',
          'init 不接受 --workspace 或 --request-id。',
          '使用 workspace init PATH。',
        )
      const workspace = await initWorkspace(value ?? workspacePath())
      data = { root: workspace.root, ...(await workspaceStatus(workspace)) }
    } else {
      const known =
        (group === 'adapter' && action === 'doctor' && p.length === 2) ||
        (group === 'session' &&
          ((['open', 'list'].includes(action ?? '') && p.length === 2) ||
            (['show', 'close', 'resume', 'send', 'run'].includes(
              action ?? '',
            ) &&
              p.length === 3))) ||
        (group === 'workspace' &&
          ['status', 'recover'].includes(action ?? '') &&
          p.length === 2) ||
        (group === 'character' &&
          ((action === 'list' && p.length === 2) ||
            (['add', 'show'].includes(action ?? '') && p.length === 3))) ||
        (group === 'work' &&
          ((action === 'create' && p.length === 2) ||
            (['show', 'update', 'apply'].includes(action ?? '') &&
              p.length === 3) ||
            (action === 'source' && value === 'add' && p.length === 4) ||
            (action === 'proposal' &&
              ['add', 'list'].includes(value ?? '') &&
              p.length === 4)))
      if (!known)
        throw new CharactersError(
          'INVALID_INPUT',
          '命令不存在或参数不完整。',
          '使用 --help 查看 P2 支持范围。',
        )
      const workspace = await openWorkspace(workspacePath(v.workspace))
      if (group === 'adapter') {
        const adapter = new CodexCliAdapter({
          workspaceRoot: workspace.root,
          command: { executable: await resolveCodex(v.codex) },
        })
        await adapter.probe()
        data = adapter.diagnostics()
      } else if (group === 'session') {
        if (action === 'open') {
          if (v.mode && !['conversation', 'coauthor'].includes(v.mode))
            throw new CharactersError(
              'INVALID_INPUT',
              'mode 必须为 conversation 或 coauthor。',
              '按 --help 指定模式。',
            )
          data = await openSession(
            workspace,
            {
              characterId: requireOption('character'),
              language: validate(workSchema.shape.language, v.lang ?? 'cn'),
              mode: (v.mode ?? (v.work ? 'coauthor' : 'conversation')) as
                | 'conversation'
                | 'coauthor',
              ...(v.work ? { workId: v.work } : {}),
            },
            options,
          )
        } else if (action === 'list') data = await listSessions(workspace)
        else if (value && action === 'show')
          data = await showSession(workspace, value)
        else if (value && action === 'run')
          data = await showSessionRun(workspace, value, requireOption('run'))
        else if (value && (action === 'close' || action === 'resume'))
          data = await setSessionStatus(
            workspace,
            value,
            action === 'close' ? 'closed' : 'open',
          )
        else if (value && action === 'send') {
          if (Boolean(v.message) === Boolean(v.file))
            throw new CharactersError(
              'INVALID_INPUT',
              '必须且只能提供 --message 或 --file。',
              '长素材建议使用 UTF-8 文件。',
            )
          if (v.intent && !['discuss', 'outline', 'draft'].includes(v.intent))
            throw new CharactersError(
              'INVALID_INPUT',
              'intent 必须是 discuss、outline 或 draft。',
              '按 --help 指定写作意图。',
            )
          const adapter = new CodexCliAdapter({
            workspaceRoot: workspace.root,
            command: { executable: await resolveCodex(v.codex) },
            ...(v.model ? { model: v.model } : {}),
          })
          const controller = new AbortController()
          const cancel = () => controller.abort()
          process.once('SIGINT', cancel)
          try {
            data = await sendSession(
              workspace,
              value,
              v.file ? await readImportText(v.file) : v.message!,
              adapter,
              {
                ...(v['request-id'] ? { requestId: v['request-id'] } : {}),
                intent: (v.intent ?? 'discuss') as
                  | 'discuss'
                  | 'outline'
                  | 'draft',
                signal: controller.signal,
              },
            )
          } finally {
            process.removeListener('SIGINT', cancel)
          }
        }
      } else if (group === 'workspace') data = await workspaceStatus(workspace)
      else if (group === 'character') {
        if (action === 'list') data = await listCharacters(workspace)
        else if (action === 'add' && value)
          data = await addCharacter(workspace, value, options)
        else if (value) data = await showCharacter(workspace, value)
      } else if (action === 'create') {
        const input = {
          title: requireOption('title'),
          language: validate(workSchema.shape.language, v.lang),
          kind: validate(workSchema.shape.kind, v.kind),
          authors: v.author ?? [],
          ...(v.mode
            ? {
                mode: validate(workSchema.shape.attribution.shape.mode, v.mode),
              }
            : {}),
        }
        data = await createWork(workspace, input, options)
      } else if (action === 'show' && value)
        data = await showWork(workspace, value, revision('revision', false))
      else if (action === 'update' && value)
        data = await updateWork(
          workspace,
          value,
          revision('expect-revision')!,
          await jsonFile(requireOption('patch')),
          options,
        )
      else if (action === 'apply' && value)
        data = await applyProposal(
          workspace,
          value,
          requireOption('proposal'),
          revision('expect-revision')!,
          options,
        )
      else {
        const id = p[3]!
        if (action === 'source') {
          const expectedRevision = revision('expect-revision', false)
          data = await importSource(
            workspace,
            id,
            {
              title: requireOption('title'),
              text: await readImportText(requireOption('file')),
              ...(v.origin ? { origin: v.origin } : {}),
              ...(v.visibility
                ? {
                    visibility: validate(
                      sourceSchema.shape.visibility,
                      v.visibility,
                    ),
                  }
                : {}),
              ...(expectedRevision ? { expectedRevision } : {}),
            },
            options,
          )
        } else if (value === 'list') data = await listProposals(workspace, id)
        else
          data = await addProposal(
            workspace,
            id,
            revision('expect-revision')!,
            await jsonFile(requireOption('file')),
            options,
          )
      }
    }
    if (v.json) console.log(JSON.stringify({ ok: true, data, error: null }))
    else if (
      group === 'session' &&
      action === 'send' &&
      data &&
      typeof data === 'object' &&
      'reply' in data
    ) {
      console.log(String(data.reply))
      if ('proposalId' in data)
        console.log(`\n建议稿已保存：${String(data.proposalId)}（尚未应用）。`)
      if ('runId' in data) console.log(`执行：${String(data.runId)}`)
    } else {
      console.log('操作完成。')
      console.log(JSON.stringify(data, null, 2))
    }
  } catch (error) {
    const result = failure(error)
    if (jsonRequested) console.log(JSON.stringify(result))
    else if (!result.ok)
      console.error(`${result.error.message}\n下一步：${result.error.nextStep}`)
    if (!result.ok) process.exitCode = exitCode(result.error.code)
  }
}
await main()
