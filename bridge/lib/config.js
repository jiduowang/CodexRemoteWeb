const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function loadConfig() {
  const explicit = process.env.CRW_BRIDGE_CONFIG;
  const candidates = [
    explicit,
    path.join(os.homedir(), ".codex-remote-bridge.json"),
    path.resolve(__dirname, "..", "config.json")
  ].filter(Boolean);

  const configPath = candidates.find(item => fs.existsSync(item));
  if (!configPath) {
    throw new Error(`Bridge config not found. Copy bridge/config.example.json to ${path.join(os.homedir(), ".codex-remote-bridge.json")}`);
  }

  const config = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
  config.configPath = configPath;
  config.bridgeId = config.bridgeId || os.hostname().toLowerCase();
  config.name = config.name || os.hostname();
  config.serverUrl = process.env.CRW_SERVER_URL || config.serverUrl;
  config.token = process.env.CRW_BRIDGE_TOKEN || config.token;
  config.adapter = config.adapter || "mock";
  if (config.dataDir) config.dataDir = path.resolve(expandEnv(config.dataDir));
  config.reconnectMs = Number(config.reconnectMs || 3000);
  config.projects = Array.isArray(config.projects) ? config.projects : [];
  config.denylist = Array.isArray(config.denylist) ? config.denylist : defaultDenylist();

  if (!config.serverUrl) throw new Error("Bridge config requires serverUrl.");
  if (!config.token) throw new Error("Bridge config requires token.");
  if (config.projects.length === 0) throw new Error("Bridge config requires at least one allowlisted project.");

  const aliases = new Set();
  config.projects = config.projects.map(project => {
    if (!project.alias || !/^[a-zA-Z0-9._-]+$/.test(project.alias)) {
      throw new Error(`Invalid project alias: ${project.alias}`);
    }
    if (aliases.has(project.alias)) throw new Error(`Duplicate project alias: ${project.alias}`);
    aliases.add(project.alias);
    const projectPath = path.resolve(expandEnv(project.path));
    if (!fs.existsSync(projectPath)) throw new Error(`Project path does not exist: ${projectPath}`);
    return {
      ...project,
      path: projectPath,
      name: project.name || project.alias,
      exposePath: Boolean(project.exposePath)
    };
  });

  return config;
}

function defaultDenylist() {
  return [".env", ".env.*", "*.pem", "*.key", "*id_rsa*", "*secret*"];
}

function publicProject(project, gitSummary = {}) {
  return {
    alias: project.alias,
    name: project.name || project.alias,
    pathAlias: project.exposePath ? project.path : project.alias,
    branch: gitSummary.branch || "unknown",
    dirty: Boolean(gitSummary.dirty),
    changedFiles: Number(gitSummary.changedFiles || 0),
    lastThreadAt: project.lastThreadAt || gitSummary.lastThreadAt || null,
    discovered: Boolean(project.discovered)
  };
}

function expandEnv(value) {
  return String(value || "").replace(/%([^%]+)%/g, (_, name) => process.env[name] || `%${name}%`);
}

module.exports = { loadConfig, publicProject };
