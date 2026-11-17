# dsh-session-cleaner

Delete DeepSeek Harness sessions from the running web runtime: a real sidebar
menu item (**⋮ → 🗑 Delete session**) backed by a host route that removes the
live store entry, the workspace membership, and the on-disk artifacts.

**v2.0.0 is a rewrite for DSH 0.2.2.** The official Web API only exposes
archive (`workspace/archiveSession`), not `session.delete`; this bundle fills
that gap without patching the harness.

## Why v2 exists

`dsh-session-cleaner@1.0.2` installs on 0.2.2 but its menu item never appears.
Three independent breakages, all silent:

| Break | v1 | 0.2.2 |
|---|---|---|
| Module load | `dsh.client.inject` names `@deepseek-ai/dsh-client-runtime` | that package does not exist here, so the dependency graph dies and the module never mounts |
| Session id lookup | `POST /api/session.list`, matched by title | client RPC is multiplexed over `/api/remote.mux` (WebSocket); that REST route 404s, the catalog stays empty, the item is skipped |
| Menu injection | `MutationObserver` on `[role="menu"]` plus hand-built `<button>` | 0.2.2 declares the `sidebar.workspaces.session.menu.item` slot |

## How v2 differs

- The menu item registers through the **official slot**. The slot owner passes
  `sessionId`, `displayTitle` and `useMenuOpenState` as props — no DOM scraping,
  no title matching.
- The client bundle imports **no `@deepseek-ai/*` package**, only `react` and the
  `ctx` services, so a missing package can no longer kill the module.
- No `dsh.client.inject` declaration at all.
- The host injects only `webServer`; `sessions`, `agents` and
  `workspaceRegistry` are probed defensively, and each detach step tries
  `detach` / `dispose` / `close` in turn.

## Install

```sh
dsh plugin --profile desktop add file:/path/to/dsh-session-cleaner
# or, once pushed:
dsh plugin --profile desktop add github:<your-account>/dsh-session-cleaner
```

Restart DSH afterwards — a running instance does not hot-load a new bundle.

## HTTP surface

```http
POST /api-ext/session.delete
{ "sessionId": "session-..." }
```

```json
{ "ok": true, "value": { "detached": true, "workspaces": 1, "files": 1 } }
{ "ok": false, "error": { "code": "refused", "message": "..." } }
```

`GET /api-ext/session-cleaner/health` answers a liveness probe, so the browser
half can tell "route missing" from "request refused".

Guards: `application/json` only (a cross-site form cannot send it, and a
cross-origin `fetch` pays the preflight the server never answers), plus an
`Origin` check against `webServer.getOrigin()`. A running session is refused
with `409`.

## Limits

- Attachments of a deleted session are not garbage collected; the attachment
  store is content addressed and shared with log exports.
- A session-projection cache may keep one harmless stale record until restart.
- A running session can never be deleted.

## Publish

```sh
git init -b main && git add . && git commit -m "feat: v2 for DSH 0.2.2"
gh repo create dsh-session-cleaner --public --source . --push
```

Replace `<your-account>` in `package.json` `repository.url` first.

## License

MIT
