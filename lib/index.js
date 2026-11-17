/**
 * dsh-session-cleaner — host half.
 *
 * Registers the deletion route on the running web server:
 *
 *   POST /api-ext/session.delete   { "sessionId": "session-..." }
 *   GET  /api-ext/session-cleaner/health
 *
 * Deleting a session means three separate things in this runtime, and the
 * route does all three:
 *
 *   1. release the attached agent (refused while a turn is in flight);
 *   2. remove the on-disk artifact directory under `$DSH_HOME/sessions`;
 *   3. detach the live store entry so the sidebar row does not survive as a
 *      ghost until the next restart.
 *
 * Nothing here is version-frozen: every service beyond `webServer` is probed
 * with `try`/`catch`, and each detach step tries the method names current and
 * older builds expose, so the route keeps working across a DSH upgrade.
 *
 * Response envelope mirrors the host's own JSON style:
 *
 *   { "ok": true,  "value": { "detached": true, "workspaces": 1, "files": 1 } }
 *   { "ok": false, "error": { "code": "refused", "message": "..." } }
 *
 * @module dsh-session-cleaner
 */

import { access, readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-session-cleaner'

/** `webServer` is the only service the route cannot work without. */
export const inject = ['webServer']

const VERSION = '2.0.0'
const DELETE_PATH = '/api-ext/session.delete'
const HEALTH_PATH = '/api-ext/session-cleaner/health'
const BODY_LIMIT = 1 << 20
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Absolute directory holding every project's session artifacts. */
function sessionsRoot() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'sessions')
}

/** Read and parse a small JSON request body. */
async function readJsonBody(req, limit = BODY_LIMIT) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Write one JSON response. */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** A uniform refusal in the host's envelope. */
function fail(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } })
}

/**
 * Resolve an optional service without letting a missing or throwing accessor
 * break the route.
 */
function service(ctx, key) {
  try {
    return ctx[key]
  } catch {
    return undefined
  }
}

/** The attached agent, if this build exposes an agent registry. */
function agentFor(agents, sessionId) {
  try {
    return agents?.get?.(sessionId)
  } catch {
    return undefined
  }
}

/**
 * Let an idle agent release its session binding. The Agent owns a Cordis fiber;
 * unloading it tears the agent and its session attachment down in order.
 * @returns whether an attached agent was released.
 */
async function releaseIdleAgent(agent) {
  try {
    const fiber = agent?.ctx?.fiber
    if (typeof fiber?._unload !== 'function') return false
    await fiber._unload()
    return true
  } catch {
    return false
  }
}

/**
 * Remove one session id from the live SessionStore. The store keeps a public
 * `Map` of entered sessions; the entry owns the disposer that removes it.
 * @returns whether a live entry was detached.
 */
function detachLiveEntry(sessions, sessionId) {
  if (sessions === undefined) return false
  const subjects = []
  try {
    const entry = sessions.store?.get?.(sessionId)
    if (entry !== undefined) subjects.push(entry)
  } catch {
    /* store shape differs */
  }
  try {
    const live = sessions.get?.(sessionId)
    if (live !== undefined) subjects.push(live)
  } catch {
    /* get() absent */
  }
  for (const subject of subjects) {
    for (const method of ['detach', 'dispose', 'close']) {
      if (typeof subject?.[method] !== 'function') continue
      try {
        subject[method]()
        return true
      } catch {
        /* try the next spelling */
      }
    }
  }
  return false
}

/**
 * Drop the session id from every workspace that still lists it.
 * @returns how many workspace records changed.
 */
async function detachWorkspaces(registry, sessionId) {
  if (registry === undefined) return 0
  let workspaces
  try {
    workspaces = registry.list?.() ?? []
  } catch {
    return 0
  }
  let removed = 0
  for (const workspace of workspaces) {
    let ids
    try {
      ids = workspace?.sessionIds
    } catch {
      continue
    }
    if (!Array.isArray(ids) || !ids.includes(sessionId)) continue
    try {
      if (typeof workspace.detachSession === 'function') {
        await workspace.detachSession(sessionId)
        removed += 1
      } else if (typeof registry.detachSession === 'function') {
        const id = workspace.id ?? workspace.workspaceId
        if (id !== undefined) {
          await registry.detachSession(id, sessionId)
          removed += 1
        }
      }
    } catch {
      /* membership is derived in some builds; nothing to detach then */
    }
  }
  return removed
}

