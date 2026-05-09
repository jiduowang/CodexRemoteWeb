const app = document.querySelector("#app");

const state = {
  csrf: null,
  user: null,
  version: "",
  view: "projects",
  bridges: [],
  projects: [],
  selectedProject: null,
  threads: [],
  selectedThread: null,
  thread: null,
  approvals: [],
  diff: null,
  review: null,
  audit: [],
  ws: null,
  streaming: {},
  drafts: {},
  liveThreads: {},
  modelByProject: loadJson("crw-model-by-project", {}),
  effortByProject: loadJson("crw-effort-by-project", {}),
  serviceTierByProject: loadJson("crw-service-tier-by-project", {}),
  sessionStage: "sessions",
  forceScrollBottom: false
};

init();
setInterval(refreshBusyThreadClock, 5000);

async function init() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  try {
    const session = await api("/api/session", { authOptional: true });
    if (session.authenticated) setSession(session);
  } catch {
    // The login screen will handle a missing session.
  }
  render();
  if (state.user) await refreshAll();
}

function setSession(session) {
  state.csrf = session.csrf;
  state.user = session.user;
  state.version = session.version || "";
  connectEvents();
}

async function refreshAll() {
  await Promise.all([
    loadBridges(),
    loadProjects(),
    loadApprovals(),
    loadAudit()
  ]);
  render();
}

async function loadBridges() {
  const data = await api("/api/bridges");
  state.bridges = data.bridges || [];
}

async function loadProjects() {
  const data = await api("/api/projects");
  state.projects = data.projects || [];
  if (state.selectedProject) {
    state.selectedProject = state.projects.find(project => project.id === state.selectedProject.id) || state.selectedProject;
  }
  if (!state.selectedProject && state.projects[0]) state.selectedProject = state.projects[0];
}

async function loadThreads() {
  if (!state.selectedProject) {
    state.threads = [];
    return;
  }
  const data = await api(`/api/projects/${state.selectedProject.id}/threads`);
  state.threads = data.threads || [];
}

async function loadThread(threadId) {
  saveCurrentLiveThread();
  const data = await api(`/api/threads/${threadId}`);
  state.selectedThread = data.thread;
  state.thread = restoreLiveThread(threadId, data.thread);
  state.forceScrollBottom = true;
}

async function loadApprovals() {
  const data = await api("/api/approvals");
  state.approvals = data.approvals || [];
}

async function loadAudit() {
  const data = await api("/api/audit");
  state.audit = data.audit || [];
}

function connectEvents() {
  if (state.ws) state.ws.close();
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  state.ws = new WebSocket(`${protocol}//${location.host}/ws/client`);
  state.ws.addEventListener("message", event => {
    const message = safeJson(event.data);
    if (!message) return;
    handleLiveEvent(message);
  });
  state.ws.addEventListener("close", () => {
    setTimeout(() => {
      if (state.user) connectEvents();
    }, 2000);
  });
}

function handleLiveEvent(message) {
  if (message.type === "bridge.status" || message.type === "projects.updated") {
    loadBridges().then(loadProjects).then(render);
    return;
  }

  if (message.type === "approval.request" || message.type === "approval.updated") {
    loadApprovals().then(render);
    if (message.type === "approval.request") notify("Codex needs approval", `${message.approval.cwdAlias || "Project"} is waiting for a decision.`);
    return;
  }

  if (message.type === "codex.event") {
    const event = { ...(message.event || {}), receivedAt: message.createdAt || new Date().toISOString() };
    if (message.publicThreadId === state.selectedThread?.id) {
      applyCodexEvent(event);
      saveCurrentLiveThread();
      render();
    } else if (message.publicThreadId) {
      applyLiveThreadEvent(message.publicThreadId, event);
    }
    if (event.kind === "turn.status" && ["completed", "failed", "interrupted"].includes(event.status)) {
      notify("Codex task updated", `Status: ${event.status}`);
      if (state.selectedProject) loadThreads().then(render);
    }
  }
}

