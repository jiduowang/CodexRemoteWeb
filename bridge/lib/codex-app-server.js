const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const { sendToCodexDesktop } = require("./desktop-ui");

class CodexAppServerAdapter {
  constructor(config = {}) {
    this.config = config;
    this.command = config.command || "codex";
    this.args = config.args || ["app-server"];
    this.desktopProxy = {
      enabled: config.desktopProxy?.enabled === true,
      command: config.desktopProxy?.command || this.command,
      args: config.desktopProxy?.args || ["app-server", "proxy"],
      fallbackToDirect: config.desktopProxy?.fallbackToDirect !== false
    };
    this.models = normalizeModelOptions(config.models || []);
    this.allowedModelIds = new Set(this.models.map(model => model.id));
    this.reasoningEfforts = normalizeModelOptions(config.reasoningEfforts || []);
    this.allowedReasoningEfforts = new Set(this.reasoningEfforts.map(option => option.id));
    this.reasoningSummary = normalizeReasoningSummary(config.reasoningSummary || "auto");
    this.serviceTiers = normalizeModelOptions(config.serviceTiers || []);
    this.allowedServiceTiers = new Set(this.serviceTiers.map(option => option.id));
    this.desktopSync = {
      statusNotifications: config.desktopSync?.statusNotifications === true
    };
    this.methods = {
      initialize: "initialize",
      listThreads: "thread/list",
      readThread: "thread/read",
      createThread: "thread/start",
      setThreadName: "thread/name/set",
      resumeThread: "thread/resume",
      startTurn: "turn/start",
      steerTurn: "turn/steer",
      interruptTurn: "turn/interrupt",
      startReview: "review/start",
      ...(config.methods || {})
    };
    this.process = null;
    this.nextId = 1;
    this.pending = new Map();
    this.startPromise = null;
    this.stderrBuffer = "";
    this.threadCache = new Map();
    this.localThreadTitles = new Map();
    this.threadProjectAliases = new Map();
    this.loadedThreads = new Set();
    this.discoveredProjects = new Map();
    this.lastProjectDiscoveryAt = 0;
    this.liveEmitter = null;
    this.threadWatches = new Map();
    this.currentTurnIds = new Map();
    this.activeThreadIds = new Set();
    this.guidanceQueues = new Map();
  }

  setLiveEmitter(handler) {
    this.liveEmitter = typeof handler === "function" ? handler : null;
  }

