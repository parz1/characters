export const disabledFeatures = [
  'memories',
  'shell_tool',
  'shell_snapshot',
  'code_mode_host',
  'multi_agent',
  'apps',
  'plugins',
  'hooks',
  'browser_use',
  'computer_use',
  'image_generation',
  'view_image',
  'daemon_auto_start',
  'skill_search',
  'workspace_dependencies',
  'sleep_tool',
  'enable_request_compression',
  'goals',
]

export function codexArguments(options: {
  cwd: string
  home: string
  output: string
  schema: string
  model?: string
  overrides?: string[]
}): string[] {
  const args = [
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--strict-config',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--json',
    '--color',
    'never',
    '--cd',
    options.cwd,
    '--output-schema',
    options.schema,
    '--output-last-message',
    options.output,
  ]
  for (const feature of disabledFeatures) args.push('--disable', feature)
  args.push('--enable', 'skip_host_skill_discovery')
  for (const override of [
    'memories.use_memories=false',
    'memories.generate_memories=false',
    'history.persistence="none"',
    'project_doc_max_bytes=0',
    'project_doc_fallback_filenames=[]',
    'web_search="disabled"',
    'mcp_servers={}',
    'personality="none"',
    'shell_environment_policy.inherit="none"',
    `sqlite_home=${JSON.stringify(options.home.replaceAll('\\', '/') + '/sqlite')}`,
    'suppress_unstable_features_warning=true',
    ...(options.overrides ?? []),
  ])
    args.push('-c', override)
  if (options.model) args.push('--model', options.model)
  args.push('-')
  return args
}

export function inspectEvent(line: string): void {
  const event = JSON.parse(line) as { type?: string; item?: { type?: string } }
  if (!event.type) throw new Error('missing type')
  if (
    event.type === 'item.started' ||
    event.type === 'item.completed' ||
    event.type === 'item.updated'
  ) {
    if (
      !['agent_message', 'reasoning', 'error'].includes(event.item?.type ?? '')
    )
      throw new Error('tools are disabled')
  }
}