/**
 * Delete every `<project>/<sessionId>` directory under the sessions root.
 * @returns how many directories were removed.
 */
async function removeArtifacts(sessionId) {
  const root = sessionsRoot()
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return 0
  }
  let removed = 0
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const dir = join(root, project.name, sessionId)
    try {
      await access(dir)
    } catch {
      continue
    }
    await rm(dir, { recursive: true, force: true })
    removed += 1
  }
  return removed
}

/** One delete request, from validation to response. */
async function handleDelete(ctx, webServer, req, res) {
  if (req.method !== 'POST') {
    return fail(res, 405, 'method-not-allowed', 'POST only')
  }
  // A cross-origin page cannot set this content type without a preflight the
  // server never answers, and it cannot forge the Origin header either.
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
  if (!contentType.includes('application/json')) {
    return fail(res, 415, 'unsupported-media-type', 'content-type: application/json required')
  }
  const origin = req.headers.origin
  if (origin !== undefined) {
    let self
    try {
      self = webServer.getOrigin?.()
    } catch {
      self = undefined
    }
    if (self !== undefined && origin !== self) {
      return fail(res, 403, 'forbidden', 'cross-origin request refused')
    }
  }

  let payload
  try {
    payload = await readJsonBody(req)
  } catch (error) {
    return fail(res, 400, 'bad-request', String(error?.message ?? error))
  }
  const sessionId = payload?.sessionId
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
    return fail(res, 400, 'bad-request', 'missing or invalid sessionId')
  }

  const sessions = service(ctx, 'sessions')
  const agents = service(ctx, 'agents')
  const registry = service(ctx, 'workspaceRegistry')

  try {
    const agent = agentFor(agents, sessionId)
    if (agent !== undefined) {
      if (agent.status === 'running') {
        return fail(res, 409, 'refused', `session "${sessionId}" is running; stop it before deleting`)
      }
      if (!(await releaseIdleAgent(agent))) {
        return fail(
          res,
          409,
          'refused',
          `session "${sessionId}" still has an attached agent that could not be released`,
        )
      }
    }

    // Artifacts first: a list refresh between the two steps must not be able to
    // resurrect the row from disk.
    const files = await removeArtifacts(sessionId)
    const detached = detachLiveEntry(sessions, sessionId)
    const workspaces = await detachWorkspaces(registry, sessionId)

    if (files === 0 && !detached && workspaces === 0) {
      return fail(res, 404, 'not-found', `no on-disk or live session "${sessionId}"`)
    }
    return sendJson(res, 200, { ok: true, value: { detached, workspaces, files } })
  } catch (error) {
    try {
      ctx.logger?.warn?.(`dsh-session-cleaner: delete ${sessionId} failed: ${String(error?.message ?? error)}`)
    } catch {
      /* logger unavailable */
    }
    return fail(res, 500, 'internal', String(error?.message ?? error))
  }
}

/** Mount the routes on the web server for as long as this plugin runs. */
export function apply(ctx) {
  const webServer = ctx.webServer
  if (webServer === undefined) return

  ctx.effect(
    () =>
      webServer.register({
        kind: 'exact',
        path: DELETE_PATH,
        handler: (req, res) => handleDelete(ctx, webServer, req, res),
      }),
    'session-cleaner: delete route',
  )

  ctx.effect(
    () =>
      webServer.register({
        kind: 'exact',
        path: HEALTH_PATH,
        handler: (req, res) => {
          sendJson(res, 200, { ok: true, value: { version: VERSION, endpoint: DELETE_PATH } })
        },
      }),
    'session-cleaner: health route',
  )
}

// Internals exported for unit tests (not part of the plugin surface).
export { detachLiveEntry, detachWorkspaces, releaseIdleAgent, removeArtifacts, sessionsRoot }
