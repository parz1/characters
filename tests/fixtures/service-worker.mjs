import {
  openWorkspace,
  migrateService,
} from '../../packages/core/dist/index.js'
import { startService } from '../../packages/service/dist/index.js'
import {
  ManagementStore,
  adminRequestSchema,
} from '../../packages/service/dist/store.js'
import { randomUUID } from 'node:crypto'
const [root, action, argument] = process.argv.slice(2)
const workspace = await openWorkspace(root)
if (action === 'migrate')
  await migrateService(workspace, false, {
    checkpoint(point) {
      if (point === 'prepared') process.exit(86)
    },
  })
else if (action === 'memory-decision') {
  const store = new ManagementStore(workspace, randomUUID())
  await store.execute(
    { kind: 'admin' },
    adminRequestSchema.parse(JSON.parse(argument)),
    undefined,
    {
      checkpoint(point, index) {
        if (point === 'applied' && index === 0) process.exit(86)
      },
    },
  )
} else {
  const service = await startService(workspace)
  process.stdout.write('ready\n')
  await service.closed
}
