const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const { installRunLogger } = require("../shared/run-log");
const { JsonStore } = require("./lib/db");
const {
  cookie,
  hashPassword,
  parseCookies,
  randomId,
  signSessionId,
  verifyPassword,
  verifySessionCookie
} = require("./lib/auth");
const { generateSecret, otpauthUrl, verifyTotp } = require("./lib/totp");
const { acceptWebSocket } = require("./lib/ws-server");

const VERSION = "0.1.0";
const ROOT = path.resolve(__dirname, "..");
installRunLogger("server", { root: ROOT });
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = process.env.CRW_DATA_DIR || path.join(ROOT, ".data");
const DB_PATH = path.join(DATA_DIR, "server-db.json");
const PORT = Number(process.env.CRW_PORT || 8787);
const BIND = process.env.CRW_BIND || "127.0.0.1";
const PUBLIC_URL = process.env.CRW_PUBLIC_URL || `http://${BIND}:${PORT}`;
const SESSION_SECRET = process.env.CRW_SESSION_SECRET;
const BRIDGE_TOKEN = process.env.CRW_BRIDGE_TOKEN;
const COOKIE_SECURE = PUBLIC_URL.startsWith("https://");

if (!SESSION_SECRET || SESSION_SECRET.length < 24) {
  console.error("CRW_SESSION_SECRET must be set to a long random value.");
  process.exit(1);
}

if (!BRIDGE_TOKEN || BRIDGE_TOKEN.length < 16) {
  console.error("CRW_BRIDGE_TOKEN must be set to a separate machine token.");
  process.exit(1);
}

const db = new JsonStore(DB_PATH, {
  users: [],
  sessions: [],
  bridges: {},
  audit: [],
  approvals: [],
  pushSubscriptions: []
});

bootstrapAdmin();

const activeBridges = new Map();
const clientSockets = new Set();
const loginAttempts = new Map();

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(error => {
    console.error(error);
    const status = error.statusCode || 500;
    sendJson(res, status, {
      error: status >= 500 ? "internal_error" : "bad_request",
      message: status >= 500 ? "Internal server error" : error.message
    });
  });
});

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, PUBLIC_URL);
  if (url.pathname === "/ws/bridge") {
    const token = url.searchParams.get("token") || bearerToken(req);
    if (token !== BRIDGE_TOKEN) return rejectUpgrade(socket, 401, "Invalid bridge token");
    const ws = acceptWebSocket(req, socket);
    if (ws) attachBridgeSocket(ws);
    return;
  }

  if (url.pathname === "/ws/client") {
    const auth = authenticate(req);
    if (!auth) return rejectUpgrade(socket, 401, "Not authenticated");
    const ws = acceptWebSocket(req, socket);
    if (ws) attachClientSocket(ws, auth);
    return;
  }

  rejectUpgrade(socket, 404, "Unknown websocket endpoint");
});

server.listen(PORT, BIND, () => {
  console.log(`Codex Remote Web server ${VERSION} listening on http://${BIND}:${PORT}`);
});

setInterval(() => {
  for (const bridge of activeBridges.values()) bridge.ws.ping();
  for (const ws of clientSockets) ws.ping();
}, 30000).unref();

