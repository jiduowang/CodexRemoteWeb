# Codex Remote Web

中文 | [English](#english)

## 中文

Codex Remote Web 是一个跨平台 Web/PWA 控制台，用来在手机、平板或其他电脑浏览器里远程访问一台运行 Codex 的 Windows 电脑。公网服务器只负责登录、Web UI、WebSocket 转发、状态和审计；Windows Bridge 主动连出公网服务器，并且是唯一能接触本地工程、Git 和 Codex 的组件。

当前实现是一个无外部 npm 依赖的 Node.js 原型：

- `server/`：Web/PWA、登录、REST API、WebSocket relay、审计日志、审批和 Bridge 注册表。
- `bridge/`：运行在 Codex 电脑上，通过反向 WebSocket 连接 server，读取 Git 状态/diff，并转发 Codex session/review 请求。
- `server/public/`：响应式 Web UI，支持手机、平板和桌面浏览器。
- `shared/`：共享协议和运行日志工具。

## 快速开始

启动 server：

```powershell
$env:CRW_PORT="8787"
$env:CRW_BIND="127.0.0.1"
$env:CRW_SESSION_SECRET="replace-with-a-long-random-secret"
$env:CRW_ADMIN_USER="admin"
$env:CRW_ADMIN_PASSWORD="replace-me"
$env:CRW_BRIDGE_TOKEN="replace-with-a-different-random-token"
npm.cmd run start:server
```

启动 Bridge：

```powershell
Copy-Item .\bridge\config.example.json $HOME\.codex-remote-bridge.json
notepad $HOME\.codex-remote-bridge.json
$env:CRW_BRIDGE_CONFIG="$HOME\.codex-remote-bridge.json"
npm.cmd run start:bridge
```

打开 `http://127.0.0.1:8787`，使用上面配置的管理员账号登录。

## 部署架构

```text
手机 / 平板 / 其他电脑浏览器
        |
        | HTTPS + WebSocket
        v
公网服务器 Web Gateway
        |
        | 反向 WebSocket，由 Windows 主动连出
        v
Windows Codex Bridge
        |
        | localhost / stdio / app-server
        v
Codex CLI / Codex App Server / 白名单工程
```

生产部署建议在 server 前面放 Caddy 或 Nginx 提供 HTTPS。Bridge 应保持 outbound-only，不要把 Bridge 直接暴露到公网。

## Codex App Server 模式

`adapter: "mock"` 是本地 mock 模式，会在本地持久化模拟 thread，方便先验证 Web/Gateway/Bridge 链路。

`adapter: "codex-app-server"` 会通过 JSONL JSON-RPC 对接 Codex app-server。由于 app-server 协议可能变化，method 名称可以在 `bridge/config.example.json` 中配置。

Bridge 支持优先尝试 `codex app-server proxy`：

```json
"desktopProxy": {
  "enabled": true,
  "args": ["app-server", "proxy"],
  "fallbackToDirect": true
}
```

如果 Codex Desktop 暴露了可用的 app-server control socket，Bridge 可以复用桌面端同一个 app-server，从而更接近桌面端同步。若 proxy 不可用，`fallbackToDirect: true` 会自动回退到独立 app-server，保证远程 Web 继续可用。

当前已知限制：在某些 Windows/Codex Desktop 版本上，Desktop 内部 app-server 没有对外暴露可连接的 control socket，此时桌面端 UI 不会和网页端实时同步。

## 运行日志

每次启动 server 或 bridge 都会生成独立日志文件，默认目录：

```text
.data/logs
```

也可以通过环境变量指定：

```powershell
$env:CRW_LOG_DIR="C:\CodexRemoteWeb\logs"
```

启动时控制台会打印日志路径，例如：

```text
bridge run log: D:\CodexApp\.data\logs\bridge-...log
server run log: D:\CodexApp\.data\logs\server-...log
```

## 安全默认值

- 首次启动 server 必须设置 `CRW_ADMIN_PASSWORD`、`CRW_SESSION_SECRET` 和 `CRW_BRIDGE_TOKEN`。
- 浏览器认证 cookie 使用 HttpOnly 和 SameSite=Lax。
- 修改类 API 需要 `x-csrf-token`。
- Bridge 使用独立机器 token。
- 只有 Bridge 配置白名单里的工程能被访问。
- 公网服务器不直接读取 Windows 文件系统。
- Bridge 会对 `.env`、密钥等敏感文件模式做 diff 输出保护。
- 本机配置 `bridge/config.json`、`.data/` 和日志默认不会提交到 Git。

## 已实现功能

- 登录、登出、登出全部设备、可选 TOTP。
- Bridge 在线/离线状态。
- 白名单工程列表，包含分支和 dirty 状态。
- session 列表、创建、读取、发送消息、中断。
- WebSocket 实时 Codex 事件流。
- 推理状态、推理摘要、运行 activity 展示。
- 推理中通过 `turn/steer` 发送引导消息。
- Pending approvals 和审批记录。
- Git changed files 和脱敏 unified diff。
- 本地 deterministic review findings。
- 审计日志。
- PWA manifest、service worker 和浏览器通知。
- 每次运行的 server/bridge 日志文件。

## 说明

这个仓库目前刻意避免外部 npm 依赖，方便在受限环境里快速运行。后续如果需要生产级 Web Push、SQL 存储、更强 diff viewer、OIDC/Cloudflare Access 或团队权限模型，可以在现有 server/bridge 边界上继续扩展。

---

## English

Codex Remote Web is a cross-platform Web/PWA control surface for a Windows machine running Codex. Phones, tablets, and other computers connect through a browser. The public server handles authentication, the Web UI, WebSocket relay, state, and audit logs. The Windows Bridge connects out to the public server and is the only component that can touch local projects, Git, or Codex.

The current implementation is a dependency-free Node.js prototype:

- `server/`: Web/PWA, login, REST API, WebSocket relay, audit log, approvals, and Bridge registry.
- `bridge/`: runs on the Codex machine, connects to the server over reverse WebSocket, reads Git status/diff, and forwards Codex session/review requests.
- `server/public/`: responsive Web UI for phones, tablets, and desktop browsers.
- `shared/`: shared protocol notes and run logging utilities.

## Quick Start

Start the server:

```powershell
$env:CRW_PORT="8787"
$env:CRW_BIND="127.0.0.1"
$env:CRW_SESSION_SECRET="replace-with-a-long-random-secret"
$env:CRW_ADMIN_USER="admin"
$env:CRW_ADMIN_PASSWORD="replace-me"
$env:CRW_BRIDGE_TOKEN="replace-with-a-different-random-token"
npm.cmd run start:server
```

Start the Bridge:

```powershell
Copy-Item .\bridge\config.example.json $HOME\.codex-remote-bridge.json
notepad $HOME\.codex-remote-bridge.json
$env:CRW_BRIDGE_CONFIG="$HOME\.codex-remote-bridge.json"
npm.cmd run start:bridge
```

Open `http://127.0.0.1:8787` and sign in with the configured admin user.

## Deployment Shape

```text
Phone / tablet / other computer
        |
        | HTTPS + WebSocket
        v
Public server: Web Gateway
        |
        | reverse WebSocket, initiated by Windows
        v
Windows Codex Bridge
        |
        | localhost / stdio / app-server
        v
Codex CLI / Codex App Server / allowlisted projects
```

For production, put Caddy or Nginx in front of the server for HTTPS. Keep the Bridge outbound-only and do not expose it directly to the public internet.

## Codex App Server Mode

`adapter: "mock"` is a local mock mode that persists simulated threads locally. Use it to verify the Web/Gateway/Bridge path first.

`adapter: "codex-app-server"` integrates with Codex app-server through JSONL JSON-RPC. Because the app-server protocol can evolve, method names are configurable in `bridge/config.example.json`.

The Bridge can try `codex app-server proxy` first:

```json
"desktopProxy": {
  "enabled": true,
  "args": ["app-server", "proxy"],
  "fallbackToDirect": true
}
```

When Codex Desktop exposes a usable app-server control socket, the Bridge can reuse the same Desktop app-server, which is the best path toward Desktop UI synchronization. If the proxy is unavailable, `fallbackToDirect: true` launches the configured direct app-server instead, keeping the remote Web path available.

Known limitation: on some Windows/Codex Desktop versions, the Desktop app-server does not expose a connectable external control socket, so the Desktop UI will not live-sync with the Web UI.

## Run Logs

Each server and bridge run writes a timestamped log file under:

```text
.data/logs
```

Set `CRW_LOG_DIR` to move logs elsewhere:

```powershell
$env:CRW_LOG_DIR="C:\CodexRemoteWeb\logs"
```

The first console lines show the exact log path, for example:

```text
bridge run log: D:\CodexApp\.data\logs\bridge-...log
server run log: D:\CodexApp\.data\logs\server-...log
```

## Security Defaults

- The server refuses first boot unless `CRW_ADMIN_PASSWORD`, `CRW_SESSION_SECRET`, and `CRW_BRIDGE_TOKEN` are set.
- Browser auth cookies are HttpOnly and SameSite=Lax.
- Mutating API calls require an `x-csrf-token` header.
- Bridge auth uses a separate machine token.
- Projects must be allowlisted in the Bridge config.
- The public server never reads Windows files directly.
- Sensitive file patterns such as `.env` and key files are protected in Bridge diff output.
- Local `bridge/config.json`, `.data/`, and logs are ignored by Git by default.

## Implemented Features

- Login, logout, logout all sessions, and optional TOTP.
- Bridge online/offline state.
- Allowlisted project list with branch and dirty status.
- Session list, create, read, send message, and interrupt.
- Live Codex event stream over WebSocket.
- Reasoning status, reasoning summary, and activity display.
- Same-turn guidance through `turn/steer` while Codex is reasoning.
- Pending approvals and approval records.
- Git changed files and redacted unified diffs.
- Local deterministic review findings.
- Audit log.
- PWA manifest, service worker, and browser notifications.
- Per-run server and bridge log files.

## Notes

This repository intentionally avoids external npm dependencies so the prototype can run in locked-down environments. Production-grade Web Push, SQL storage, richer diff rendering, OIDC/Cloudflare Access, or team permission models can be added later behind the same server/bridge boundary.
