import { z } from 'zod'
import { readdir } from 'node:fs/promises'
import { CharactersError } from './errors.js'
import { containedPath, readBytes, decodeUtf8, exists } from './files.js'
import { newId, sha256, utcNow } from './ids.js'
import {
  workSchema,
  sourceSchema,
  proposalSchema,
  revisionManifestSchema,
  revisionSchema,
  idSchema,
  charactersLockSchema,
} from './schemas.js'
import type { WorkRecord, SourceRecord, ProposalRecord } from './schemas.js'
import { validate } from './validation.js'
import { withStore, readJson, jsonBytes, canonicalJson } from './storage.js'
import type { FileTransaction, StorageOptions } from './storage.js'
import type { WorkspaceHandle } from './workspace.js'

const LIMIT = 1024 * 1024
async function snapshotBytes(
  workspace: WorkspaceHandle,
  ref: string,
): Promise<Buffer> {
  try {
    return await readBytes(workspace.root, ref, LIMIT)
  } catch (error) {
    if (
      error instanceof CharactersError &&
      ['NOT_FOUND', 'INVALID_INPUT'].includes(error.code)
    )
      throw new CharactersError(
        'STORE_CORRUPT',
        '作品或来源快照缺失或超过约定大小。',
        '保留数据并从可信备份恢复。',
      )
    throw error
  }
}
const sourceList = z.array(sourceSchema).max(512)
export const createWorkInputSchema = z.strictObject({
  title: workSchema.shape.title,
  language: workSchema.shape.language,
  kind: workSchema.shape.kind,
  authors: workSchema.shape.attribution.shape.authors,
  mode: workSchema.shape.attribution.shape.mode.optional(),
})
export const updateWorkInputSchema = z.strictObject({
  title: workSchema.shape.title.optional(),
  attribution: workSchema.shape.attribution.optional(),
  stage: workSchema.shape.stage.optional(),
  publication: workSchema.shape.publication,
  briefSourceId: idSchema('src').optional(),
  sourceVisibility: z
    .record(idSchema('src'), sourceSchema.shape.visibility)
    .optional(),
})
export const proposalInputSchema = z.strictObject({
  target: proposalSchema.shape.target,
  content: proposalSchema.shape.content.max(LIMIT),
  sourceIds: z.array(idSchema('src')),
})
export interface WorkView {
  record: WorkRecord
  brief: string
  outline: string
  draft: string
  sources: SourceRecord[]
}

function optionsFor(options: StorageOptions, input: unknown): StorageOptions {
  return { ...options, fingerprint: sha256(canonicalJson(input)) }
}
function workRef(id: string): string {
  validate(idSchema('work'), id)
  return `works/${id}`
}
function conflict(): never {
  throw new CharactersError(
    'CONFLICT',
    '作品版本已经改变，建议稿未被覆盖或应用。',
    '读取最新作品后重新修改；保留原建议稿供比较。',
  )
}

async function verifyAuthors(
  workspace: WorkspaceHandle,
  authors: string[],
): Promise<void> {
  const lock = await readJson(
    workspace.root,
    'characters.lock',
    charactersLockSchema,
  )
  if (
    authors.some(
      (author) =>
        author.startsWith('character:') &&
        !lock.characters.some((role) => role.characterId === author.slice(10)),
    )
  )
    throw new CharactersError(
      'NOT_FOUND',
      '署名角色尚未安装。',
      '安装角色或修正署名。',
    )
  if (new Set(authors).size !== authors.length)
    throw new CharactersError(
      'INVALID_INPUT',
      '作者不能重复。',
      '为每位作者保留一个稳定 ID。',
    )
}