async function handleRequest(req, res) {
  const url = new URL(req.url, PUBLIC_URL);
  if (url.pathname.startsWith("/api/")) {
    return handleApi(req, res, url);
  }
  return serveStatic(req, res, url);
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/session") {
    const auth = authenticate(req);
    if (!auth) return sendJson(res, 200, { authenticated: false, version: VERSION });
    return sendJson(res, 200, sessionPayload(auth));
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    return handleLogin(req, res);
  }

  const auth = authenticate(req);
  if (!auth) return sendJson(res, 401, { error: "not_authenticated" });

  if (isMutating(req.method) && !validCsrf(req, auth.session)) {
    return sendJson(res, 403, { error: "invalid_csrf" });
  }

  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "POST" && url.pathname === "/api/logout") {
    db.update(data => {
      data.sessions = data.sessions.filter(session => session.id !== auth.session.id);
    });
    res.setHeader("Set-Cookie", cookie("crw_session", "", { maxAge: 0, sameSite: "Lax", secure: COOKIE_SECURE }));
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/logout-all") {
    db.update(data => {
      data.sessions = data.sessions.filter(session => session.userId !== auth.user.id);
    });
    audit("auth.logout_all", {}, auth.user.id);
    res.setHeader("Set-Cookie", cookie("crw_session", "", { maxAge: 0, sameSite: "Lax", secure: COOKIE_SECURE }));
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/2fa/setup") {
    const secret = generateSecret();
    db.update(data => {
      const user = data.users.find(item => item.id === auth.user.id);
      user.totpPendingSecret = secret;
    });
    audit("auth.2fa_setup", {}, auth.user.id);
    return sendJson(res, 200, {
      secret,
      otpauthUrl: otpauthUrl({ issuer: "Codex Remote Web", account: auth.user.username, secret })
    });
  }

  if (req.method === "POST" && url.pathname === "/api/2fa/enable") {
    const body = await readJson(req);
    const user = db.data.users.find(item => item.id === auth.user.id);
    if (!user?.totpPendingSecret || !verifyTotp(user.totpPendingSecret, body.token)) {
      return sendJson(res, 400, { error: "invalid_totp" });
    }
    db.update(data => {
      const current = data.users.find(item => item.id === auth.user.id);
      current.totpSecret = current.totpPendingSecret;
      current.totpPendingSecret = null;
      current.totpEnabled = true;
    });
    audit("auth.2fa_enabled", {}, auth.user.id);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/2fa/disable") {
    const body = await readJson(req);
    if (!verifyPassword(body.password || "", auth.user.passwordHash)) {
      return sendJson(res, 400, { error: "invalid_password" });
    }
    db.update(data => {
      const current = data.users.find(item => item.id === auth.user.id);
      current.totpSecret = null;
      current.totpPendingSecret = null;
      current.totpEnabled = false;
    });
    audit("auth.2fa_disabled", {}, auth.user.id);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/bridges") {
    const bridges = Object.values(db.data.bridges).map(bridge => ({
      ...bridge,
      online: activeBridges.has(bridge.id),
      projects: (activeBridges.get(bridge.id)?.projects || bridge.projects || []).map(project => publicProject(bridge.id, project))
    }));
    return sendJson(res, 200, { bridges });
  }

  if (req.method === "GET" && url.pathname === "/api/projects") {
    const projects = [];
    for (const bridge of activeBridges.values()) {
      for (const project of bridge.projects) projects.push(publicProject(bridge.id, project));
    }
    return sendJson(res, 200, { projects });
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "projects" && parts[3] === "threads") {
    const project = decodeProjectHandle(parts[2]);
    const result = await sendBridgeRpc(project.bridgeId, "threads.list", { projectAlias: project.projectAlias });
    return sendJson(res, 200, {
      threads: (result.threads || []).map(thread => publicThread(project.bridgeId, project.projectAlias, thread))
    });
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "threads" && parts.length === 3) {
    const thread = decodeThreadHandle(parts[2]);
    const result = await sendBridgeRpc(thread.bridgeId, "thread.read", {
      projectAlias: thread.projectAlias,
      threadId: thread.threadId
    });
    return sendJson(res, 200, {
      thread: publicThread(thread.bridgeId, thread.projectAlias, result.thread || result)
    });
  }

  if (req.method === "POST" && url.pathname === "/api/threads") {
    const body = await readJson(req);
    const project = decodeProjectHandle(body.projectId);
    const result = await sendBridgeRpc(project.bridgeId, "thread.create", {
      projectAlias: project.projectAlias,
      title: body.title,
      initialMessage: body.initialMessage
    });
    const thread = publicThread(project.bridgeId, project.projectAlias, result.thread || result);
    audit("thread.create", { projectId: body.projectId, threadId: thread.id }, auth.user.id);
    return sendJson(res, 200, { thread });
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "threads" && parts[3] === "messages") {
    const body = await readJson(req);
    const thread = decodeThreadHandle(parts[2]);
    const result = await sendBridgeRpc(thread.bridgeId, "thread.message", {
      projectAlias: thread.projectAlias,
      threadId: thread.threadId,
      message: String(body.message || ""),
      context: String(body.context || ""),
      model: String(body.model || ""),
      effort: String(body.effort || ""),
      serviceTier: String(body.serviceTier || ""),
      steer: body.steer === true
    });
    audit("thread.message", {
      threadId: parts[2],
      model: body.model || null,
      effort: body.effort || null,
      serviceTier: body.serviceTier || null,
      steer: body.steer === true
    }, auth.user.id);
    return sendJson(res, 200, result);
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "threads" && parts[3] === "interrupt") {
    const thread = decodeThreadHandle(parts[2]);
    const result = await sendBridgeRpc(thread.bridgeId, "thread.interrupt", {
      projectAlias: thread.projectAlias,
      threadId: thread.threadId
    });
    audit("thread.interrupt", { threadId: parts[2] }, auth.user.id);
    return sendJson(res, 200, result);
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "projects" && parts[3] === "diff") {
    const project = decodeProjectHandle(parts[2]);
    const result = await sendBridgeRpc(project.bridgeId, "project.diff", { projectAlias: project.projectAlias });
    audit("project.diff", { projectId: parts[2] }, auth.user.id);
    return sendJson(res, 200, result);
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "projects" && parts[3] === "review") {
    const project = decodeProjectHandle(parts[2]);
    const result = await sendBridgeRpc(project.bridgeId, "project.review", { projectAlias: project.projectAlias });
    audit("project.review", { projectId: parts[2], findings: result.findings?.length || 0 }, auth.user.id);
    return sendJson(res, 200, result);
  }

  if (req.method === "GET" && url.pathname === "/api/approvals") {
    return sendJson(res, 200, {
      approvals: db.data.approvals.slice(-100).reverse()
    });
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "approvals" && parts[3] === "decision") {
    const body = await readJson(req);
    const approval = db.data.approvals.find(item => item.id === parts[2]);
    if (!approval) return sendJson(res, 404, { error: "approval_not_found" });
    if (approval.status !== "pending") return sendJson(res, 409, { error: "approval_already_resolved" });
    const decision = body.decision === "allow_prefix" ? "allow_prefix" : body.decision === "deny" ? "deny" : "allow";
    if (approval.risk === "high" && decision !== "deny" && body.confirm !== true) {
      return sendJson(res, 400, { error: "high_risk_requires_confirmation" });
    }
    db.update(data => {
      const current = data.approvals.find(item => item.id === parts[2]);
      current.status = decision === "deny" ? "denied" : "approved";
      current.decision = decision;
      current.decidedAt = new Date().toISOString();
      current.decidedBy = auth.user.id;
    });
    const bridge = activeBridges.get(approval.bridgeId);
    if (bridge) {
      bridge.ws.sendJson({
        type: "approval.decision",
        approvalId: approval.id,
        decision,
        allowPrefix: body.allowPrefix || null
      });
    }
    audit("approval.decision", { approvalId: approval.id, decision }, auth.user.id);
    broadcast({ type: "approval.updated", approvalId: approval.id, decision });
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/audit") {
    return sendJson(res, 200, { audit: db.data.audit.slice(-200).reverse() });
  }

  if (req.method === "POST" && url.pathname === "/api/push/subscriptions") {
    const body = await readJson(req);
    db.update(data => {
      data.pushSubscriptions = data.pushSubscriptions.filter(item => item.endpoint !== body.endpoint);
      data.pushSubscriptions.push({ ...body, userId: auth.user.id, createdAt: new Date().toISOString() });
    });
    return sendJson(res, 200, { ok: true });
  }

  sendJson(res, 404, { error: "not_found" });
}