  async listThreads(project) {
    await this.#ensureStarted(project);
    const result = await this.#request(this.methods.listThreads, {
      cwd: project.path,
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"]
    });
    const remoteThreads = normalizeThreadList(result).map(thread => this.#applyLocalThreadTitle(thread));
    const cachedThreads = [...(this.threadCache.get(project.alias)?.values() || [])];
    return { threads: mergeThreads(remoteThreads, cachedThreads) };
  }

  async readThread(project, threadId) {
    await this.#ensureStarted(project);
    const result = await this.#request(this.methods.readThread, { cwd: project.path, threadId });
    const thread = this.#applyLocalThreadTitle(normalizeThread(result.thread || result));
    if (thread.messages.length === 0 && thread.path) {
      thread.messages = readSessionMessages(thread.path);
    }
    this.#rememberThread(project, thread);
    this.#watchThread(project, thread);
    return { thread };
  }

  async createThread(project, { title, initialMessage } = {}) {
    await this.#ensureStarted(project);
    const requestedTitle = normalizeRequestedTitle(title);
    const result = await this.#request(this.methods.createThread, {
      cwd: project.path,
      name: requestedTitle || undefined,
      input: initialMessage ? [{ type: "text", text: initialMessage }] : undefined
    });
    const thread = normalizeThread(result.thread || result);
    if (requestedTitle) {
      this.#rememberLocalThreadTitle(thread, requestedTitle);
      this.#applyLocalThreadTitle(thread);
      await this.#setThreadNameIfAvailable(thread, requestedTitle);
    }
    if (initialMessage && !thread.preview) thread.preview = initialMessage;
    this.#rememberThread(project, thread);
    this.#markThreadLoaded(thread);
    this.#watchThread(project, thread);
    return { thread };
  }

  async sendMessage(project, { threadId, message, context, model, effort, serviceTier, steer }, emit) {
    this.#associateThread(project, threadId);
    await this.#ensureStarted(project);
    const text = context ? `${message}\n\nContext:\n${context}` : message;
    if (steer || this.#isThreadActive(threadId)) {
      return this.#steerMessage(project, { threadId, text }, emit);
    }
    emit({ kind: "codex.activity", level: "info", message: "Bridge accepted the message and is preparing the Codex turn." });
    emit({ kind: "turn.status", status: "running" });
    await this.#resumeThreadIfNeeded(project, threadId);
    emit({ kind: "codex.activity", level: "info", message: "Session is loaded. Sending the turn to Codex app-server." });
    const cached = this.#getCachedThread(project, threadId);
    if (cached) this.#watchThread(project, cached);

    if (this.config.desktopUi?.enabled) {
      await sendToCodexDesktop(text, this.config.desktopUi);
      emit({ kind: "turn.status", status: "submitted" });
      return;
    }

    const input = [{ type: "text", text }];
    const params = {
      cwd: project.path,
      threadId,
      input
    };
    const selectedModel = this.#resolveModel(model);
    if (selectedModel) params.model = selectedModel;
    const selectedEffort = this.#resolveReasoningEffort(effort);
    if (selectedEffort) params.effort = selectedEffort;
    const selectedSummary = this.#resolveReasoningSummary(selectedEffort);
    if (selectedSummary) params.summary = selectedSummary;
    const selectedServiceTier = this.#resolveServiceTier(serviceTier);
    if (selectedServiceTier) params.serviceTier = selectedServiceTier;
    emit({ kind: "codex.activity", level: "info", message: activityTurnOptions(params) });
    this.activeThreadIds.add(threadId);
    this.#notifyThreadStatusChanged(threadId, { type: "active", activeFlags: [] }, emit);
    let result;
    try {
      result = await this.#request(this.methods.startTurn, params);
    } catch (error) {
      this.activeThreadIds.delete(threadId);
      this.#notifyThreadStatusChanged(threadId, { type: "idle" }, emit);
      throw error;
    }
    emit({ kind: "codex.activity", level: "info", message: "Codex app-server accepted the turn. Waiting for model or tool events." });
    if (cached) {
      cached.preview = message;
      cached.updatedAt = Math.floor(Date.now() / 1000);
      cached.status = { type: "running" };
      this.#rememberThread(project, cached);
      this.#watchThread(project, cached);
    }
    if (result.turn?.id) {
      this.currentTurnIds.set(threadId, result.turn.id);
      this.currentTurnId = result.turn.id;
    }
  }

  async interrupt(project, threadId) {
    await this.#ensureStarted(project);
    const turnId = this.currentTurnIds.get(threadId);
    if (!turnId) throw new Error("No active Codex turn is known for this session.");
    return this.#request(this.methods.interruptTurn, {
      cwd: project.path,
      threadId,
      turnId
    });
  }

  async #steerMessage(project, { threadId, text }, emit) {
    const content = String(text || "").trim();
    if (!content) return { accepted: false };
    this.#associateThread(project, threadId);
    emit({
      kind: "thread.message",
      message: {
        id: `steer_user_${Date.now()}`,
        role: "user",
        content: `Guidance:\n${content}`,
        createdAt: new Date().toISOString()
      }
    });
    emit({ kind: "codex.activity", level: "info", message: "Guidance received. Sending it into the active Codex turn." });

    const turnId = await this.#waitForTurnId(threadId, 8000);
    if (!turnId) {
      this.#queueGuidance(project, threadId, content);
      emit({ kind: "codex.activity", level: "warn", message: "Active turn id is not available yet. Guidance queued for the next turn." });
      return { accepted: true, queued: true };
    }

    try {
      const result = await this.#request(this.methods.steerTurn, {
        threadId,
        expectedTurnId: turnId,
        input: [{ type: "text", text: content }]
      });
      emit({ kind: "codex.activity", level: "info", message: "Guidance was accepted by Codex app-server for the active turn." });
      return { accepted: true, steered: true, turnId: result.turnId || turnId };
    } catch (error) {
      if (isNotSteerableError(error)) {
        this.#queueGuidance(project, threadId, content);
        emit({ kind: "codex.activity", level: "warn", message: "This active turn cannot accept same-turn guidance. Guidance queued for the next turn." });
        return { accepted: true, queued: true };
      }
      throw error;
    }
  }

  async discoverProjects(seedProject) {
    if (Date.now() - this.lastProjectDiscoveryAt < 15000) {
      return [...this.discoveredProjects.values()];
    }
    await this.#ensureStarted(seedProject);
    const result = await this.#request(this.methods.listThreads, {
      limit: 200,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"]
    });
    for (const thread of normalizeThreadList(result)) {
      if (!thread.cwd || typeof thread.cwd !== "string") continue;
      const project = projectFromCwd(thread.cwd);
      if (!project) continue;
      const current = this.discoveredProjects.get(project.alias);
      this.discoveredProjects.set(project.alias, {
        ...project,
        lastThreadAt: maxIso(current?.lastThreadAt, thread.updatedAt)
      });
    }
    this.lastProjectDiscoveryAt = Date.now();
    return [...this.discoveredProjects.values()];
  }

  async #ensureStarted(project) {
    if (this.process && this.startPromise) {
      await this.startPromise;
      return;
    }
    if (this.process) return;
    this.startPromise = this.#startProcess(project);
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async #startProcess(project) {
    const attempts = this.#launchAttempts();
    let lastError = null;
    for (const attempt of attempts) {
      try {
        await this.#startProcessAttempt(project, attempt);
        return;
      } catch (error) {
        lastError = error;
        if (!attempt.optional) break;
        console.warn(`[codex-app-server] ${attempt.label} unavailable (${briefError(error)}). Using direct app-server instead; Desktop UI sync needs a working app-server proxy.`);
      }
    }
    throw lastError || new Error("Unable to start Codex app-server.");
  }

  #launchAttempts() {
    const direct = {
      label: "direct app-server",
      command: this.command,
      args: this.args,
      optional: false
    };
    if (!this.desktopProxy.enabled) return [direct];
    const proxy = {
      label: "desktop app-server proxy",
      command: this.desktopProxy.command,
      args: this.desktopProxy.args,
      optional: this.desktopProxy.fallbackToDirect
    };
    return this.desktopProxy.fallbackToDirect ? [proxy, direct] : [proxy];
  }

  async #startProcessAttempt(project, launch) {
    const child = commandForSpawn(launch.command, launch.args);
    const proc = spawn(child.command, child.args, {
      cwd: project.path,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.process = proc;

    let startupStderr = "";
    const stderrHandler = chunk => {
      if (launch.optional) {
        startupStderr += chunk.toString("utf8");
        if (startupStderr.length > 8192) startupStderr = startupStderr.slice(-8192);
        return;
      }
      this.#handleStderrChunk(chunk);
    };
    proc.stderr.on("data", stderrHandler);

    proc.on("exit", code => {
      if (this.process !== proc) return;
      for (const pending of this.pending.values()) pending.reject(new Error(`Codex app-server exited with code ${code}`));
      this.pending.clear();
      this.process = null;
      this.startPromise = null;
      this.currentTurnId = null;
      this.currentTurnIds.clear();
      this.activeThreadIds.clear();
      this.loadedThreads.clear();
    });

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on("line", line => {
      const message = parseJson(line);
      if (!message) return;
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(jsonRpcErrorText(message.error)));
        else pending.resolve(message.result || {});
        return;
      }
      if (message.id && message.method) {
        this.#handleServerRequest(message);
        return;
      }
      this.#emitNotification(message);
    });

    try {
      await this.#request(this.methods.initialize, {
        clientInfo: {
          name: "codex-remote-web-bridge",
          title: "Codex Remote Web Bridge",
          version: "0.1.0"
        },
        capabilities: {
          experimentalApi: true
        }
      });
    } catch (error) {
      this.process?.kill();
      this.process = null;
      const stderrReason = summarizeStartupStderr(startupStderr);
      throw new Error(`Codex app-server initialize failed: ${error.message}${stderrReason ? `; ${stderrReason}` : ""}`);
    }

    if (launch.optional) {
      proc.stderr.off("data", stderrHandler);
      proc.stderr.on("data", chunk => this.#handleStderrChunk(chunk));
    }
    this.#notify("initialized", {});
  }

  #request(method, params) {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process.stdin.write(`${JSON.stringify(payload)}\n`);
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`Codex app-server timeout: ${method}`));
      }, this.config.timeoutMs || 60000).unref();
    });
  }

  #notify(method, params) {
    this.process.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  #respond(id, result) {
    if (!this.process?.stdin?.writable) return;
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  #respondError(id, message, code = -32601) {
    if (!this.process?.stdin?.writable) return;
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
  }

  #handleServerRequest(message) {
    const method = String(message.method || "");
    const params = message.params || {};
    const notice = `Codex app-server requested client-side action "${method}", which Codex Remote Web does not handle yet. The request was declined instead of being left pending.`;

    if (method === "item/commandExecution/requestApproval") {
      this.#respond(message.id, { decision: "decline" });
      this.#emitRequestNotice(params, notice);
      return;
    }
    if (method === "item/fileChange/requestApproval") {
      this.#respond(message.id, { decision: "decline" });
      this.#emitRequestNotice(params, notice);
      return;
    }
    if (method === "item/permissions/requestApproval") {
      this.#respond(message.id, {
        permissions: { fileSystem: null, network: null },
        scope: "turn",
        strictAutoReview: true
      });
      this.#emitRequestNotice(params, notice);
      return;
    }
    if (method === "applyPatchApproval" || method === "execCommandApproval") {
      this.#respond(message.id, { decision: "denied" });
      this.#emitRequestNotice(params, notice);
      return;
    }
    if (method === "mcpServer/elicitation/request") {
      this.#respond(message.id, { action: "decline" });
      this.#emitRequestNotice(params, notice);
      return;
    }
    if (method === "item/tool/requestUserInput") {
      this.#respond(message.id, { answers: {} });
      this.#emitRequestNotice(params, notice);
      return;
    }
    if (method === "item/tool/call") {
      this.#respond(message.id, {
        success: false,
        contentItems: [{ type: "inputText", text: notice }]
      });
      this.#emitRequestNotice(params, notice);
      return;
    }

    this.#respondError(message.id, notice);
    this.#emitRequestNotice(params, notice, "failed");
  }

  #handleStderrChunk(chunk) {
    this.stderrBuffer += chunk.toString("utf8");
    const lines = this.stderrBuffer.split(/\r?\n/);
    this.stderrBuffer = lines.pop() || "";
    for (const line of lines) this.#handleStderrLine(line);
    if (this.stderrBuffer.length > 64 * 1024) {
      this.#handleStderrLine(this.stderrBuffer);
      this.stderrBuffer = "";
    }
  }

  #handleStderrLine(line) {
    const text = String(line || "").trim();
    if (!text) return;
    const parsed = parseJson(text);
    const level = String(parsed?.level || "INFO").toLowerCase();
    const message = parsed?.fields?.message || text;
    console.error(`[codex-app-server] ${message}`);
    if (!shouldForwardAppServerLog(level, message)) return;
    this.#emitActivityToActiveThreads({
      level: level === "error" ? "error" : "warn",
      message: `Codex app-server: ${sanitizeActivityMessage(message)}`
    });
  }

  #emitActivityToActiveThreads(activity) {
    const threadIds = new Set([...this.activeThreadIds, ...this.currentTurnIds.keys()]);
    if (!this.liveEmitter || threadIds.size === 0) return;
    for (const threadId of threadIds) {
      const projectAlias = this.#projectAliasForThread(threadId);
      if (!projectAlias) continue;
      this.liveEmitter(projectAlias, threadId, {
        kind: "codex.activity",
        ...activity,
        createdAt: new Date().toISOString()
      });
    }
  }

  #emitRequestNotice(params, content, status = "running") {
    const threadId = params.threadId || params.conversationId;
    if (!threadId || !this.liveEmitter) return;
    const projectAlias = this.#projectAliasForThread(threadId);
    if (!projectAlias) return;
    this.liveEmitter(projectAlias, threadId, {
      kind: "thread.message",
      message: {
        id: `app_server_request_${Date.now()}`,
        role: "assistant",
        content,
        createdAt: new Date().toISOString()
      }
    });
    if (status === "failed") {
      this.liveEmitter(projectAlias, threadId, { kind: "turn.status", status: "failed", error: content });
    }
  }

  #rememberThread(project, thread) {
    const id = thread?.id || thread?.sessionId;
    if (!id) return;
    this.#applyLocalThreadTitle(thread);
    if (!this.threadCache.has(project.alias)) this.threadCache.set(project.alias, new Map());
    this.threadCache.get(project.alias).set(id, thread);
    this.#associateThread(project, id);
  }

  #rememberLocalThreadTitle(thread, title) {
    const id = thread?.id || thread?.threadId || thread?.sessionId;
    const requestedTitle = normalizeRequestedTitle(title);
    if (!id || !requestedTitle) return;
    this.localThreadTitles.set(id, requestedTitle);
  }

  #applyLocalThreadTitle(thread) {
    const id = thread?.id || thread?.threadId || thread?.sessionId;
    const localTitle = id ? this.localThreadTitles.get(id) : null;
    if (!localTitle) return thread;
    thread.name = localTitle;
    thread.title = localTitle;
    return thread;
  }

  async #setThreadNameIfAvailable(thread, title) {
    const id = thread?.id || thread?.threadId || thread?.sessionId;
    const requestedTitle = normalizeRequestedTitle(title);
    if (!id || !requestedTitle || !this.methods.setThreadName) return;
    try {
      await this.#request(this.methods.setThreadName, { threadId: id, name: requestedTitle });
    } catch (error) {
      console.warn(`[codex-app-server] unable to set thread name for ${id}: ${error.message}`);
    }
  }

  #getCachedThread(project, threadId) {
    return this.threadCache.get(project.alias)?.get(threadId);
  }

  #associateThread(project, threadId) {
    if (project?.alias && threadId) this.threadProjectAliases.set(threadId, project.alias);
  }

  #resolveModel(model) {
    return resolveAllowlistedOption(model, this.allowedModelIds, "Model");
  }

  #resolveReasoningEffort(effort) {
    return resolveAllowlistedOption(effort, this.allowedReasoningEfforts, "Reasoning effort");
  }

  #resolveReasoningSummary(effort) {
    if (effort === "none") return "none";
    return this.reasoningSummary;
  }

  #resolveServiceTier(serviceTier) {
    return resolveAllowlistedOption(serviceTier, this.allowedServiceTiers, "Service tier");
  }

  #isThreadActive(threadId) {
    return this.activeThreadIds.has(threadId) || this.currentTurnIds.has(threadId);
  }

  async #waitForTurnId(threadId, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const turnId = this.currentTurnIds.get(threadId);
      if (turnId) return turnId;
      await delay(100);
    }
    return this.currentTurnIds.get(threadId) || null;
  }

  #queueGuidance(project, threadId, text) {
    const queue = this.guidanceQueues.get(threadId) || [];
    queue.push({
      project,
      text: String(text || "").trim(),
      createdAt: new Date().toISOString()
    });
    this.guidanceQueues.set(threadId, queue.slice(-10));
  }

  #notifyThreadStatusChanged(threadId, status, emit) {
    if (!this.desktopSync.statusNotifications || !threadId || !status?.type) return;
    try {
      this.#notify("thread/status/changed", { threadId, status });
      emit?.({
        kind: "codex.activity",
        level: "info",
        message: `Bridge emitted thread/status/changed(${status.type}) for desktop sync.`
      });
    } catch (error) {
      emit?.({
        kind: "codex.activity",
        level: "warn",
        message: `Unable to emit desktop sync status notification: ${error.message || String(error)}`
      });
    }
  }

  #flushGuidanceQueue(threadId) {
    const queue = this.guidanceQueues.get(threadId);
    if (!queue?.length || this.#isThreadActive(threadId)) return;
    this.guidanceQueues.delete(threadId);
    const project = queue[queue.length - 1].project;
    const content = queue.map((item, index) => `Guidance ${index + 1} (${item.createdAt}):\n${item.text}`).join("\n\n");
    const emit = event => this.liveEmitter?.(project.alias, threadId, event);
    emit({ kind: "codex.activity", level: "info", message: "Starting a follow-up turn with queued guidance." });
    this.sendMessage(project, {
      threadId,
      message: `Please apply the following guidance from the user:\n\n${content}`
    }, emit).catch(error => {
      emit({
        kind: "turn.status",
        status: "failed",
        error: `Queued guidance failed: ${error.message || String(error)}`
      });
    });
  }

  async #resumeThreadIfNeeded(project, threadId) {
    if (this.loadedThreads.has(threadId)) return;
    const cached = this.#getCachedThread(project, threadId);
    const params = {
      cwd: project.path,
      threadId
    };
    if (cached?.path && fs.existsSync(cached.path)) params.path = cached.path;
    const result = await this.#request(this.methods.resumeThread, params);
    const thread = this.#applyLocalThreadTitle(normalizeThread(result.thread || result));
    if (thread.messages.length === 0 && thread.path) thread.messages = readSessionMessages(thread.path);
    this.#rememberThread(project, thread);
    this.#watchThread(project, thread);
    this.#markThreadLoaded(thread);
    this.loadedThreads.add(threadId);
  }

  #markThreadLoaded(thread) {
    const id = thread?.id || thread?.threadId || thread?.sessionId;
    if (id) this.loadedThreads.add(id);
  }

  #watchThread(project, thread) {
    if (!this.liveEmitter) return;
    const threadId = thread?.id || thread?.threadId || thread?.sessionId;
    if (!threadId || !thread.path || this.threadWatches.has(threadId)) return;
    if (!isSafeSessionPath(thread.path)) return;

    const initialMessages = readSessionMessages(thread.path);
    const seen = new Set(initialMessages.map(messageKey));
    const watch = {
      filePath: path.resolve(thread.path),
      projectAlias: project.alias,
      threadId,
      seen,
      timer: null
    };
    watch.timer = setInterval(() => this.#pollThreadWatch(watch), this.config.sessionPollMs || 1000);
    watch.timer.unref();
    this.threadWatches.set(threadId, watch);
  }

  #pollThreadWatch(watch) {
    const messages = readSessionMessages(watch.filePath);
    for (const message of messages) {
      const key = messageKey(message);
      if (watch.seen.has(key)) continue;
      watch.seen.add(key);
      this.liveEmitter?.(watch.projectAlias, watch.threadId, {
        kind: "thread.message",
        message: { ...message, source: "session-file" }
      });
      this.liveEmitter?.(watch.projectAlias, watch.threadId, {
        kind: "turn.status",
        status: message.role === "assistant" ? "completed" : "running"
      });
    }
  }

  #emitNotification(notification) {
    if (notification.method === "thread/name/updated") {
      const threadId = notification.params?.threadId;
      const threadName = normalizeRequestedTitle(notification.params?.threadName);
      if (threadId && threadName) this.localThreadTitles.set(threadId, threadName);
    }

    const event = normalizeNotification(notification);
    if (!event) return;

    const threadId = event.threadId || threadIdFromNotification(notification);
    if (!threadId) return;

    const turnId = notification?.params?.turn?.id || notification?.params?.turnId;
    if (turnId) {
      this.currentTurnIds.set(threadId, turnId);
      this.currentTurnId = turnId;
    }
    if (event.kind === "turn.status" && ["completed", "failed", "interrupted"].includes(event.status)) {
      this.currentTurnIds.delete(threadId);
      this.activeThreadIds.delete(threadId);
      this.#notifyThreadStatusChanged(threadId, { type: "idle" });
      if (event.status === "completed") setTimeout(() => this.#flushGuidanceQueue(threadId), 0);
    }

    const projectAlias = this.#projectAliasForThread(threadId);
    if (!projectAlias || !this.liveEmitter) return;

    const publicEvent = { ...event };
    delete publicEvent.threadId;
    this.liveEmitter(projectAlias, threadId, publicEvent);
  }

  #projectAliasForThread(threadId) {
    if (this.threadProjectAliases.has(threadId)) return this.threadProjectAliases.get(threadId);
    for (const [projectAlias, threads] of this.threadCache.entries()) {
      if (threads.has(threadId)) return projectAlias;
    }
    return null;
  }
}

