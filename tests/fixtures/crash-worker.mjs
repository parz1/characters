import {
  openWorkspace,
  initWorkspace,
  createWork,
  updateWork,
  addCharacter,
  applyProposal,
  importSource,
} from '../../packages/core/dist/index.js'

const [
  workspacePath,
  action,
  boundary,
  rawIndex,
  requestId,
  objectId,
  argument,
] = process.argv.slice(2)
const options = {
  ...(requestId !== '-' ? { requestId } : {}),
  checkpoint(point, index) {
    if (point === boundary && (rawIndex === '-' || index === Number(rawIndex)))
      process.exit(86)
  },
}
if (action === 'init') await initWorkspace(workspacePath, options)
else if (action === 'recover') await openWorkspace(workspacePath, options)
else {
  const workspace = await openWorkspace(workspacePath)
  if (action === 'create')
    await createWork(
      workspace,
      {
        title: 'crash-test',
        language: 'cn',
        kind: 'log',
        authors: ['person:parz1'],
      },
      options,
    )
  else if (action === 'update')
    await updateWork(workspace, objectId, 1, { title: 'updated' }, options)
  else if (action === 'character')
    await addCharacter(workspace, objectId, options)
  else if (action === 'apply')
    await applyProposal(workspace, objectId, argument, 1, options)
  else if (action === 'source')
    await importSource(
      workspace,
      objectId,
      { title: 'source', text: 'snapshot source', expectedRevision: 1 },
      options,
    )
  else throw new Error('unknown test action')
}
throw new Error('test checkpoint was not reached')