async function handleLogin(req, res) {
  const ip = req.socket.remoteAddress || "unknown";
  const body = await readJson(req);
  const bucket = loginAttempts.get(ip) || { count: 0, resetAt: Date.now() + 60000 };
  if (Date.now() > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = Date.now() + 60000;
  }

  const user = db.data.users.find(item => item.username === String(body.username || ""));
  const passwordOk = Boolean(user && verifyPassword(String(body.password || ""), user.passwordHash));
  if (bucket.count >= 8 && !passwordOk) {
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - Date.now()) / 1000));
    res.setHeader("Retry-After", String(retryAfterSeconds));
    return sendJson(res, 429, {
      error: "too_many_attempts",
      message: `Too many failed login attempts. Try again in ${retryAfterSeconds}s.`,
      retryAfterSeconds
    });
  }

  if (!passwordOk) {
    bucket.count += 1;
    loginAttempts.set(ip, bucket);
    audit("auth.login_failed", { username: body.username || "" });
    return sendJson(res, 401, { error: "invalid_credentials" });
  }

  if (user.totpEnabled && !verifyTotp(user.totpSecret, body.totp)) {
    bucket.count += 1;
    loginAttempts.set(ip, bucket);
    return sendJson(res, 401, { error: "totp_required", requiresTotp: true });
  }

  loginAttempts.delete(ip);
  const session = {
    id: randomId("session"),
    userId: user.id,
    csrf: randomId("csrf"),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + (body.remember ? 1000 * 60 * 60 * 24 * 30 : 1000 * 60 * 60 * 12)).toISOString(),
    userAgent: req.headers["user-agent"] || ""
  };
  db.update(data => data.sessions.push(session));
  audit("auth.login", { remember: Boolean(body.remember) }, user.id);

  res.setHeader("Set-Cookie", cookie("crw_session", signSessionId(session.id, SESSION_SECRET), {
    maxAge: body.remember ? 60 * 60 * 24 * 30 : 60 * 60 * 12,
    sameSite: "Lax",
    secure: COOKIE_SECURE
  }));
  sendJson(res, 200, sessionPayload({ user, session }));
}

