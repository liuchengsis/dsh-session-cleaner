# dsh-session-cleaner

在 DeepSeek Harness 的侧栏会话 **⋮ 菜单**里加一条「🗑 删除此会话」，删掉运行中运行时的会话：live 条目、工作区归属、磁盘上的会话目录。

**v2.0.0：为 DSH 0.2.2 重写。** 官方 Web API 只有归档（`workspace/archiveSession`），没有 `session.delete`，本插件补上这个缺口。

## 为什么重写

v1（`dsh-session-cleaner@1.0.2`）在 0.2.2 上装得上、插件也加载了，但菜单项永远不出现——三处断点全都是静默的：

| 断点 | v1 的做法 | 0.2.2 的现实 |
|---|---|---|
| 模块加载 | `dsh.client.inject` 声明 `@deepseek-ai/dsh-client-runtime` | 这个包在 0.2.2 里**不存在**，依赖图直接断，模块不挂载 |
| 会话 id 解析 | `POST /api/session.list` 按标题反查 | 客户端 RPC 走 `/api/remote.mux` 的 WebSocket，没有这个 REST 路由，请求 404 → 目录为空 → 静默跳过 |
| 菜单注入 | `MutationObserver` 监听 `[role="menu"]`，手工造 `<button>` | 0.2.2 已有官方插槽 `sidebar.workspaces.session.menu.item`，不需要爬 DOM |

三者都是 `try/catch` + `console.debug` 包着的，所以界面上一点痕迹都没有。

## v2 怎么做的

- **菜单项走官方插槽**：`ctx.slots.register({ name: 'sidebar.workspaces.session.menu.item', ... })`。插槽所有者（`dsh-client-ui-workspace`）直接把 `sessionId`、`displayTitle`、`useMenuOpenState` 作为 props 交给组件，不用反查、不用爬 DOM。
- **客户端零 `@deepseek-ai/*` 导入**：只用 `require('react')` 和 `ctx` 服务，杜绝"导入一个此版本没有的包"导致整块不加载。
- **不声明 `dsh.client.inject`**：模块加载顺序交给插槽的 `inject()` 等待机制，少一个失败点。
- **宿主端不硬依赖服务**：只 `inject: ['webServer']`，`sessions` / `agents` / `workspaceRegistry` 全部 `try/catch` 探测，每个 detach 步骤按 `detach`/`dispose`/`close` 依次尝试，跨版本可降级。

## 工作原理

删除一个会话在运行时里是三件事，宿主端一次做完：

1. **释放 agent** —— 正在跑回合的会话直接拒绝（`409 refused`）；只是空闲挂着的先卸载它的 fiber，卸载不掉也拒绝。
2. **删磁盘** —— `$DSH_HOME/sessions/<项目>/<sessionId>/`，从所有项目目录下删。
3. **摘 live store** —— 从 `SessionStore` 的 `store` Map 取出条目并 detach，否则会话会以"幽灵行"活到下次重启。

顺序是先删文件再摘条目：中间如果恰好有一次列表刷新，不会从磁盘把行复活。

## 安装

```sh
# 本地目录（开发/自用）
dsh plugin --profile desktop add file:/path/to/dsh-session-cleaner

# GitHub（先按下面「发布」建仓并推送）
dsh plugin --profile desktop add github:<你的账号>/dsh-session-cleaner
```

装完**重启 DSH**（运行中的实例不会热加载新 bundle）。桌面版也可以在侧栏 **Plugins** 里用 Add plugin 选本地目录。

## 使用

侧栏任一会话行 → 右侧 **⋮** → 菜单底部 → **🗑 删除此会话** → 确认。

- 会话正在跑回合：宿主返回 `409`，前端弹「会话正在运行，无法删除」。
- 在 UI 打开过、agent 空闲挂着：先卸载 agent 再删。
- 删除不可逆。

## HTTP 接口

```http
POST /api-ext/session.delete
Content-Type: application/json

{ "sessionId": "session-1bb8d361-ea6b-4b92-bab2-c858c92e8822" }
```

```json
{ "ok": true,  "value": { "detached": true, "workspaces": 1, "files": 1 } }
{ "ok": false, "error": { "code": "refused", "message": "..." } }
```

`detached` 是否摘掉 live 条目，`workspaces` 改了几个工作区记录，`files` 删了几个会话目录。

健康检查：`GET /api-ext/session-cleaner/health` → `{ "ok": true, "value": { "version": "2.0.0", "endpoint": "/api-ext/session.delete" } }`。
页面控制台里 404 说明宿主那半个没挂上（插件没启用，或者没重启）。

安全边界：只接受 `application/json`（跨站 HTML 表单发不出来，跨源 fetch 会先撞 preflight），并且校验 `Origin` 与 `webServer.getOrigin()` 一致。

## 限制

- 被删会话的**附件**不回收：附件库按内容寻址，且被日志导出共享。
- session-projection 缓存可能留一条无害的过期记录，直到下次重启。
- 运行中的会话永远删不掉（这是有意为之）。
- Desktop 版若改成 `file://` 加载前端（fetch 走 IPC 桥），本插件的 `fetch` 路径需要相应调整；当前 0.2.2 桌面版是 `http://127.0.0.1:<port>`，同源可直接用。

## 开发

无构建。`client.js` 由模块加载器直接加载，`lib/index.js` 是普通 ESM。

```sh
node --check lib/index.js
node --check client.js
```

## 从 GitHub 安装

仓库：[liuchengsis/dsh-session-cleaner](https://github.com/liuchengsis/dsh-session-cleaner)

```sh
dsh plugin --profile desktop add github:liuchengsis/dsh-session-cleaner
```

再一个等价写法（指定提交，可复现）：

```sh
dsh plugin --profile desktop add github:liuchengsis/dsh-session-cleaner#<commit>
```

## 发布（维护者）

```sh
git add .
git commit -m "feat: ..."
git push origin main
```

`git push` 需要凭据；如果本机 `gh` 已登录，用 `gh auth setup-git` 之后即可直接推送。

## 许可证

MIT