function applyCodexEvent(event) {
  if (!state.thread) return;
  state.thread.lastEventAt = event.receivedAt || new Date().toISOString();
  if (event.kind === "turn.status" && ["running", "submitted", "inProgress"].includes(event.status) && !state.thread.turnStartedAt) {
    state.thread.turnStartedAt = state.thread.lastEventAt;
  }
  if (event.kind === "codex.activity") {
    addActivity(event.message || "Codex activity updated.", event.level || "info", event.receivedAt);
    state.forceScrollBottom = true;
  }
  if (event.kind === "codex.notification") {
    const text = notificationActivityText(event.notification);
    if (text) {
      addActivity(text, "info", event.receivedAt);
      state.forceScrollBottom = true;
    }
  }
  if (event.kind === "thread.message" && event.message) {
    if (event.message.role === "assistant") clearReasoning();
    upsertThreadMessage(event.message);
  }
  if (event.kind === "reasoning.start") {
    addActivity("Codex started producing reasoning summary.", "info", event.receivedAt);
    state.thread.status = "thinking";
    state.thread.reasoning = "";
    state.forceScrollBottom = true;
  }
  if (event.kind === "reasoning.delta") {
    state.thread.status = "thinking";
    appendReasoning(event.content || "");
    state.forceScrollBottom = true;
  }
  if (event.kind === "assistant.delta") {
    addActivity("Assistant response has started streaming.", "info", event.receivedAt);
    clearReasoning();
    state.thread.status = "responding";
    state.thread.messages = state.thread.messages || [];
    let draft = state.thread.messages.find(item => item.id === "streaming_assistant");
    if (!draft) {
      draft = { id: "streaming_assistant", role: "assistant", content: "", createdAt: new Date().toISOString() };
      state.thread.messages.push(draft);
    }
    draft.content += event.content || "";
  }
  if (event.kind === "turn.status") {
    state.thread.status = event.status;
    addActivity(statusActivityText(event.status), event.status === "failed" ? "error" : "info", event.receivedAt);
    if (["completed", "failed", "interrupted"].includes(event.status)) {
      clearReasoning();
      state.thread.turnCompletedAt = event.receivedAt || new Date().toISOString();
    }
    if (event.status === "failed" && event.error) {
      state.thread.messages = state.thread.messages || [];
      state.thread.messages.push({
        id: `remote_error_${Date.now()}`,
        role: "assistant",
        content: `Remote Codex turn failed: ${event.error}`,
        createdAt: new Date().toISOString()
      });
      state.forceScrollBottom = true;
    }
  }
}

function saveCurrentLiveThread() {
  const threadId = state.selectedThread?.id || state.thread?.id;
  if (!threadId || !state.thread) return;
  state.liveThreads[threadId] = pickLiveThreadState(state.thread);
}

function restoreLiveThread(threadId, thread) {
  const live = state.liveThreads[threadId];
  if (!live) return thread;
  return {
    ...thread,
    status: live.status || thread.status,
    reasoning: live.reasoning || "",
    activity: live.activity || [],
    lastEventAt: live.lastEventAt || null,
    turnStartedAt: live.turnStartedAt || null,
    turnCompletedAt: live.turnCompletedAt || null
  };
}

function pickLiveThreadState(thread) {
  return {
    status: thread.status || "idle",
    reasoning: thread.reasoning || "",
    activity: Array.isArray(thread.activity) ? thread.activity.slice(-40) : [],
    lastEventAt: thread.lastEventAt || null,
    turnStartedAt: thread.turnStartedAt || null,
    turnCompletedAt: thread.turnCompletedAt || null
  };
}

function applyLiveThreadEvent(threadId, event) {
  const live = state.liveThreads[threadId] || {};
  live.lastEventAt = event.receivedAt || new Date().toISOString();
  if (event.kind === "turn.status" && ["running", "submitted", "inProgress"].includes(event.status) && !live.turnStartedAt) {
    live.turnStartedAt = live.lastEventAt;
  }
  if (event.kind === "codex.activity") {
    addActivityTo(live, event.message || "Codex activity updated.", event.level || "info", event.receivedAt);
  }
  if (event.kind === "codex.notification") {
    const text = notificationActivityText(event.notification);
    if (text) addActivityTo(live, text, "info", event.receivedAt);
  }
  if (event.kind === "thread.message" && event.message?.role === "assistant") {
    live.reasoning = "";
  }
  if (event.kind === "reasoning.start") {
    addActivityTo(live, "Codex started producing reasoning summary.", "info", event.receivedAt);
    live.status = "thinking";
    live.reasoning = "";
  }
  if (event.kind === "reasoning.delta") {
    live.status = "thinking";
    appendReasoningTo(live, event.content || "");
  }
  if (event.kind === "assistant.delta") {
    addActivityTo(live, "Assistant response has started streaming.", "info", event.receivedAt);
    live.reasoning = "";
    live.status = "responding";
  }
  if (event.kind === "turn.status") {
    live.status = event.status;
    addActivityTo(live, statusActivityText(event.status), event.status === "failed" ? "error" : "info", event.receivedAt);
    if (["completed", "failed", "interrupted"].includes(event.status)) {
      live.reasoning = "";
      live.turnCompletedAt = event.receivedAt || new Date().toISOString();
    }
  }
  state.liveThreads[threadId] = live;
}

function upsertThreadMessage(message) {
  state.thread.messages = state.thread.messages || [];
  if (message.role === "assistant") {
    state.thread.messages = state.thread.messages.filter(item => item.id !== "streaming_assistant");
  }
  const existingIndex = findDuplicateMessageIndex(message);
  if (existingIndex >= 0) {
    state.thread.messages[existingIndex] = {
      ...state.thread.messages[existingIndex],
      ...message,
      id: message.id || state.thread.messages[existingIndex].id
    };
  } else {
    state.thread.messages.push(message);
  }
  state.forceScrollBottom = true;
}

function clearReasoning() {
  if (state.thread) state.thread.reasoning = "";
}

function appendReasoning(content) {
  if (!state.thread) return;
  appendReasoningTo(state.thread, content);
}

function appendReasoningTo(thread, content) {
  if (!thread) return;
  const next = `${thread.reasoning || ""}${content}`;
  thread.reasoning = next.length > 40000 ? next.slice(-40000) : next;
}

function addActivity(message, level = "info", at = new Date().toISOString()) {
  if (!state.thread) return;
  addActivityTo(state.thread, message, level, at);
}