function attachBridgeSocket(ws) {
  let bridgeId = null;

  ws.on("message", raw => {
    const message = parseJson(raw);
    if (!message) return;

    if (!bridgeId) {
      if (message.type !== "bridge.hello" || !message.bridgeId) {
        ws.close(1008, "Expected bridge.hello");
        return;
      }
      bridgeId = String(message.bridgeId);
      const previous = activeBridges.get(bridgeId);
      if (previous) previous.ws.close(1000, "Replaced by new bridge connection");
      activeBridges.set(bridgeId, {
        id: bridgeId,
        name: message.name || bridgeId,
        version: message.version || "unknown",
        models: normalizeModels(message.models),
        reasoningEfforts: normalizeModels(message.reasoningEfforts),
        serviceTiers: normalizeModels(message.serviceTiers),
        projects: Array.isArray(message.projects) ? message.projects : [],
        connectedAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        pending: new Map(),
        ws
      });
      db.update(data => {
        data.bridges[bridgeId] = {
          id: bridgeId,
          name: message.name || bridgeId,
          version: message.version || "unknown",
          models: normalizeModels(message.models),
          reasoningEfforts: normalizeModels(message.reasoningEfforts),
          serviceTiers: normalizeModels(message.serviceTiers),
          projects: Array.isArray(message.projects) ? message.projects : [],
          lastSeen: new Date().toISOString()
        };
      });
      audit("bridge.online", { bridgeId });
      broadcast({ type: "bridge.status", bridgeId, online: true });
      return;
    }

    const bridge = activeBridges.get(bridgeId);
    if (!bridge) return;
    bridge.lastSeen = new Date().toISOString();

    if (message.type === "bridge.projects") {
      bridge.projects = Array.isArray(message.projects) ? message.projects : [];
      db.update(data => {
        data.bridges[bridgeId] = { ...(data.bridges[bridgeId] || {}), projects: bridge.projects, lastSeen: bridge.lastSeen };
      });
      broadcast({ type: "projects.updated", bridgeId });
      return;
    }

    if (message.type === "rpc.result" || message.type === "rpc.error") {
      const pending = bridge.pending.get(message.id);
      if (!pending) return;
      bridge.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.type === "rpc.error") {
        const error = new Error(message.error?.message || message.error || "Bridge RPC failed");
        error.statusCode = 502;
        pending.reject(error);
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }

    if (message.type === "approval.request") {
      const approval = {
        id: message.approvalId || randomId("approval"),
        bridgeId,
        projectAlias: message.projectAlias || "",
        projectId: encodeHandle({ bridgeId, projectAlias: message.projectAlias || "" }),
        command: String(message.command || ""),
        cwdAlias: String(message.cwdAlias || message.projectAlias || ""),
        risk: normalizeRisk(message.risk),
        reason: String(message.reason || ""),
        status: "pending",
        createdAt: new Date().toISOString()
      };
      db.update(data => {
        data.approvals = data.approvals.filter(item => item.id !== approval.id);
        data.approvals.push(approval);
        data.approvals = data.approvals.slice(-200);
      });
      audit("approval.request", { approvalId: approval.id, bridgeId, risk: approval.risk });
      broadcast({ type: "approval.request", approval });
      return;
    }

    if (message.type === "codex.event") {
      broadcast({
        ...message,
        projectId: encodeHandle({ bridgeId, projectAlias: message.projectAlias || "" }),
        publicThreadId: encodeHandle({ bridgeId, projectAlias: message.projectAlias || "", threadId: message.threadId || "" })
      });
    }
  });

  ws.on("close", () => {
    if (!bridgeId) return;
    const bridge = activeBridges.get(bridgeId);
    if (bridge?.ws === ws) {
      for (const pending of bridge.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Bridge disconnected"));
      }
      activeBridges.delete(bridgeId);
      audit("bridge.offline", { bridgeId });
      broadcast({ type: "bridge.status", bridgeId, online: false });
    }
  });
}