async function loadView(
  workspace: WorkspaceHandle,
  id: string,
  requestedRevision?: number,
): Promise<WorkView> {
  const root = workRef(id)
  const current = await readJson(
    workspace.root,
    `${root}/work.json`,
    workSchema,
  )
  if (current.id !== id || current.contentRevision !== current.revision)
    throw new CharactersError(
      'STORE_CORRUPT',
      '作品指针与版本不一致。',
      '检查作品记录或恢复备份。',
    )
  const desired = requestedRevision ?? current.revision
  validate(revisionSchema, desired)
  if (desired > current.revision)
    throw new CharactersError('NOT_FOUND', '作品版本不存在。', '选择已有版本。')
  let expectedDigest = current.contentDigest
  let manifest
  let record = current
  for (let version = current.revision; version >= desired; version--) {
    const ref = `${root}/revisions/${version}/revision.json`
    const bytes = await snapshotBytes(workspace, ref)
    if (sha256(bytes) !== expectedDigest)
      throw new CharactersError(
        'STORE_CORRUPT',
        '作品版本清单摘要不匹配。',
        '保留损坏文件并检查可信备份。',
      )
    manifest = await readJson(
      workspace.root,
      ref,
      revisionManifestSchema,
      LIMIT,
    )
    if (
      manifest.workId !== id ||
      manifest.revision !== version ||
      manifest.record.id !== id ||
      manifest.record.revision !== version ||
      manifest.record.contentRevision !== version ||
      (version === 1
        ? manifest.previousDigest !== null
        : manifest.previousDigest === null)
    )
      throw new CharactersError(
        'STORE_CORRUPT',
        '作品版本链不合法。',
        '检查版本清单。',
      )
    record = validate(
      workSchema,
      { ...manifest.record, contentDigest: expectedDigest },
      'STORE_CORRUPT',
    )
    if (
      version === current.revision &&
      canonicalJson(record) !== canonicalJson(current)
    )
      throw new CharactersError(
        'STORE_CORRUPT',
        '作品元数据与不可变版本不一致。',
        '检查指针是否被外部修改。',
      )
    expectedDigest = manifest.previousDigest ?? ''
  }
  if (!manifest)
    throw new CharactersError(
      'STORE_CORRUPT',
      '缺少作品清单。',
      '检查作品版本。',
    )
  const body: Record<string, string> = {}
  for (const [name, digest] of Object.entries(manifest.files)) {
    const bytes = await snapshotBytes(
      workspace,
      `${root}/revisions/${desired}/${name}`,
    )
    if (sha256(bytes) !== digest)
      throw new CharactersError(
        'STORE_CORRUPT',
        '作品正文或来源列表被修改。',
        '从可信备份恢复该版本。',
      )
    body[name] = decodeUtf8(bytes)
  }
  const sources = await readJson(
    workspace.root,
    `${root}/revisions/${desired}/sources.json`,
    sourceList,
    LIMIT,
  )
  if (new Set(sources.map((source) => source.id)).size !== sources.length)
    throw new CharactersError(
      'STORE_CORRUPT',
      '来源列表包含重复 ID。',
      '检查版本数据。',
    )
  for (const source of sources) await readSourceText(workspace, source)
  return {
    record,
    brief: body['brief.md'] ?? '',
    outline: body['outline.md'] ?? '',
    draft: body['draft.md'] ?? '',
    sources,
  }
}

async function readSourceText(
  workspace: WorkspaceHandle,
  source: SourceRecord,
): Promise<string> {
  if (source.snapshotRef !== `objects/${source.digest}.txt`)
    throw new CharactersError(
      'STORE_CORRUPT',
      '来源引用不属于内容对象目录。',
      '检查来源记录。',
    )
  const bytes = await snapshotBytes(workspace, source.snapshotRef)
  if (sha256(bytes) !== source.digest)
    throw new CharactersError(
      'STORE_CORRUPT',
      '来源快照被修改。',
      '从可信副本恢复来源。',
    )
  return decodeUtf8(bytes)
}

async function stageVersion(
  transaction: FileTransaction,
  view: WorkView,
  expected: WorkRecord | null,
): Promise<WorkRecord> {
  const record = { ...view.record }
  const contents = {
    'brief.md': Buffer.from(view.brief),
    'outline.md': Buffer.from(view.outline),
    'draft.md': Buffer.from(view.draft),
    'sources.json': jsonBytes(view.sources),
  }
  if (Object.values(contents).some((bytes) => bytes.length > LIMIT))
    throw new CharactersError(
      'INVALID_INPUT',
      '作品文档超过 1 MiB。',
      '缩减内容后重试。',
    )
  const { contentDigest: _digest, ...metadata } = record
  const manifest = validate(revisionManifestSchema, {
    schemaVersion: 1,
    workId: record.id,
    revision: record.revision,
    previousDigest: expected?.contentDigest ?? null,
    record: metadata,
    files: Object.fromEntries(
      Object.entries(contents).map(([name, bytes]) => [name, sha256(bytes)]),
    ),
  })
  const manifestBytes = jsonBytes(manifest)
  record.contentDigest = sha256(manifestBytes)
  const recordBytes = jsonBytes(record)
  if (manifestBytes.length > LIMIT || recordBytes.length > LIMIT)
    throw new CharactersError(
      'INVALID_INPUT',
      '作品元数据超过 1 MiB。',
      '缩减标题或其他元数据。',
    )
  const root = workRef(record.id)
  for (const [name, bytes] of Object.entries(contents))
    await transaction.put(`${root}/revisions/${record.revision}/${name}`, bytes)
  await transaction.put(
    `${root}/revisions/${record.revision}/revision.json`,
    manifestBytes,
  )
  // Compare against the record we actually used, never a late re-read that
  // could accidentally bless an intervening external edit as our base.
  const before = expected ? sha256(jsonBytes(expected)) : null
  await transaction.put(`${root}/work.json`, recordBytes, before)
  return record
}

