// Smoke tests for the host half. No network, no real DSH home: the sessions
// root is a temp directory and the services are fakes.
//
//   node test/smoke.mjs

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  detachLiveEntry,
  detachWorkspaces,
  removeArtifacts,
  sessionsRoot,
} from '../lib/index.js'

const home = await mkdtemp(join(tmpdir(), 'dsc-'))
process.env.DSH_HOME = home

const target = 'session-1111'
const kept = 'session-2222'

// Two projects holding the target, one holding an unrelated session.
for (const project of ['--p-one--', '--p-two--']) {
  await mkdir(join(home, 'sessions', project, target), { recursive: true })
  await writeFile(join(home, 'sessions', project, target, 'session.jsonl'), '{}\n')
}
await mkdir(join(home, 'sessions', '--p-one--', kept), { recursive: true })

assert.equal(sessionsRoot(), join(home, 'sessions'), 'sessions root honours DSH_HOME')

const files = await removeArtifacts(target)
assert.equal(files, 2, 'removes the target from every project')

const remaining = await readdir(join(home, 'sessions', '--p-one--'))
assert.deepEqual(remaining, [kept], 'leaves unrelated sessions alone')

assert.equal(await removeArtifacts(target), 0, 'second run finds nothing')

// detachLiveEntry: the store Map entry owns the disposer.
let detached = 0
const sessions = {
  store: new Map([[target, { detach() { detached += 1 } }]]),
}
assert.equal(detachLiveEntry(sessions, target), true)
assert.equal(detached, 1)
assert.equal(detachLiveEntry(sessions, 'missing'), false)
assert.equal(detachLiveEntry({}, target), false, 'survives a store shape change')

// Older shapes: get() + dispose().
let disposed = 0
const getShape = { get: (id) => (id === target ? { dispose() { disposed += 1 } } : undefined) }
assert.equal(detachLiveEntry(getShape, target), true)
assert.equal(disposed, 1)

// Workspace membership detach is best effort and never throws.
const registry = {
  list: () => [
    { sessionIds: [target], detachSession: async () => {} },
    { sessionIds: [kept], detachSession: async () => { throw new Error('boom') } },
    { get sessionIds() { throw new Error('throwing getter') } },
  ],
}
assert.equal(await detachWorkspaces(registry, target), 1)
assert.equal(await detachWorkspaces(undefined, target), 0)

await rm(home, { recursive: true, force: true })
console.log('smoke: ok')
