# Codex Remote Web Protocol

This project keeps the public server, browser UI, and Windows Bridge separated by a small JSON message protocol.

## Browser to Server

The browser uses authenticated HTTPS API calls for commands and a WebSocket at `/ws/client` for live events.

Important API identifiers are opaque base64url JSON handles:

- `projectId`: `{ "bridgeId": "...", "projectAlias": "..." }`
- `threadId`: `{ "bridgeId": "...", "projectAlias": "...", "threadId": "..." }`

## Server to Bridge

The Bridge opens a reverse WebSocket connection to `/ws/bridge?token=...`.

After the socket opens, the Bridge sends:

```json
{
  "type": "bridge.hello",
  "bridgeId": "windows-workstation",
  "name": "Windows Workstation",
  "version": "0.1.0",
  "projects": []
}
```

Server RPC requests use:

```json
{
  "type": "rpc.request",
  "id": "rpc_...",
  "method": "threads.list",
  "params": {}
}
```

Bridge responses use:

```json
{
  "type": "rpc.result",
  "id": "rpc_...",
  "result": {}
}
```

Streaming Codex events use:

```json
{
  "type": "codex.event",
  "bridgeId": "windows-workstation",
  "projectAlias": "codex-remote-web",
  "threadId": "thread_...",
  "event": {
    "kind": "assistant.delta",
    "content": "..."
  }
}
```

Approval requests are Bridge-originated:

```json
{
  "type": "approval.request",
  "approvalId": "approval_...",
  "bridgeId": "windows-workstation",
  "projectAlias": "codex-remote-web",
  "command": "npm test",
  "cwdAlias": "codex-remote-web",
  "risk": "medium",
  "reason": "Codex requested command execution"
}
```