export async function createWork(
  workspace: WorkspaceHandle,
  input: z.input<typeof createWorkInputSchema>,
  options: StorageOptions = {},
): Promise<WorkRecord> {
  const data = validate(createWorkInputSchema, input)
  return withStore(
    workspace,
    async (transaction) => {
      await verifyAuthors(workspace, data.authors)
      if (data.authors.length > 1 && !data.mode)
        throw new CharactersError(
          'INVALID_INPUT',
          '多人署名需要指定 mode。',
          '选择 human、character 或 dialogue。',
        )
      const now = utcNow()
      const record = validate(workSchema, {
        schemaVersion: 1,
        id: newId('work'),
        revision: 1,
        title: data.title,
        language: data.language,
        kind: data.kind,
        attribution: {
          mode:
            data.mode ??
            (data.authors[0]?.startsWith('character:') ? 'character' : 'human'),
          authors: data.authors,
          contributors: [],
        },
        stage: 'discussion',
        contentRevision: 1,
        contentDigest: sha256(''),
        createdAt: now,
        updatedAt: now,
      })
      return stageVersion(
        transaction,
        { record, brief: '', outline: '', draft: '', sources: [] },
        null,
      )
    },
    optionsFor(options, { operation: 'work.create', data }),
  )
}

export async function showWork(
  workspace: WorkspaceHandle,
  id: string,
  revision?: number,
): Promise<WorkView> {
  return withStore(workspace, async () => loadView(workspace, id, revision))
}

export async function updateWork(
  workspace: WorkspaceHandle,
  id: string,
  expectedRevision: number,
  input: unknown,
  options: StorageOptions = {},
): Promise<WorkRecord> {
  validate(revisionSchema, expectedRevision)
  const patch = validate(updateWorkInputSchema, input)
  if (!Object.keys(patch).length)
    throw new CharactersError(
      'INVALID_INPUT',
      '修改不能为空。',
      '提供需要修改的字段。',
    )
  return withStore(
    workspace,
    async (transaction) => {
      const view = await loadView(workspace, id)
      if (view.record.revision !== expectedRevision) conflict()
      const before = view.record
      const { briefSourceId, sourceVisibility, ...metadata } = patch
      if (metadata.stage === 'ready' && Object.keys(patch).length !== 1)
        throw new CharactersError(
          'INVALID_INPUT',
          'ready 只允许作为单独的审阅决定。',
          '先修改作品，再审阅最新版本。',
        )
      if (metadata.attribution)
        await verifyAuthors(workspace, metadata.attribution.authors)
      if (briefSourceId) {
        const source = view.sources.find((item) => item.id === briefSourceId)
        if (!source)
          throw new CharactersError(
            'NOT_FOUND',
            'brief 来源不属于当前作品。',
            '先导入来源。',
          )
        view.brief = await readSourceText(workspace, source)
      }
      for (const [sourceId, visibility] of Object.entries(
        sourceVisibility ?? {},
      )) {
        const source = view.sources.find((item) => item.id === sourceId)
        if (!source)
          throw new CharactersError(
            'NOT_FOUND',
            '来源可见性修改引用了其他作品的来源。',
            '使用当前作品的 sourceId。',
          )
        source.visibility = visibility
      }
      view.record = validate(workSchema, {
        ...before,
        ...metadata,
        revision: before.revision + 1,
        contentRevision: before.revision + 1,
        updatedAt: utcNow(),
        stage:
          metadata.stage === 'ready'
            ? 'ready'
            : before.stage === 'ready'
              ? 'review'
              : (metadata.stage ?? before.stage),
      })
      return stageVersion(transaction, view, before)
    },
    optionsFor(options, {
      operation: 'work.update',
      id,
      expectedRevision,
      patch,
    }),
  )
}

export async function importSource(
  workspace: WorkspaceHandle,
  id: string,
  input: {
    title: string
    text: string
    origin?: string
    visibility?: 'private' | 'publishable'
    expectedRevision?: number
  },
  options: StorageOptions = {},
) {
  if (Buffer.byteLength(input.text) > LIMIT)
    throw new CharactersError(
      'INVALID_INPUT',
      '来源超过 1 MiB。',
      '缩减来源内容。',
    )
  const digest = sha256(input.text)
  const fingerprint = {
    operation: 'work.source.add',
    id,
    ...input,
    text: digest,
  }
  return withStore(
    workspace,
    async (transaction) => {
      const view = await loadView(workspace, id)
      const before = view.record
      if (
        input.expectedRevision !== undefined &&
        validate(revisionSchema, input.expectedRevision) !== before.revision
      )
        conflict()
      const source = validate(sourceSchema, {
        id: newId('src'),
        kind: input.origin ? 'url-snapshot' : 'file',
        title: input.title,
        snapshotRef: `objects/${digest}.txt`,
        digest,
        ...(input.origin ? { origin: input.origin } : {}),
        capturedAt: utcNow(),
        visibility: input.visibility ?? 'private',
      })
      if (!input.text.trim())
        throw new CharactersError(
          'INVALID_INPUT',
          '来源正文不能为空。',
          '提供实际摘录。',
        )
      await transaction.put(source.snapshotRef, Buffer.from(input.text))
      view.sources.push(source)
      validate(sourceList, view.sources)
      view.record = {
        ...before,
        revision: before.revision + 1,
        contentRevision: before.revision + 1,
        stage: before.stage === 'ready' ? 'review' : before.stage,
        updatedAt: utcNow(),
      }
      return { source, work: await stageVersion(transaction, view, before) }
    },
    optionsFor(options, fingerprint),
  )
}

