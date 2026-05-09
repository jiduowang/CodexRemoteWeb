const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

class MockCodexAdapter {
  constructor(config = {}) {
    this.baseDir = config.dataDir || process.env.CRW_BRIDGE_DATA_DIR || path.join(path.dirname(config.configPath || os.homedir()), "threads");
    this.activeTurns = new Map();
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  async listThreads(project) {
    const store = this.#read(project);
    return {
      threads: store.threads
        .map(thread => summarizeThread(thread))
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    };
  }

  async readThread(project, threadId) {
    const store = this.#read(project);
    const thread = store.threads.find(item => item.id === threadId);
    if (!thread) throw new Error("Thread not found");
    return { thread: normalizeThread(thread) };
  }

  async createThread(project, { title, initialMessage } = {}) {
    const store = this.#read(project);
    const now = new Date().toISOString();
    const thread = {
      id: `thread_${crypto.randomBytes(10).toString("base64url")}`,
      title: title || "New remote session",
      status: "idle",
      createdAt: now,
      updatedAt: now,
      messages: []
    };
    if (initialMessage) {
      thread.messages.push(message("user", initialMessage));
      thread.updatedAt = new Date().toISOString();
    }
    store.threads.push(thread);
    this.#write(project, store);
    return { thread: normalizeThread(thread) };
  }

  async sendMessage(project, { threadId, message: content, context }, emit) {
    const turnKey = `${project.alias}:${threadId}`;
    const controller = { cancelled: false };
    this.activeTurns.set(turnKey, controller);

    const store = this.#read(project);
    const thread = store.threads.find(item => item.id === threadId);
    if (!thread) throw new Error("Thread not found");

    const userMessage = message("user", content);
    thread.status = "running";
    thread.updatedAt = new Date().toISOString();
    thread.messages.push(userMessage);
    this.#write(project, store);

    emit({ kind: "thread.message", message: userMessage });
    emit({ kind: "turn.status", status: "running" });

    const response = [
      "Mock Codex is connected through the remote Bridge.",
      context ? "I received the additional context block." : "No extra context block was attached.",
      "Switch the Bridge config adapter to codex-app-server after verifying your local Codex app-server command."
    ].join(" ");

    let rendered = "";
    for (const part of response.match(/.{1,36}(\s|$)/g) || [response]) {
      if (controller.cancelled) {
        thread.status = "interrupted";
        thread.updatedAt = new Date().toISOString();
        this.#write(project, store);
        emit({ kind: "turn.status", status: "interrupted" });
        return;
      }
      rendered += part;
      emit({ kind: "assistant.delta", content: part });
      await delay(120);
    }

    const assistantMessage = message("assistant", rendered.trim());
    thread.messages.push(assistantMessage);
    thread.status = "idle";
    thread.updatedAt = new Date().toISOString();
    this.#write(project, store);
    this.activeTurns.delete(turnKey);

    emit({ kind: "thread.message", message: assistantMessage });
    emit({ kind: "turn.status", status: "completed" });
  }

  async interrupt(project, threadId) {
    const turnKey = `${project.alias}:${threadId}`;
    const controller = this.activeTurns.get(turnKey);
    if (controller) controller.cancelled = true;
    return { ok: true };
  }

  #read(project) {
    const file = this.#file(project);
    if (!fs.existsSync(file)) return { threads: [] };
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }

  #write(project, store) {
    fs.writeFileSync(this.#file(project), JSON.stringify(store, null, 2), "utf8");
  }

  #file(project) {
    const key = crypto.createHash("sha256").update(project.path).digest("hex").slice(0, 24);
    return path.join(this.baseDir, `${project.alias}-${key}.json`);
  }
}

function summarizeThread(thread) {
  const last = thread.messages[thread.messages.length - 1];
  return {
    threadId: thread.id,
    title: thread.title,
    status: thread.status || "idle",
    lastMessage: last?.content || "",
    updatedAt: thread.updatedAt,
    createdAt: thread.createdAt
  };
}

function normalizeThread(thread) {
  return {
    ...summarizeThread(thread),
    messages: thread.messages || []
  };
}

function message(role, content) {
  return {
    id: `msg_${crypto.randomBytes(10).toString("base64url")}`,
    role,
    content: String(content || ""),
    createdAt: new Date().toISOString()
  };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { MockCodexAdapter };