function addActivityTo(thread, message, level = "info", at = new Date().toISOString()) {
  if (!thread) return;
  const text = String(message || "").trim();
  if (!text) return;
  thread.activity = thread.activity || [];
  const last = thread.activity[thread.activity.length - 1];
  if (last && last.message === text && last.level === level) {
    last.at = at || new Date().toISOString();
    last.count = Number(last.count || 1) + 1;
  } else {
    thread.activity.push({
      id: `activity_${Date.now()}_${thread.activity.length}`,
      level,
      message: text,
      at: at || new Date().toISOString(),
      count: 1
    });
  }
  thread.activity = thread.activity.slice(-40);
}

function statusActivityText(status) {
  if (status === "submitted") return "Submitted to Codex.";
  if (status === "running" || status === "inProgress") return "Codex turn is running.";
  if (status === "thinking") return "Codex is thinking.";
  if (status === "responding") return "Assistant response is streaming.";
  if (status === "completed") return "Codex turn completed.";
  if (status === "failed") return "Codex turn failed.";
  if (status === "interrupted") return "Codex turn was interrupted.";
  return `Status changed: ${status || "idle"}.`;
}

function notificationActivityText(notification) {
  const method = notification?.method || notification?.kind || "";
  if (!method) return "";
  if (method === "turn/started") return "Codex app-server started the turn.";
  if (method === "item/started") return `Codex started item: ${notification?.params?.item?.type || "unknown"}.`;
  if (method === "item/completed") return `Codex completed item: ${notification?.params?.item?.type || "unknown"}.`;
  if (method === "error") return `Codex app-server reported an error${notification?.params?.willRetry ? " and will retry" : ""}.`;
  return `Codex event: ${method}.`;
}

function refreshBusyThreadClock() {
  if (!state.user || state.view !== "threads" || !state.thread || !isThreadBusy()) return;
  render();
}

function findDuplicateMessageIndex(message) {
  const byId = state.thread.messages.findIndex(item => item.id && message.id && item.id === message.id);
  if (byId >= 0) return byId;
  const content = normalizedMessageContent(message.content);
  if (!content) return -1;
  const createdAt = Date.parse(message.createdAt || "");
  return state.thread.messages.findIndex(item => {
    if (item.id === "streaming_assistant") return false;
    if (item.role !== message.role) return false;
    if (normalizedMessageContent(item.content) !== content) return false;
    const itemCreatedAt = Date.parse(item.createdAt || "");
    if (!Number.isFinite(createdAt) || !Number.isFinite(itemCreatedAt)) return true;
    return Math.abs(createdAt - itemCreatedAt) < 120000;
  });
}

function normalizedMessageContent(content) {
  return String(content || "").replace(/\s+/g, " ").trim();
}