function normalizeNotification(notification) {
  const method = notification.method || notification.kind || "notification";
  const params = notification.params || {};

  if (method === "item/agentMessage/delta") {
    return { kind: "assistant.delta", content: params.delta || params.text || "", threadId: params.threadId };
  }

  if (method === "item/started" && params.item?.type === "reasoning") {
    return { kind: "reasoning.start", threadId: params.threadId };
  }

  if (method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta") {
    return { kind: "reasoning.delta", content: params.delta || "", threadId: params.threadId };
  }

  if (method === "item/reasoning/summaryPartAdded") {
    return { kind: "reasoning.delta", content: "\n\n", threadId: params.threadId };
  }

  if (method === "model/rerouted") {
    return {
      kind: "thread.message",
      threadId: params.threadId,
      message: {
        id: `model_rerouted_${params.turnId || Date.now()}`,
        role: "assistant",
        content: `Model rerouted from ${params.fromModel} to ${params.toModel}.`,
        createdAt: new Date().toISOString()
      }
    };
  }

  if (method === "item/completed" && params.item?.type === "reasoning") {
    const content = reasoningContentFromItem(params.item);
    return content
      ? { kind: "reasoning.delta", content, threadId: params.threadId }
      : { kind: "reasoning.start", threadId: params.threadId };
  }

  if (method === "item/completed") {
    const message = messageFromThreadItem(params.item, params.completedAtMs);
    if (message) return { kind: "thread.message", message, threadId: params.threadId };
  }

  if (method === "turn/completed") {
    const status = normalizeTurnStatus(params.turn?.status || "completed");
    return {
      kind: "turn.status",
      status,
      error: turnErrorText(params.turn?.error),
      threadId: params.threadId
    };
  }

  if (method === "turn/started") {
    return { kind: "turn.status", status: "running", threadId: params.threadId };
  }

  if (method === "turn/interrupted") {
    return { kind: "turn.status", status: "interrupted", threadId: params.threadId };
  }

  if (method === "thread/status/changed") {
    return { kind: "turn.status", status: normalizeThreadStatus(params.status), threadId: params.threadId };
  }

  if (method === "error") {
    if (params.willRetry) return { kind: "codex.notification", notification, threadId: params.threadId };
    return {
      kind: "turn.status",
      status: "failed",
      error: turnErrorText(params.error) || "Codex app-server error",
      threadId: params.threadId
    };
  }

  return { kind: "codex.notification", notification, threadId: params.threadId };
}

