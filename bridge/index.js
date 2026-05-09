const { installRunLogger } = require("../shared/run-log");
const { loadConfig, publicProject } = require("./lib/config");
const { getDiff, getSummary } = require("./lib/git");
const { MockCodexAdapter } = require("./lib/mock-codex");
const { CodexAppServerAdapter } = require("./lib/codex-app-server");
const { reviewDiff } = require("./lib/review");

installRunLogger("bridge");

const VERSION = "0.1.0";
const config = loadConfig();
const adapter = config.adapter === "codex-app-server"
  ? new CodexAppServerAdapter(config.codexAppServer || {})
  : new MockCodexAdapter(config);

if (typeof adapter.setLiveEmitter === "function") {
  adapter.setLiveEmitter((projectAlias, threadId, event) => emitCodexEvent(projectAlias, threadId, event));
}

let ws = null;
let reconnectTimer = null;

connect();

function connect() {
  const url = bridgeWsUrl(config.serverUrl, config.token);
  console.log(`Connecting bridge ${config.bridgeId} to ${url.replace(config.token, "***")}`);
  ws = new WebSocket(url);

  ws.addEventListener("open", async () => {
    console.log("Bridge connected.");
    send(await helloMessage());
    publishProjects();
  });

  ws.addEventListener("message", event => {
    const message = parseJson(event.data);
    if (!message) return;
    if (message.type === "rpc.request") handleRpc(message);
    if (message.type === "approval.decision") handleApprovalDecision(message);
  });

  ws.addEventListener("close", event => {
    console.log(`Bridge disconnected: ${event.code} ${event.reason || ""}`);
    scheduleReconnect();
  });

  ws.addEventListener("error", error => {
    console.error("Bridge websocket error:", error.message || error);
  });
}

async function helloMessage() {
  return {
    type: "bridge.hello",
    bridgeId: config.bridgeId,
    name: config.name,
    version: VERSION,
    models: modelOptions(),
    reasoningEfforts: reasoningEffortOptions(),
    serviceTiers: serviceTierOptions(),
    projects: await projectSummaries()
  };
}

async function publishProjects() {
  if (!isOpen()) return;
  send({ type: "bridge.projects", projects: await projectSummaries() });
}

async function projectSummaries() {
  const summaries = [];
  for (const project of await allProjects()) {
    summaries.push(publicProject(project, await getSummary(project)));
  }
  return summaries;
}

async function handleRpc(request) {
  try {
    const result = await dispatch(request.method, request.params || {});
    send({ type: "rpc.result", id: request.id, result });
  } catch (error) {
    send({
      type: "rpc.error",
      id: request.id,
      error: {
        message: error.message || String(error),
        code: error.code || "bridge_error"
      }
    });
  }
}

async function dispatch(method, params) {
  if (method === "projects.list") {
    return { projects: await projectSummaries() };
  }

  if (method === "threads.list") {
    const project = findProject(params.projectAlias);
    return adapter.listThreads(project);
  }

  if (method === "thread.read") {
    const project = findProject(params.projectAlias);
    return adapter.readThread(project, params.threadId);
  }

  if (method === "thread.create") {
    const project = findProject(params.projectAlias);
    const result = await adapter.createThread(project, params);
    await publishProjects();
    return result;
  }

  if (method === "thread.message") {
    const project = findProject(params.projectAlias);
    const threadId = params.threadId;
    adapter.sendMessage(project, params, event => emitCodexEvent(project.alias, threadId, event))
      .then(() => publishProjects())
      .catch(error => {
        emitCodexEvent(project.alias, threadId, {
          kind: "turn.status",
          status: "failed",
          error: error.message || String(error)
        });
      });
    return { accepted: true };
  }

  if (method === "thread.interrupt") {
    const project = findProject(params.projectAlias);
    return adapter.interrupt(project, params.threadId);
  }

  if (method === "project.diff") {
    const project = findProject(params.projectAlias);
    return getDiff(project, config.denylist);
  }

  if (method === "project.review") {
    const project = findProject(params.projectAlias);
    const diff = await getDiff(project, config.denylist);
    return { ...reviewDiff(diff), files: diff.files };
  }

  throw new Error(`Unknown bridge RPC method: ${method}`);
}

function emitCodexEvent(projectAlias, threadId, event) {
  send({
    type: "codex.event",
    bridgeId: config.bridgeId,
    projectAlias,
    threadId,
    event,
    createdAt: new Date().toISOString()
  });
}

function handleApprovalDecision(message) {
  console.log(`Approval ${message.approvalId}: ${message.decision}`);
}

function findProject(alias) {
  const project = config.projects.find(item => item.alias === alias) || adapter.discoveredProjects?.get(alias);
  if (!project) throw new Error(`Project is not allowlisted: ${alias}`);
  return project;
}

async function allProjects() {
  const projects = [...config.projects];
  if (typeof adapter.discoverProjects === "function") {
    try {
      const discovered = await adapter.discoverProjects(config.projects[0]);
      const aliases = new Set(projects.map(project => project.alias));
      const paths = new Set(projects.map(project => project.path.toLowerCase()));
      for (const project of discovered) {
        if (!aliases.has(project.alias) && !paths.has(project.path.toLowerCase())) {
          projects.push(project);
          aliases.add(project.alias);
          paths.add(project.path.toLowerCase());
        }
      }
    } catch (error) {
      console.error(`Project discovery failed: ${error.message || error}`);
    }
  }
  return projects;
}

function send(message) {
  if (!isOpen()) return false;
  ws.send(JSON.stringify(message));
  return true;
}

function isOpen() {
  return ws && ws.readyState === WebSocket.OPEN;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, config.reconnectMs);
}

function bridgeWsUrl(serverUrl, token) {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws/bridge";
  url.searchParams.set("token", token);
  return url.toString();
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function modelOptions() {
  const configured = config.codexAppServer?.models || config.models || [];
  return normalizeModels(configured);
}

function reasoningEffortOptions() {
  const configured = config.codexAppServer?.reasoningEfforts || config.reasoningEfforts || [];
  return normalizeModels(configured);
}

function serviceTierOptions() {
  const configured = config.codexAppServer?.serviceTiers || config.serviceTiers || [];
  return normalizeModels(configured);
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

process.on("SIGINT", () => {
  if (ws) ws.close(1000, "Bridge stopped");
  process.exit(0);
});