export async function addProposal(
  workspace: WorkspaceHandle,
  id: string,
  expectedRevision: number,
  input: unknown,
  options: StorageOptions = {},
): Promise<ProposalRecord> {
  const data = validate(proposalInputSchema, input)
  if (Buffer.byteLength(data.content) > LIMIT)
    throw new CharactersError(
      'INVALID_INPUT',
      '建议稿正文超过 1 MiB。',
      '缩减正文后再保存。',
    )
  validate(revisionSchema, expectedRevision)
  return withStore(
    workspace,
    async (transaction) => {
      const view = await loadView(workspace, id)
      if (view.record.revision !== expectedRevision) conflict()
      if (
        data.sourceIds.some(
          (sourceId) => !view.sources.some((source) => source.id === sourceId),
        )
      )
        throw new CharactersError(
          'NOT_FOUND',
          '建议稿引用了未授权来源。',
          '仅引用当前作品的来源。',
        )
      const proposal = validate(proposalSchema, {
        schemaVersion: 1,
        id: newId('prop'),
        workId: id,
        origin: { type: 'user' },
        baseRevision: expectedRevision,
        ...data,
        createdAt: utcNow(),
      })
      await transaction.put(
        `${workRef(id)}/proposals/${proposal.id}.json`,
        jsonBytes(proposal),
      )
      return proposal
    },
    optionsFor(options, {
      operation: 'work.proposal.add',
      id,
      expectedRevision,
      data,
    }),
  )
}

export async function listProposals(
  workspace: WorkspaceHandle,
  id: string,
): Promise<ProposalRecord[]> {
  return withStore(workspace, async () => {
    await loadView(workspace, id)
    const ref = `${workRef(id)}/proposals`
    if (!(await exists(await containedPath(workspace.root, ref)))) return []
    const proposals = []
    for (const filename of (
      await readdir(await containedPath(workspace.root, ref))
    ).sort()) {
      validate(
        idSchema('prop'),
        filename.replace(/\.json$/, ''),
        'STORE_CORRUPT',
      )
      const proposal = await readJson(
        workspace.root,
        `${ref}/${filename}`,
        proposalSchema,
      )
      if (proposal.workId !== id || filename !== `${proposal.id}.json`)
        throw new CharactersError(
          'STORE_CORRUPT',
          '建议稿归属错误。',
          '检查建议稿记录。',
        )
      proposals.push(proposal)
    }
    return proposals
  })
}

export async function applyProposal(
  workspace: WorkspaceHandle,
  id: string,
  proposalId: string,
  expectedRevision: number,
  options: StorageOptions = {},
): Promise<WorkRecord> {
  validate(idSchema('prop'), proposalId)
  validate(revisionSchema, expectedRevision)
  return withStore(
    workspace,
    async (transaction) => {
      const view = await loadView(workspace, id)
      const before = view.record
      const proposal = await readJson(
        workspace.root,
        `${workRef(id)}/proposals/${proposalId}.json`,
        proposalSchema,
      )
      if (proposal.workId !== id || proposal.id !== proposalId)
        throw new CharactersError(
          'STORE_CORRUPT',
          '建议稿归属错误。',
          '使用当前作品的建议稿。',
        )
      if (
        expectedRevision !== before.revision ||
        proposal.baseRevision !== before.revision
      )
        conflict()
      if (
        proposal.sourceIds.some(
          (sourceId) => !view.sources.some((source) => source.id === sourceId),
        )
      )
        throw new CharactersError(
          'STORE_CORRUPT',
          '建议稿来源不属于作品。',
          '检查来源与建议稿。',
        )
      view[proposal.target] = proposal.content
      view.record = {
        ...before,
        revision: before.revision + 1,
        contentRevision: before.revision + 1,
        stage: proposal.target === 'draft' ? 'draft' : 'outline',
        updatedAt: utcNow(),
      }
      return stageVersion(transaction, view, before)
    },
    optionsFor(options, {
      operation: 'work.apply',
      id,
      proposalId,
      expectedRevision,
    }),
  )
}
