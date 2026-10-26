import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import {
  CharactersError,
  directoryRoot,
  openWorkspace,
  readJson,
} from '@characters/core'
import { gatewayPairingSchema, pairGateway, pairingRef } from '@characters/mcp'

export async function runPlugin(argv: string[]): Promise<boolean> {
  if (argv[0] !== 'plugin' && argv[0] !== 'gateway') return false
  let args
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        output: { type: 'string' },
        workspace: { type: 'string' },
        pairing: { type: 'string' },
        connection: { type: 'string' },
        'host-session': { type: 'string' },
        json: { type: 'boolean' },
      },
    })
  } catch {
    throw new CharactersError(
      'INVALID_INPUT',
      '接入命令参数无效。',
      '查看 --help。',
    )
  }
  const v = args.values
  const key = args.positionals.join(' ')
  const required = (value: string | undefined): string => {
    if (!value)
      throw new CharactersError(
        'INVALID_INPUT',
        '需要显式提供参数。',
        '配对需 workspace/connection/host-session，准备包需 output。',
      )
    return value
  }
  const allowed: Record<string, string[]> = {
    'gateway pair': ['workspace', 'connection', 'host-session'],
    'plugin codex prepare': ['output', 'workspace', 'pairing'],
    'plugin codex doctor': [],
  }
  const options = allowed[key]
  if (
    !options ||
    Object.keys(v).some((name) => name !== 'json' && !options.includes(name))
  )
    throw new CharactersError(
      'INVALID_INPUT',
      '未知接入命令或多余选项。',
      '使用 --help。',
    )
  let data: unknown
  if (key === 'gateway pair') {
    data = await pairGateway(
      await openWorkspace(required(v.workspace)),
      required(v.connection),
      required(v['host-session']),
    )
  } else if (key === 'plugin codex doctor') {
    data = {
      pluginVersion: '0.1.0',
      protocolVersion: 1,
      strictReady: false,
      hostPolicyVerifier: 'unavailable',
      existingSessionControl: 'unknown',
      checks: {
        packaging: 'compatibility-template',
        sessionCorrelation: 'requires-paired-transport-metadata',
        memoryRead: 'unknown',
        memoryGeneration: 'unknown',
        toolBudget: 'unknown',
      },
      nextStep: '生产宿主验证器和真实原生交互尚未验收；strict 保持拒绝。',
    }
  } else {
    if (!!v.workspace !== !!v.pairing)
      throw new CharactersError(
        'INVALID_INPUT',
        '本机配置需同时指定 workspace 与 pairing。',
        '或均不提供以生成通用模板。',
      )
    let config: unknown = JSON.parse(
      await readFile(
        fileURLToPath(
          new URL('../../../plugins/codex/.mcp.json', import.meta.url),
        ),
        'utf8',
      ),
    )
    if (v.workspace && v.pairing) {
      const workspace = await openWorkspace(v.workspace)
      const pairing = await readJson(
        workspace.root,
        v.pairing,
        gatewayPairingSchema,
        4096,
      )
      if (
        v.pairing !== pairingRef(pairing.connectionId) ||
        pairing.workspaceId !== workspace.config.id ||
        pairing.hostId !== 'codex-cli' ||
        pairing.pluginId !== 'characters'
      )
        throw new CharactersError(
          'PERMISSION_DENIED',
          '配对不属于 Codex characters 插件。',
          '检查授权的 host/plugin/workspace。',
        )
      config = {
        mcpServers: {
          characters: {
            command: process.execPath,
            args: [
              fileURLToPath(
                new URL('../../mcp/dist/stdio.js', import.meta.url),
              ),
              '--workspace',
              workspace.root,
              '--pairing',
              v.pairing,
            ],
          },
        },
      }
    }
    const output = path.resolve(required(v.output))
    await mkdir(output, { recursive: true })
    const root = await directoryRoot(output)
    if ((await readdir(root)).length)
      throw new CharactersError(
        'CONFLICT',
        '插件输出目录必须为空。',
        '选择新目录；不会覆盖文件。',
      )
    for (const ref of [
      '.codex-plugin/plugin.json',
      'skills/characters/SKILL.md',
      'README.md',
    ]) {
      const target = path.join(root, ref)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(
        target,
        await readFile(
          fileURLToPath(
            new URL(`../../../plugins/codex/${ref}`, import.meta.url),
          ),
        ),
        { flag: 'wx' },
      )
    }
    await writeFile(
      path.join(root, '.mcp.json'),
      `${JSON.stringify(config, null, 2)}\n`,
      { flag: 'wx' },
    )
    data = {
      output: root,
      configured: !!v.workspace,
      installed: false,
      hostSettingsChanged: false,
      strictReady: false,
    }
  }
  process.stdout.write(`${JSON.stringify({ ok: true, data, error: null })}\n`)
  return true
}