function threadIdFromNotification(notification) {
  const params = notification?.params || {};
  return params.threadId || params.turn?.threadId || null;
}

function turnErrorText(error) {
  if (!error) return null;
  if (typeof error === "string") return error;
  const parts = [];
  if (error.message) parts.push(error.message);
  if (error.additionalDetails && error.additionalDetails !== error.message) {
    parts.push(error.additionalDetails);
  }
  if (error.codexErrorInfo) {
    parts.push(`codexErrorInfo: ${formatCodexErrorInfo(error.codexErrorInfo)}`);
  }
  return uniqueNonEmpty(parts).join("\n") || safeJson(error);
}

function jsonRpcErrorText(error) {
  if (!error) return "Codex app-server error";
  if (typeof error === "string") return error;
  const parts = [];
  if (error.message) parts.push(error.message);
  if (error.data) parts.push(safeJson(error.data));
  return uniqueNonEmpty(parts).join("\n") || safeJson(error);
}

function briefError(error) {
  const text = String(error?.message || error || "unknown error")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(-2)
    .join(" / ");
  return text || "unknown error";
}

function summarizeStartupStderr(stderr) {
  const lines = String(stderr || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";
  const useful = lines.filter(line => /error|failed|socket|os error|拒绝|无法|网络/i.test(line));
  return (useful.length ? useful : lines).slice(-3).join(" / ");
}

function isNotSteerableError(error) {
  const text = `${error?.message || ""} ${safeJson(error?.data || "")}`.toLowerCase();
  return text.includes("activeturnnotsteerable") || text.includes("cannot accept same-turn steering") || text.includes("not steerable");
}

function formatCodexErrorInfo(info) {
  if (typeof info === "string") return info;
  if (!info || typeof info !== "object") return String(info);
  return Object.entries(info).map(([key, value]) => {
    if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "httpStatusCode")) {
      return `${key}(httpStatusCode=${value.httpStatusCode ?? "none"})`;
    }
    return `${key}: ${safeJson(value)}`;
  }).join(", ");
}