function attachClientSocket(ws, auth) {
  ws.userId = auth.user.id;
  clientSockets.add(ws);
  ws.sendJson({ type: "client.hello", version: VERSION });
  ws.on("message", raw => {
    const message = parseJson(raw);
    if (message?.type === "ping") ws.sendJson({ type: "pong", now: new Date().toISOString() });
  });
  ws.on("close", () => clientSockets.delete(ws));
}

function sendBridgeRpc(bridgeId, method, params, timeoutMs = 45000) {
  const bridge = activeBridges.get(bridgeId);
  if (!bridge) {
    const error = new Error("Bridge is offline");
    error.statusCode = 503;
    throw error;
  }
  const id = randomId("rpc");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      bridge.pending.delete(id);
      reject(new Error(`Bridge RPC timed out: ${method}`));
    }, timeoutMs);
    bridge.pending.set(id, { resolve, reject, timer });
    bridge.ws.sendJson({ type: "rpc.request", id, method, params });
  });
}

function broadcast(message) {
  for (const ws of clientSockets) ws.sendJson(message);
}

function normalizeModels(models) {
  if (!Array.isArray(models)) return [];
  const seen = new Set();
  const normalized = [];
  for (const model of models) {
    const item = typeof model === "string" ? { id: model, label: model } : model;
    const id = String(item?.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push({
      id,
      label: String(item.label || id),
      description: item.description ? String(item.description) : ""
    });
  }
  return normalized;
}

function authenticate(req) {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = verifySessionCookie(cookies.crw_session, SESSION_SECRET);
  if (!sessionId) return null;
  const now = Date.now();
  const session = db.data.sessions.find(item => item.id === sessionId);
  if (!session || Date.parse(session.expiresAt) <= now) {
    db.update(data => {
      data.sessions = data.sessions.filter(item => item.id !== sessionId && Date.parse(item.expiresAt) > now);
    });
    return null;
  }
  const user = db.data.users.find(item => item.id === session.userId);
  return user ? { user, session } : null;
}

function validCsrf(req, session) {
  return req.headers["x-csrf-token"] === session.csrf;
}

function sessionPayload({ user, session }) {
  return {
    authenticated: true,
    version: VERSION,
    csrf: session.csrf,
    user: {
      id: user.id,
      username: user.username,
      totpEnabled: Boolean(user.totpEnabled)
    }
  };
}

function bootstrapAdmin() {
  const username = process.env.CRW_ADMIN_USER || "admin";
  const password = process.env.CRW_ADMIN_PASSWORD;
  const resetPassword = process.env.CRW_ADMIN_RESET_PASSWORD === "1";
  const existingUser = db.data.users.find(user => user.username === username);

  if (existingUser) {
    if (resetPassword) {
      if (!password || password.length < 8) {
        console.error("CRW_ADMIN_RESET_PASSWORD=1 requires CRW_ADMIN_PASSWORD with at least 8 characters.");
        process.exit(1);
      }
      db.update(data => {
        const user = data.users.find(item => item.username === username);
        user.passwordHash = hashPassword(password);
        user.totpEnabled = false;
        user.totpSecret = null;
        user.totpPendingSecret = null;
        data.sessions = data.sessions.filter(session => session.userId !== user.id);
      });
      audit("auth.admin_password_reset", { username });
      console.log(`Admin password reset for ${username}.`);
    }
    return;
  }

  if (db.data.users.length > 0) return;
  if (!password || password.length < 8) {
    console.error("First boot requires CRW_ADMIN_PASSWORD with at least 8 characters.");
    process.exit(1);
  }
  db.update(data => {
    data.users.push({
      id: randomId("user"),
      username,
      passwordHash: hashPassword(password),
      totpEnabled: false,
      totpSecret: null,
      totpPendingSecret: null,
      createdAt: new Date().toISOString()
    });
  });
  audit("auth.bootstrap_admin", { username });
}

function audit(action, details = {}, userId = null) {
  db.update(data => {
    data.audit.push({
      id: randomId("audit"),
      action,
      userId,
      details,
      createdAt: new Date().toISOString()
    });
    data.audit = data.audit.slice(-500);
  });
}

function publicProject(bridgeId, project) {
  return {
    id: encodeHandle({ bridgeId, projectAlias: project.alias }),
    bridgeId,
    alias: project.alias,
    name: project.name || project.alias,
    pathAlias: project.pathAlias || project.alias,
    branch: project.branch || "unknown",
    dirty: Boolean(project.dirty),
    changedFiles: Number(project.changedFiles || 0),
    lastThreadAt: project.lastThreadAt || null,
    discovered: Boolean(project.discovered),
    bridgeName: activeBridges.get(bridgeId)?.name || db.data.bridges[bridgeId]?.name || bridgeId,
    models: publicModels(bridgeId),
    reasoningEfforts: publicReasoningEfforts(bridgeId),
    serviceTiers: publicServiceTiers(bridgeId),
    online: activeBridges.has(bridgeId)
  };
}

function publicModels(bridgeId) {
  return normalizeModels(activeBridges.get(bridgeId)?.models || db.data.bridges[bridgeId]?.models || []);
}

function publicReasoningEfforts(bridgeId) {
  return normalizeModels(activeBridges.get(bridgeId)?.reasoningEfforts || db.data.bridges[bridgeId]?.reasoningEfforts || []);
}

function publicServiceTiers(bridgeId) {
  return normalizeModels(activeBridges.get(bridgeId)?.serviceTiers || db.data.bridges[bridgeId]?.serviceTiers || []);
}

function publicThread(bridgeId, projectAlias, thread) {
  const localId = thread.threadId || thread.id;
  return {
    ...thread,
    id: encodeHandle({ bridgeId, projectAlias, threadId: localId }),
    threadId: undefined,
    localId
  };
}

function decodeProjectHandle(value) {
  const decoded = decodeHandle(value);
  if (!decoded.bridgeId || !decoded.projectAlias) throw Object.assign(new Error("Invalid project id"), { statusCode: 400 });
  return decoded;
}

function decodeThreadHandle(value) {
  const decoded = decodeHandle(value);
  if (!decoded.bridgeId || !decoded.projectAlias || !decoded.threadId) throw Object.assign(new Error("Invalid thread id"), { statusCode: 400 });
  return decoded;
}

function encodeHandle(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeHandle(value) {
  try {
    return JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
  } catch {
    throw Object.assign(new Error("Invalid handle"), { statusCode: 400 });
  }
}

async function readJson(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request body too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.trim() ? JSON.parse(raw) : {};
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "method_not_allowed" });
  const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  let filePath = path.resolve(PUBLIC_DIR, requested);
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: "forbidden" });
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(PUBLIC_DIR, "index.html");
  }
  const ext = path.extname(filePath).toLowerCase();
  const contentType = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml"
  }[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType });
  if (req.method === "HEAD") res.end();
  else fs.createReadStream(filePath).pipe(res);
}

function isMutating(method) {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method);
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}

function rejectUpgrade(socket, status, message) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n${message}`);
  socket.destroy();
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeRisk(risk) {
  return ["low", "medium", "high"].includes(risk) ? risk : "medium";
}

process.on("uncaughtException", error => {
  console.error(error);
});
