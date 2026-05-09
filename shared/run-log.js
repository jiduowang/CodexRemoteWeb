const fs = require("node:fs");
const path = require("node:path");
const util = require("node:util");

let installed = false;

function installRunLogger(component, options = {}) {
  if (installed) return null;
  installed = true;

  const root = options.root || path.resolve(__dirname, "..");
  const dataDir = process.env.CRW_DATA_DIR || path.join(root, ".data");
  const logDir = process.env.CRW_LOG_DIR || path.join(dataDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });

  const safeComponent = sanitizeName(component || "app");
  const logPath = path.join(logDir, `${safeComponent}-${timestampForFile()}-${process.pid}.log`);
  const stream = fs.createWriteStream(logPath, { flags: "a" });
  const originals = {
    debug: console.debug.bind(console),
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };

  const write = (level, args) => {
    const message = util.format(...args);
    stream.write(`${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`);
  };

  for (const level of Object.keys(originals)) {
    console[level] = (...args) => {
      originals[level](...args);
      write(level, args);
    };
  }

  const close = () => {
    try {
      stream.end();
    } catch {
      // Logging must never block process shutdown.
    }
  };

  process.on("beforeExit", close);
  process.on("uncaughtException", error => {
    write("error", ["uncaughtException:", error?.stack || error]);
    try {
      stream.end(() => process.exit(1));
    } catch {
      process.exit(1);
    }
    setTimeout(() => process.exit(1), 1000).unref();
  });
  process.on("unhandledRejection", reason => {
    write("error", ["unhandledRejection:", reason?.stack || reason]);
  });

  console.log(`${safeComponent} run log: ${logPath}`);
  console.log(`${safeComponent} pid=${process.pid} node=${process.version} cwd=${process.cwd()}`);
  return { logPath, logDir };
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sanitizeName(value) {
  return String(value || "app").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "app";
}

module.exports = { installRunLogger };