function uniqueNonEmpty(values) {
  return [...new Set(values.map(value => String(value || "").trim()).filter(Boolean))];
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeThreadList(result) {
  const raw = result.data || result.threads || result.items || [];
  return raw.map(normalizeThread);
}

function normalizeRequestedTitle(title) {
  return String(title || "").trim();
}

function normalizeReasoningSummary(value) {
  const summary = String(value || "").trim();
  return ["auto", "concise", "detailed", "none"].includes(summary) ? summary : "auto";
}

function normalizeModelOptions(models) {
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

function resolveAllowlistedOption(value, allowedValues, label) {
  const selected = String(value || "").trim();
  if (!selected) return null;
  if (allowedValues.size > 0 && !allowedValues.has(selected)) {
    throw new Error(`${label} is not allowed by bridge config: ${selected}`);
  }
  return selected;
}

function activityTurnOptions(params) {
  const options = [];
  if (params.model) options.push(`model=${params.model}`);
  if (params.effort) options.push(`effort=${params.effort}`);
  if (params.summary) options.push(`summary=${params.summary}`);
  if (params.serviceTier) options.push(`speed=${params.serviceTier}`);
  return `Starting Codex turn${options.length ? ` (${options.join(", ")})` : ""}.`;
}

function shouldForwardAppServerLog(level, message) {
  const text = String(message || "").toLowerCase();
  if (level === "error") return true;
  if (level !== "warn") return false;
  return [
    "stream disconnected",
    "retrying sampling request",
    "falling back to http",
    "rate limit",
    "timeout",
    "unauthorized",
    "forbidden",
    "network",
    "failed"
  ].some(pattern => text.includes(pattern));
}

function sanitizeActivityMessage(message) {
  return String(message || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 420);
}

function normalizeThread(thread) {
  if (!thread || typeof thread !== "object") return {};
  const id = thread.id || thread.threadId || thread.sessionId;
  return {
    ...thread,
    id,
    threadId: id,
    title: thread.name || thread.title || thread.preview || "Untitled session",
    lastMessage: thread.preview || thread.lastMessage || "",
    updatedAt: normalizeTimestamp(thread.updatedAt),
    createdAt: normalizeTimestamp(thread.createdAt),
    status: normalizeStatus(thread.status),
    messages: normalizeMessages(thread)
  };
}

function normalizeTimestamp(value) {
  if (typeof value === "number") return new Date(value * 1000).toISOString();
  return value || new Date().toISOString();
}

function normalizeStatus(status) {
  if (typeof status === "string") return status;
  if (status?.type) return status.type;
  return "idle";
}

function normalizeThreadStatus(status) {
  if (typeof status === "string") return status;
  if (status?.type === "active") return "running";
  if (status?.type === "idle") return "idle";
  if (status?.type === "systemError") return "failed";
  return status?.type || "idle";
}

function normalizeTurnStatus(status) {
  if (status === "inProgress") return "running";
  return status || "completed";
}

function normalizeMessages(thread) {
  if (Array.isArray(thread.messages)) return thread.messages;
  if (!Array.isArray(thread.turns)) return [];
  const messages = [];
  for (const turn of thread.turns) {
    for (const item of turn.items || []) {
      const role = item.role || (String(item.type || "").includes("agent") ? "assistant" : "user");
      const content = item.text || item.content || item.message || item.preview;
      if (content) {
        messages.push({
          id: item.id || `${turn.id || "turn"}_${messages.length}`,
          role,
          content,
          createdAt: normalizeTimestamp(turn.startedAt || thread.updatedAt)
        });
      }
    }
  }
  return messages;
}

function messageFromThreadItem(item, completedAtMs) {
  if (!item || typeof item !== "object") return null;
  const createdAt = completedAtMs ? new Date(completedAtMs).toISOString() : new Date().toISOString();
  if (item.type === "agentMessage") {
    return {
      id: item.id || `agent_${completedAtMs || Date.now()}`,
      role: "assistant",
      content: item.text || "",
      createdAt
    };
  }
  if (item.type === "userMessage") {
    return {
      id: item.id || `user_${completedAtMs || Date.now()}`,
      role: "user",
      content: extractContentText(item.content),
      createdAt
    };
  }
  return null;
}

function reasoningContentFromItem(item) {
  if (!item || typeof item !== "object") return "";
  const parts = [];
  if (Array.isArray(item.summary)) {
    parts.push(...item.summary.map(reasoningPartText).filter(Boolean));
  }
  if (Array.isArray(item.content)) {
    for (const part of item.content) {
      if (!part || typeof part !== "object") continue;
      if (["summary_text", "reasoning_summary_text", "reasoning_text", "text"].includes(part.type)) {
        const text = reasoningPartText(part);
        if (text) parts.push(text);
      }
    }
  }
  return uniqueNonEmpty(parts).join("\n\n");
}

function reasoningPartText(part) {
  if (typeof part === "string") return part.trim();
  if (!part || typeof part !== "object") return "";
  return String(part.text || part.summary || "").trim();
}

function readSessionMessages(filePath) {
  const resolved = path.resolve(filePath);
  if (!isSafeSessionPath(resolved)) return [];
  try {
    const stat = fs.statSync(resolved);
    if (stat.size > 30 * 1024 * 1024) {
      return [{
        id: "history_too_large",
        role: "assistant",
        content: "This session history is too large to render in the remote view.",
        createdAt: new Date().toISOString()
      }];
    }
    const messages = [];
    const lines = fs.readFileSync(resolved, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = parseJson(line);
      const message = messageFromJsonlEntry(entry);
      if (message) messages.push(message);
    }
    return messages;
  } catch {
    return [];
  }
}

function isSafeSessionPath(filePath) {
  const resolved = path.resolve(filePath);
  const sessionsRoot = path.join(os.homedir(), ".codex", "sessions");
  const relative = path.relative(sessionsRoot, resolved);
  return !relative.startsWith("..") && !path.isAbsolute(relative) && path.extname(resolved).toLowerCase() === ".jsonl";
}

function messageFromJsonlEntry(entry) {
  if (!entry || entry.type !== "response_item") return null;
  const payload = entry.payload || {};
  if (payload.type !== "message" || !["user", "assistant"].includes(payload.role)) return null;
  const content = extractContentText(payload.content);
  if (!content.trim()) return null;
  return {
    id: payload.id || `history_${entry.timestamp || ""}_${payload.role}_${content.length}`,
    role: payload.role,
    content,
    createdAt: entry.timestamp || new Date().toISOString()
  };
}

function extractContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => {
    if (typeof part === "string") return part;
    return part.text || part.output_text || part.input_text || "";
  }).filter(Boolean).join("\n\n");
}