function render() {
  const shouldStickToBottom = isMessagesNearBottom();
  if (!state.user) {
    app.className = "login";
    app.innerHTML = loginView();
    return;
  }

  app.className = "app-shell";
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Codex Remote Web</h1>
        <div class="muted">
          <span class="status-dot ${state.bridges.some(item => item.online) ? "online" : ""}"></span>
          ${state.bridges.filter(item => item.online).length}/${state.bridges.length} bridge online · v${escapeHtml(state.version)}
        </div>
      </div>
      <div class="toolbar">
        <button class="secondary" data-action="notify">Notifications</button>
        <button class="secondary" data-action="refresh">Refresh</button>
        <button class="danger" data-action="logout">Logout</button>
      </div>
    </header>
    <div class="workspace">
      <aside class="rail">${navView()}</aside>
      <main class="main">${mainView()}</main>
    </div>
  `;
  if (state.forceScrollBottom || shouldStickToBottom) {
    state.forceScrollBottom = false;
    requestAnimationFrame(scrollActiveMessagesToBottom);
  }
}

function loginView() {
  return `
    <form class="login-card stack" data-action="login">
      <div>
        <h1 class="brand">Codex Remote</h1>
        <p class="muted">Remote control for your local Windows Codex Bridge.</p>
      </div>
      <label class="stack">Username<input name="username" autocomplete="username" required /></label>
      <label class="stack">Password<input name="password" type="password" autocomplete="current-password" required /></label>
      <label class="stack">2FA code<input name="totp" inputmode="numeric" autocomplete="one-time-code" /></label>
      <label class="row"><input name="remember" type="checkbox" style="width:auto" /> Remember this device</label>
      <button type="submit">Sign in</button>
      <div id="login-error" class="muted"></div>
    </form>
  `;
}

function navView() {
  const items = [
    ["projects", "Projects"],
    ["threads", "Sessions"],
    ["approvals", `Approvals${pendingApprovalCount() ? ` (${pendingApprovalCount()})` : ""}`],
    ["diff", "Diff"],
    ["review", "Review"],
    ["audit", "Audit"],
    ["settings", "Settings"]
  ];
  return `<nav class="nav">${items.map(([view, label]) => `
    <button class="${state.view === view ? "active" : ""}" data-action="view" data-view="${view}">${label}</button>
  `).join("")}</nav>`;
}

function mainView() {
  if (state.view === "projects") return projectsView();
  if (state.view === "threads") return threadsView();
  if (state.view === "approvals") return approvalsView();
  if (state.view === "diff") return diffView();
  if (state.view === "review") return reviewView();
  if (state.view === "audit") return auditView();
  return settingsView();
}

function projectsView() {
  return `
    <section class="panel">
      <div class="toolbar">
        <h2>Projects</h2>
        <button class="secondary" data-action="refresh-projects">Refresh projects</button>
      </div>
      ${state.projects.length ? `<div class="grid">${state.projects.map(project => projectCard(project)).join("")}</div>` : empty("No online allowlisted projects. Start the Windows Bridge.")}
    </section>
  `;
}

function projectCard(project) {
  return `
    <article class="card ${project.id === state.selectedProject?.id ? "selected" : ""}">
      <h3>${escapeHtml(project.name)}</h3>
      <p class="muted">${escapeHtml(project.bridgeName)} · ${escapeHtml(project.pathAlias)}</p>
      <div class="row">
        <span class="pill">${escapeHtml(project.branch)}</span>
        <span class="pill ${project.dirty ? "hot" : ""}">${project.dirty ? `${project.changedFiles} changed` : "clean"}</span>
      </div>
      <div class="toolbar" style="margin-top:0.8rem">
        <button data-action="select-project" data-project="${project.id}">Open</button>
        <button class="secondary" data-action="project-diff" data-project="${project.id}">Diff</button>
      </div>
    </article>
  `;
}

function threadsView() {
  if (!state.selectedProject) return empty("Select an online project first.");
  const stage = currentSessionStage();
  return `
    <section class="panel sessions-panel session-stage-${stage}">
      <div class="toolbar">
        <h2>Sessions</h2>
        <span class="pill">app-server</span>
        <button data-action="new-thread">New session</button>
        <button class="secondary" data-action="refresh-projects">Refresh projects</button>
        <button class="secondary" data-action="load-threads">Reload sessions</button>
        ${state.selectedThread ? `<button class="secondary" data-action="interrupt-thread">Interrupt</button>` : ""}
      </div>
      ${mobileSessionNav(stage)}
      <div class="session-grid">
        <aside class="list project-list mobile-stage-panel mobile-projects">
          ${state.projects.length ? state.projects.map(projectListItem).join("") : empty("No projects online.")}
        </aside>
        <aside class="list session-list mobile-stage-panel mobile-sessions">
          <div class="card compact">
            <strong>${escapeHtml(state.selectedProject.name)}</strong>
            <div class="muted">${escapeHtml(state.selectedProject.bridgeName)} &middot; ${escapeHtml(state.selectedProject.pathAlias)}</div>
          </div>
          ${state.threads.length ? state.threads.map(threadListItem).join("") : empty("No sessions yet.")}
        </aside>
        ${chatView()}
      </div>
    </section>
  `;
}

function mobileSessionNav(stage) {
  const projectName = state.selectedProject?.name || "Project";
  const threadTitle = state.selectedThread?.title || state.thread?.title || "Chat";
  return `
    <div class="mobile-session-nav">
      ${stage !== "projects" ? `<button class="secondary" data-action="session-stage" data-stage="projects">Projects</button>` : ""}
      ${stage === "projects" && state.selectedProject ? `<button class="secondary" data-action="session-stage" data-stage="sessions">Sessions</button>` : ""}
      ${stage === "chat" ? `<button class="secondary" data-action="session-stage" data-stage="sessions">Sessions</button>` : ""}
      <span class="pill">${escapeHtml(stageLabel(stage))}</span>
      <span class="mobile-session-title">${escapeHtml(stage === "chat" ? threadTitle : projectName)}</span>
    </div>
  `;
}

function stageLabel(stage) {
  if (stage === "projects") return "Projects";
  if (stage === "sessions") return "Sessions";
  return "Chat";
}

function projectListItem(project) {
  return `
    <div class="list-item ${project.id === state.selectedProject?.id ? "active" : ""}" data-action="select-project" data-project="${project.id}">
      <strong>${escapeHtml(project.name)}</strong>
      <div class="muted">${escapeHtml(project.bridgeName)} &middot; ${project.discovered ? "discovered" : "configured"}</div>
      <div class="row">
        <span class="pill">${escapeHtml(project.branch)}</span>
        <span class="pill ${project.dirty ? "hot" : ""}">${project.dirty ? `${project.changedFiles} changed` : "clean"}</span>
      </div>
    </div>
  `;
}

function threadListItem(thread) {
  return `
    <div class="list-item ${thread.id === state.selectedThread?.id ? "active" : ""}" data-action="select-thread" data-thread="${thread.id}">
      <strong>${escapeHtml(thread.title || "Untitled session")}</strong>
      <div class="muted">${escapeHtml(thread.status || "idle")} · ${formatDate(thread.updatedAt)}</div>
      <div>${escapeHtml((thread.lastMessage || "").slice(0, 110))}</div>
    </div>
  `;
}

function chatView() {
  if (!state.thread) return `<div class="chat mobile-stage-panel mobile-chat">${empty("Select or create a session.")}</div>`;
  const messages = state.thread.messages || [];
  const draft = currentDraft();
  const busy = isThreadBusy();
  const models = currentModelOptions();
  const efforts = currentReasoningEffortOptions();
  const serviceTiers = currentServiceTierOptions();
  const selectedModel = currentModel();
  const selectedEffort = currentReasoningEffort();
  const selectedServiceTier = currentServiceTier();
  const reasoning = reasoningView();
  const activity = activityView();
  return `
    <section class="chat mobile-stage-panel mobile-chat">
      <div class="messages" data-chat-messages>
        ${messages.length ? messages.map(messageView).join("") : (reasoning || activity ? "" : empty("No messages yet."))}
        ${activity}
        ${reasoning}
      </div>
      <form class="composer" data-action="send-message">
        <textarea name="message" rows="4" placeholder="${escapeHtml(busy ? "Guide the active Codex turn..." : "Send a message to Codex...")}" required>${escapeHtml(draft.message || "")}</textarea>
        <textarea name="context" rows="2" placeholder="Optional small context block">${escapeHtml(draft.context || "")}</textarea>
        <div class="toolbar">
          <label class="model-picker">
            <span>Model</span>
            <select name="model">
              ${models.map(model => `<option value="${escapeHtml(model.id)}" ${model.id === selectedModel ? "selected" : ""}>${escapeHtml(model.label)}</option>`).join("")}
            </select>
          </label>
          <label class="model-picker compact-picker">
            <span>Reasoning</span>
            <select name="effort">
              ${efforts.map(option => `<option value="${escapeHtml(option.id)}" ${option.id === selectedEffort ? "selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}
            </select>
          </label>
          <label class="model-picker compact-picker">
            <span>Speed</span>
            <select name="serviceTier">
              ${serviceTiers.map(option => `<option value="${escapeHtml(option.id)}" ${option.id === selectedServiceTier ? "selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}
            </select>
          </label>
          <button type="submit" class="${busy ? "secondary" : ""}">${busy ? "Guide" : "Send"}</button>
          ${statusPill(state.thread.status || "idle")}
        </div>
      </form>
    </section>
  `;
}

function messageView(message) {
  return `
    <article class="message ${escapeHtml(message.role)}">
      <div class="muted">${escapeHtml(message.role)} · ${formatDate(message.createdAt)}</div>
      <div>${renderMarkdown(message.content || "")}</div>
    </article>
  `;
}

function activityView() {
  const status = String(state.thread?.status || "");
  const busy = isThreadBusy();
  const failed = status === "failed";
  if (!busy && !failed) return "";
  const activity = state.thread?.activity || [];
  const startedAt = Date.parse(state.thread?.turnStartedAt || "");
  const lastEventAt = Date.parse(state.thread?.lastEventAt || "");
  const now = Date.now();
  const elapsed = Number.isFinite(startedAt) ? formatDuration(now - startedAt) : "starting";
  const silent = Number.isFinite(lastEventAt) ? formatDuration(now - lastEventAt) : "no events yet";
  const stale = Number.isFinite(lastEventAt) && now - lastEventAt > 30000 && busy;
  return `
    <article class="message activity ${failed ? "error" : stale ? "warn" : ""}">
      <div class="activity-head">
        <div>
          <strong>${escapeHtml(statusText(status))}</strong>
          <div class="muted">elapsed ${escapeHtml(elapsed)} 路 last event ${escapeHtml(silent)} ago</div>
        </div>
        <span class="pulse ${stale ? "stale" : ""}"></span>
      </div>
      ${stale ? `<div class="activity-warning">No live event for ${escapeHtml(silent)}. The request may still be waiting on the model or network retry.</div>` : ""}
      <ol class="activity-list">
        ${activity.slice(-7).map(activityItemView).join("") || `<li class="muted">Waiting for Codex app-server to emit the next event.</li>`}
      </ol>
    </article>
  `;
}

function activityItemView(item) {
  const count = Number(item.count || 1);
  return `
    <li class="${escapeHtml(item.level || "info")}">
      <span>${escapeHtml(formatDate(item.at))}</span>
      <strong>${escapeHtml(item.message)}</strong>
      ${count > 1 ? `<em>x${count}</em>` : ""}
    </li>
  `;
}

function reasoningView() {
  const text = state.thread?.reasoning || "";
  const status = String(state.thread?.status || "");
  if (!text || ["completed", "failed", "interrupted", "idle"].includes(status)) return "";
  return `
    <article class="message reasoning">
      <div class="muted">reasoning · live</div>
      <div>${renderMarkdown(text)}</div>
    </article>
  `;
}

function approvalsView() {
  const approvals = state.approvals;
  return `
    <section class="panel">
      <div class="toolbar">
        <h2>Approvals</h2>
        <button class="secondary" data-action="load-approvals">Reload</button>
      </div>
      ${approvals.length ? approvals.map(approvalView).join("") : empty("No approval history.")}
    </section>
  `;
}

function approvalView(approval) {
  const pending = approval.status === "pending";
  return `
    <article class="card">
      <div class="toolbar">
        <h3>${escapeHtml(approval.cwdAlias || approval.projectAlias || "Project")}</h3>
        <span class="pill ${approval.risk === "high" ? "hot" : ""}">${escapeHtml(approval.risk)}</span>
        <span class="pill">${escapeHtml(approval.status)}</span>
      </div>
      <pre>${escapeHtml(approval.command || "")}</pre>
      <p class="muted">${escapeHtml(approval.reason || "")} · ${formatDate(approval.createdAt)}</p>
      ${pending ? `
        <div class="toolbar">
          <button data-action="approval" data-approval="${approval.id}" data-decision="allow" data-risk="${approval.risk}">Allow once</button>
          <button class="secondary" data-action="approval" data-approval="${approval.id}" data-decision="allow_prefix" data-risk="${approval.risk}">Allow prefix</button>
          <button class="danger" data-action="approval" data-approval="${approval.id}" data-decision="deny">Deny</button>
        </div>
      ` : ""}
    </article>
  `;
}

function diffView() {
  if (!state.selectedProject) return empty("Select a project first.");
  return `
    <section class="panel">
      <div class="toolbar">
        <h2>Diff</h2>
        <button data-action="load-diff">Load diff</button>
      </div>
      ${state.diff ? `
        <div class="row">${state.diff.files.map(file => `<span class="pill ${file.sensitive ? "hot" : ""}">${escapeHtml(file.code)} ${escapeHtml(file.file)}</span>`).join("")}</div>
        <pre class="diff">${escapeHtml(state.diff.diff || "No diff.")}</pre>
      ` : empty("Load the current Git diff for the selected project.")}
    </section>
  `;
}

function reviewView() {
  if (!state.selectedProject) return empty("Select a project first.");
  return `
    <section class="panel">
      <div class="toolbar">
        <h2>Review</h2>
        <button data-action="run-review">Run review</button>
      </div>
      ${state.review ? `
        <div class="card"><strong>${escapeHtml(state.review.summary || "")}</strong><div class="muted">${formatDate(state.review.generatedAt)}</div></div>
        ${state.review.findings?.length ? state.review.findings.map(findingView).join("") : empty("No findings.")}
      ` : empty("Run a review against the selected project's current diff.")}
    </section>
  `;
}

function findingView(finding) {
  return `
    <article class="card finding ${escapeHtml(finding.severity)}">
      <div class="toolbar">
        <h3>${escapeHtml(finding.title)}</h3>
        <span class="pill">${escapeHtml(finding.severity)}</span>
        <span class="pill">line ${escapeHtml(finding.line)}</span>
      </div>
      <p>${escapeHtml(finding.body)}</p>
    </article>
  `;
}

function auditView() {
  return `
    <section class="panel">
      <div class="toolbar">
        <h2>Audit</h2>
        <button class="secondary" data-action="load-audit">Reload</button>
      </div>
      ${state.audit.length ? state.audit.map(item => `
        <article class="card">
          <strong>${escapeHtml(item.action)}</strong>
          <div class="muted">${formatDate(item.createdAt)} · ${escapeHtml(item.userId || "system")}</div>
          <pre>${escapeHtml(JSON.stringify(item.details || {}, null, 2))}</pre>
        </article>
      `).join("") : empty("No audit entries.")}
    </section>
  `;
}

function settingsView() {
  return `
    <section class="panel">
      <h2>Settings</h2>
      <div class="grid">
        ${state.bridges.map(bridge => `
          <article class="card">
            <h3>${escapeHtml(bridge.name)}</h3>
            <p class="muted">${escapeHtml(bridge.id)} · ${bridge.online ? "online" : "offline"} · v${escapeHtml(bridge.version || "unknown")}</p>
            <p>${(bridge.projects || []).length} project(s)</p>
          </article>
        `).join("") || empty("No bridge has connected yet.")}
      </div>
      <article class="card stack">
        <h3>Two-factor authentication</h3>
        <p class="muted">${state.user.totpEnabled ? "Enabled" : "Disabled"}</p>
        ${state.user.totpEnabled ? `
          <form class="toolbar" data-action="disable-2fa">
            <input name="password" type="password" placeholder="Password" required />
            <button class="danger" type="submit">Disable 2FA</button>
          </form>
        ` : `
          <button data-action="setup-2fa">Set up 2FA</button>
          <div id="totp-setup"></div>
        `}
      </article>
      <article class="card">
        <h3>Sessions</h3>
        <button class="danger" data-action="logout-all">Logout all devices</button>
      </article>
    </section>
  `;
}

document.addEventListener("submit", async event => {
  const form = event.target;
  const action = form.dataset.action;
  if (!action) return;
  event.preventDefault();

  try {
    if (action === "login") {
      const body = Object.fromEntries(new FormData(form).entries());
      body.remember = form.elements.remember.checked;
      const session = await api("/api/login", { method: "POST", body, authOptional: true });
      setSession(session);
      await refreshAll();
    }

    if (action === "send-message") {
      if (!state.selectedThread) return;
      const steering = isThreadBusy();
      const body = Object.fromEntries(new FormData(form).entries());
      body.steer = steering;
      setCurrentModel(body.model || "");
      setCurrentReasoningEffort(body.effort || "");
      setCurrentServiceTier(body.serviceTier || "");
      if (state.thread) {
        const now = new Date().toISOString();
        if (!steering) {
          state.thread.status = "sending";
          state.thread.turnStartedAt = now;
          state.thread.activity = [];
        }
        state.thread.lastEventAt = now;
        addActivity(steering ? "Web submitted guidance for the active Codex turn." : "Web submitted the message to the remote gateway.", "info", now);
        saveCurrentLiveThread();
        render();
      }
      await api(`/api/threads/${state.selectedThread.id}/messages`, { method: "POST", body });
      clearCurrentDraft();
      form.reset();
      if (state.thread) {
        if (!steering) state.thread.status = "running";
        saveCurrentLiveThread();
        render();
      }
    }

    if (action === "disable-2fa") {
      const body = Object.fromEntries(new FormData(form).entries());
      await api("/api/2fa/disable", { method: "POST", body });
      const session = await api("/api/session");
      setSession(session);
      render();
    }
  } catch (error) {
    showError(error);
  }
});

document.addEventListener("click", async event => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;

  try {
    if (action === "view") {
      state.view = target.dataset.view;
      if (state.view === "threads") {
        await loadProjects();
        await loadThreads();
        state.sessionStage = state.selectedThread ? "chat" : "sessions";
      }
      if (state.view === "approvals") await loadApprovals();
      if (state.view === "audit") await loadAudit();
      render();
    }

    if (action === "refresh") await refreshAll();
    if (action === "refresh-projects") await loadProjects().then(render);
    if (action === "load-threads") await loadThreads().then(render);
    if (action === "load-approvals") await loadApprovals().then(render);
    if (action === "load-audit") await loadAudit().then(render);

    if (action === "select-project" || action === "project-diff") {
      saveCurrentLiveThread();
      state.selectedProject = state.projects.find(project => project.id === target.dataset.project);
      state.selectedThread = null;
      state.thread = null;
      state.sessionStage = "sessions";
      state.diff = null;
      state.review = null;
      if (action === "project-diff") state.view = "diff";
      else state.view = "threads";
      await loadThreads();
      render();
    }

    if (action === "new-thread") {
      const title = prompt("Session title", "Remote session");
      if (title === null) return;
      const data = await api("/api/threads", { method: "POST", body: { projectId: state.selectedProject.id, title } });
      await loadThreads();
      await loadThread(data.thread.id);
      state.sessionStage = "chat";
      render();
    }

    if (action === "select-thread") {
      await loadThread(target.dataset.thread);
      state.sessionStage = "chat";
      state.forceScrollBottom = true;
      render();
    }

    if (action === "session-stage") {
      state.sessionStage = target.dataset.stage || "sessions";
      render();
    }

    if (action === "interrupt-thread" && state.selectedThread) {
      await api(`/api/threads/${state.selectedThread.id}/interrupt`, { method: "POST", body: {} });
    }

    if (action === "approval") {
      const confirmHigh = target.dataset.risk === "high" ? confirm("This is a high-risk command. Confirm the decision?") : true;
      if (!confirmHigh) return;
      await api(`/api/approvals/${target.dataset.approval}/decision`, {
        method: "POST",
        body: { decision: target.dataset.decision, confirm: confirmHigh }
      });
      await loadApprovals();
      render();
    }

    if (action === "load-diff") {
      state.diff = await api(`/api/projects/${state.selectedProject.id}/diff`);
      render();
    }

    if (action === "run-review") {
      state.review = await api(`/api/projects/${state.selectedProject.id}/review`, { method: "POST", body: {} });
      render();
    }

    if (action === "notify") {
      if ("Notification" in window) await Notification.requestPermission();
    }

    if (action === "setup-2fa") {
      const setup = await api("/api/2fa/setup", { method: "POST", body: {} });
      const box = document.querySelector("#totp-setup");
      box.innerHTML = `
        <div class="stack">
          <label>Secret<input readonly value="${escapeHtml(setup.secret)}" /></label>
          <pre>${escapeHtml(setup.otpauthUrl)}</pre>
          <form class="toolbar" data-action="enable-2fa">
            <input name="token" inputmode="numeric" placeholder="6-digit code" required />
            <button type="submit">Enable</button>
          </form>
        </div>
      `;
      box.querySelector("form").addEventListener("submit", async event => {
        event.preventDefault();
        const body = Object.fromEntries(new FormData(event.target).entries());
        await api("/api/2fa/enable", { method: "POST", body });
        const session = await api("/api/session");
        setSession(session);
        render();
      });
    }

    if (action === "logout") {
      await api("/api/logout", { method: "POST", body: {} });
      location.reload();
    }

    if (action === "logout-all") {
      await api("/api/logout-all", { method: "POST", body: {} });
      location.reload();
    }
  } catch (error) {
    showError(error);
  }
});

async function api(path, options = {}) {
  const headers = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (state.csrf && options.method && options.method !== "GET") headers["x-csrf-token"] = state.csrf;
  const response = await fetch(path, {
    method: options.method || "GET",
    headers,
    credentials: "same-origin",
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || data.error || `HTTP ${response.status}`);
    error.data = data;
    throw error;
  }
  return data;
}

document.addEventListener("input", event => {
  const field = event.target;
  const form = field.closest?.('form[data-action="send-message"]');
  if (!form || !state.selectedThread) return;
  const draft = currentDraft();
  draft.message = form.elements.message.value;
  draft.context = form.elements.context.value;
});

document.addEventListener("change", event => {
  const field = event.target;
  const form = field.closest?.('form[data-action="send-message"]');
  if (!form) return;
  if (field.name === "model") setCurrentModel(field.value);
  if (field.name === "effort") setCurrentReasoningEffort(field.value);
  if (field.name === "serviceTier") setCurrentServiceTier(field.value);
});

function currentDraft() {
  const key = draftKey();
  if (!state.drafts[key]) state.drafts[key] = { message: "", context: "" };
  return state.drafts[key];
}

function clearCurrentDraft() {
  delete state.drafts[draftKey()];
}

function draftKey() {
  return state.selectedThread?.id || `project:${state.selectedProject?.id || "none"}`;
}

function currentSessionStage() {
  if (state.sessionStage === "projects") return "projects";
  if (state.sessionStage === "chat" && state.thread) return "chat";
  return "sessions";
}

function isThreadBusy(thread = state.thread) {
  return ["sending", "submitted", "running", "inProgress", "thinking", "responding"].includes(String(thread?.status || ""));
}

function currentModelOptions() {
  const configured = Array.isArray(state.selectedProject?.models) ? state.selectedProject.models : [];
  return [
    { id: "", label: "Codex default", description: "" },
    ...configured
  ];
}

function currentModel() {
  const projectId = state.selectedProject?.id || "global";
  const selected = String(state.modelByProject[projectId] || "");
  if (!selected) return "";
  return currentModelOptions().some(model => model.id === selected) ? selected : "";
}

function setCurrentModel(model) {
  const projectId = state.selectedProject?.id || "global";
  state.modelByProject[projectId] = String(model || "");
  saveJson("crw-model-by-project", state.modelByProject);
}

function currentReasoningEffortOptions() {
  const configured = Array.isArray(state.selectedProject?.reasoningEfforts) ? state.selectedProject.reasoningEfforts : [];
  return [
    { id: "", label: "Codex default", description: "" },
    ...configured
  ];
}

function currentReasoningEffort() {
  const projectId = state.selectedProject?.id || "global";
  const selected = String(state.effortByProject[projectId] || "");
  if (!selected) return "";
  return currentReasoningEffortOptions().some(option => option.id === selected) ? selected : "";
}

function setCurrentReasoningEffort(effort) {
  const projectId = state.selectedProject?.id || "global";
  state.effortByProject[projectId] = String(effort || "");
  saveJson("crw-effort-by-project", state.effortByProject);
}

function currentServiceTierOptions() {
  const configured = Array.isArray(state.selectedProject?.serviceTiers) ? state.selectedProject.serviceTiers : [];
  return [
    { id: "", label: "Codex default", description: "" },
    ...configured
  ];
}

function currentServiceTier() {
  const projectId = state.selectedProject?.id || "global";
  const selected = String(state.serviceTierByProject[projectId] || "");
  if (!selected) return "";
  return currentServiceTierOptions().some(option => option.id === selected) ? selected : "";
}

function setCurrentServiceTier(serviceTier) {
  const projectId = state.selectedProject?.id || "global";
  state.serviceTierByProject[projectId] = String(serviceTier || "");
  saveJson("crw-service-tier-by-project", state.serviceTierByProject);
}

function statusPill(status) {
  const normalized = String(status || "idle");
  const cls = normalized === "thinking" ? "thinking" : "";
  return `<span class="pill ${cls}">${escapeHtml(statusText(normalized))}</span>`;
}

function statusText(status) {
  if (status === "sending") return "sending";
  if (status === "thinking") return "thinking";
  if (status === "responding") return "responding";
  return status || "idle";
}

function empty(text) {
  return `<div class="empty">${escapeHtml(text)}</div>`;
}

function pendingApprovalCount() {
  return state.approvals.filter(item => item.status === "pending").length;
}

function notify(title, body) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (document.visibilityState === "visible") return;
  new Notification(title, { body, icon: "/icon.svg" });
}

function showError(error) {
  const loginError = document.querySelector("#login-error");
  const message = error.data?.retryAfterSeconds
    ? `${error.message} (${error.data.retryAfterSeconds}s)`
    : error.message;
  if (loginError) loginError.textContent = message;
  else alert(error.message);
}

function renderMarkdown(text) {
  const parts = String(text).split(/```/);
  return parts.map((part, index) => {
    if (index % 2 === 1) return `<pre><code>${escapeHtml(part.replace(/^\w+\n/, ""))}</code></pre>`;
    return escapeHtml(part)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\n/g, "<br />");
  }).join("");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDate(value) {
  if (!value) return "never";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function safeJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Selection persistence is a convenience; sending should still work without it.
  }
}

function scrollActiveMessagesToBottom() {
  if (state.view !== "threads" || !state.thread) return;
  const messages = document.querySelector("[data-chat-messages]");
  if (!messages) return;
  messages.scrollTop = messages.scrollHeight;
}

function isMessagesNearBottom() {
  const messages = document.querySelector("[data-chat-messages]");
  if (!messages) return true;
  return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 120;
}
