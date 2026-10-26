import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { hostname } from 'node:os'
import { z } from 'zod'
import {
  CharactersError,
  containedPath,
  readBytes,
  readJson,
  jsonBytes,
  sha256,
  serviceDescriptorSchema,
} from '@characters/core'
import type { WorkspaceHandle } from '@characters/core'

const execute = promisify(execFile)
export const descriptorSchema = serviceDescriptorSchema
export const descriptorRef = '.runtime/service/descriptor.json'
export const secret = () => randomBytes(32).toString('hex')
export function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(sha256(a)), Buffer.from(sha256(b)))
}

/** Isolate credentials to current OS user and SYSTEM before writing secrets. */
export async function secureDirectory(
  workspace: WorkspaceHandle,
): Promise<void> {
  const directory = await containedPath(workspace.root, '.runtime/service')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (process.platform === 'win32') {
    const { stdout } = await execute(
      'whoami.exe',
      ['/user', '/fo', 'csv', '/nh'],
      { windowsHide: true, timeout: 10000 },
    )
    const sid = stdout.match(/S-1-[0-9-]+/)?.[0]
    if (!sid)
      throw new CharactersError(
        'PERMISSION_DENIED',
        '无法确认当前用户 SID。',
        '检查 Windows 用户权限。',
      )
    // DACL replacement removes inherited and existing broad grants on this private tree.
    // EncodedCommand avoids shell interpolation of workspace paths. PowerShell's
    // default nonterminating errors MUST be promoted before writing credentials.
    const encodedPath = Buffer.from(directory, 'utf8').toString('base64')
    const script = `$ErrorActionPreference = 'Stop'
$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
foreach ($value in @('${sid}', 'S-1-5-18')) {
  $identity = New-Object System.Security.Principal.SecurityIdentifier($value)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
$directoryInfo = New-Object System.IO.DirectoryInfo($target)
$directoryInfo.SetAccessControl($acl)
$actual = $directoryInfo.GetAccessControl()
if (!$actual.AreAccessRulesProtected) { throw 'Unprotected credential directory' }
$rules = $actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
if ($rules.Count -ne 2) { throw 'Unexpected credential ACL' }
foreach ($rule in $rules) {
  if ($rule.IdentityReference.Value -notin @('${sid}', 'S-1-5-18') -or $rule.AccessControlType -ne 'Allow') { throw 'Unexpected credential identity' }
}`
    await execute(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { windowsHide: true, timeout: 10000 },
    )
  } else await chmod(directory, 0o700)
}

export async function writePrivate(
  workspace: WorkspaceHandle,
  ref: string,
  bytes: Uint8Array,
): Promise<void> {
  const handle = await open(
    await containedPath(workspace.root, ref),
    'wx',
    0o600,
  )
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}
export async function publishDescriptor(
  workspace: WorkspaceHandle,
  descriptor: z.infer<typeof descriptorSchema>,
) {
  const temporary = `.runtime/service/descriptor-${descriptor.generation}.tmp`
  await writePrivate(
    workspace,
    temporary,
    jsonBytes(descriptorSchema.parse(descriptor)),
  )
  await rename(
    await containedPath(workspace.root, temporary),
    await containedPath(workspace.root, descriptorRef),
  )
}
export async function readDescriptor(workspace: WorkspaceHandle) {
  try {
    const descriptor = await readJson(
      workspace.root,
      descriptorRef,
      descriptorSchema,
      4096,
    )
    if (
      descriptor.workspaceId !== workspace.config.id ||
      descriptor.host !== hostname() ||
      descriptor.adminCredentialRef !==
        `.runtime/service/admin-${descriptor.generation}.token`
    )
      throw new Error('wrong-owner')
    return descriptor
  } catch {
    throw new CharactersError(
      'SERVICE_UNAVAILABLE',
      '管理服务描述符不可用。',
      '在该工作区运行 service serve。',
    )
  }
}
export async function removeOwned(workspace: WorkspaceHandle, ref: string) {
  await unlink(await containedPath(workspace.root, ref))
}
export async function privateToken(workspace: WorkspaceHandle, ref: string) {
  return (await readBytes(workspace.root, ref, 256)).toString('utf8').trim()
}