function messageKey(message) {
  return [
    message.id || "",
    message.role || "",
    normalizeMessageContent(message.content || ""),
    message.createdAt || ""
  ].join("\u0001");
}

function normalizeMessageContent(content) {
  return String(content || "").replace(/\s+/g, " ").trim();
}

function projectFromCwd(cwd) {
  const resolved = path.resolve(cwd);
  if (!fs.existsSync(resolved)) return null;
  const base = path.basename(resolved) || "project";
  return {
    alias: `codex-${slug(base)}-${shortHash(resolved)}`,
    name: base,
    path: resolved,
    pathAlias: base,
    exposePath: false,
    discovered: true
  };
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

function shortHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function maxIso(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return String(right).localeCompare(String(left)) > 0 ? right : left;
}

function mergeThreads(remoteThreads, cachedThreads) {
  const byId = new Map();
  for (const thread of [...cachedThreads, ...remoteThreads]) {
    const id = thread.id || thread.threadId || thread.sessionId;
    if (id) byId.set(id, { ...(byId.get(id) || {}), ...thread, id, threadId: id });
  }
  return [...byId.values()].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

function commandForSpawn(command, args) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", [quoteWindows(command), ...args.map(quoteWindows)].join(" ")]
    };
  }
  return { command, args };
}

function quoteWindows(value) {
  const text = String(value);
  if (!/[\s"&<>|^]/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

module.exports = { CodexAppServerAdapter };
