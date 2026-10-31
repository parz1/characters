import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { mkdir, readdir, writeFile, readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import {
  CharactersError,
  directoryRoot,
  openWorkspace,
  readJson,
  usageKeySchema,
} from '@characters/core'
import { gatewayPairingSchema, pairingRef } from '@characters/mcp'

export async function runDshPlugin(argv: string[]): Promise<boolean> {
  if (argv[0] !== 'plugin' || argv[1] !== 'dsh') return false
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
        'project-root': { type: 'string' },
        project: { type: 'string' },
        json: { type: 'boolean' },
      },
    })
  } catch {
    throw new CharactersError(
      'INVALID_INPUT',
      'dsh 接入参数无效。',
      '查看 --help。',
    )
  }
  const v = args.values
  const key = args.positionals.join(' ')
  if (
    key === 'plugin dsh doctor' &&
    Object.keys(v).every((name) => name === 'json')
  ) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        data: {
          pluginVersion: '0.1.0',
          protocolVersion: 1,
          sdkBaseline: '0.2.1-rc.3',
          nativeHostInstalled: 'unverified',
          strictReady: false,
          memoryRead: 'unknown',
          memoryGeneration: 'unknown',
          toolBudget: 'unverified',
          nextStep:
            '在实际安装的 dsh 中验证会话关联、完整输入预算及记忆读写；没有可信服务端验证器时 strict 继续拒绝。',
        },
        error: null,
      })}\n`,
    )
    return true
  }
  if (
    key !== 'plugin dsh prepare' ||
    !v.output ||
    (!!v.pairing && !v.workspace)
  )
    throw new CharactersError(
      'INVALID_INPUT',
      '需要空输出目录，pairing 需要 workspace。',
      'plugin dsh prepare --output EMPTY_PATH [--workspace PATH --project-root BLOG_PATH --project blog [--pairing REF]]',
    )
  let config: unknown = {}
  if (v.workspace) {
    if (!v['project-root'])
      throw new CharactersError(
        'INVALID_INPUT',
        '配置 dsh 配对需显式 project-root。',
        '选择实际 blog 项目目录。',
      )
    const workspace = await openWorkspace(v.workspace)
    if (v.pairing) {
      const pairing = await readJson(
        workspace.root,
        v.pairing,
        gatewayPairingSchema,
        4096,
      )
      if (
        pairing.hostId !== 'dsh' ||
        pairing.pluginId !== 'characters-dsh' ||
        pairing.workspaceId !== workspace.config.id ||
        v.pairing !== pairingRef(pairing.connectionId)
      )
        throw new CharactersError(
          'PERMISSION_DENIED',
          '配对不是本工作区的 dsh 授权。',
          '使用 dsh / characters-dsh 和当前原生 session ID 配对。',
        )
    }
    config = {
      workspace: workspace.root,
      ...(v.pairing ? { pairing: v.pairing } : {}),
      projectRoot: await directoryRoot(v['project-root']),
      projectKey: usageKeySchema.parse(v.project ?? 'blog'),
    }
  } else if (v['project-root'] || v.project)
    throw new CharactersError(
      'INVALID_INPUT',
      '项目范围需与工作区配对一起配置。',
      '或省略它们生成仅含诊断工具的通用包。',
    )
  const output = path.resolve(v.output)
  await mkdir(output, { recursive: true })
  const root = await directoryRoot(output)
  if ((await readdir(root)).length)
    throw new CharactersError(
      'CONFLICT',
      'dsh 输出目录必须为空。',
      '选择新目录，不覆盖配置。',
    )
  // Bundle only our implementation. Resolve actual native contracts from the host.
  await build({
    entryPoints: [
      fileURLToPath(
        new URL('../../../plugins/dsh/dist/index.js', import.meta.url),
      ),
    ],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: ['@deepseek-ai/*'],
    outfile: path.join(root, 'index.js'),
    logLevel: 'silent',
    banner: {
      js: "import { createRequire as charactersCreateRequire } from 'node:module'; const require = charactersCreateRequire(import.meta.url);",
    },
  })
  await writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify(
      {
        name: 'characters-dsh-local',
        version: '0.1.0',
        private: true,
        type: 'module',
        main: './index.js',
        exports: './index.js',
        engines: { dsh: '0.2.1-rc.3' },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
        peerDependencies: { '@deepseek-ai/dsh-tools': '0.2.1-rc.3' },
      },
      null,
      2,
    )}\n`,
    { flag: 'wx' },
  )
  // JSON is a YAML subset; no executable YAML tags or interpolated paths.
  await writeFile(
    path.join(root, 'cordis.patch.yml'),
    `${JSON.stringify([{ insert: [{ id: 'characters', name: 'characters-dsh-local', config }] }], null, 2)}\n`,
    { flag: 'wx' },
  )
  await writeFile(
    path.join(root, 'README.md'),
    await readFile(
      fileURLToPath(new URL('../../../plugins/dsh/README.md', import.meta.url)),
    ),
    { flag: 'wx' },
  )
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      data: {
        output: root,
        configured: !!v.workspace,
        installed: false,
        hostSettingsChanged: false,
        strictReady: false,
        sdkBaseline: '0.2.1-rc.3',
      },
      error: null,
    })}\n`,
  )
  return true
}
