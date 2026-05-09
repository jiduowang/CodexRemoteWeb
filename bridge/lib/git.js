const { execFile } = require("node:child_process");
const path = require("node:path");

function execGit(projectPath, args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", projectPath, ...args], { timeout, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

async function getSummary(project) {
  try {
    const status = await execGit(project.path, ["status", "--porcelain=v1", "-b"]);
    const lines = status.split(/\r?\n/).filter(Boolean);
    const branchLine = lines[0] || "## unknown";
    const branch = branchLine.replace(/^##\s*/, "").split("...")[0].trim() || "unknown";
    return {
      branch,
      dirty: lines.length > 1,
      changedFiles: Math.max(0, lines.length - 1)
    };
  } catch {
    return { branch: "not-a-git-repo", dirty: false, changedFiles: 0 };
  }
}

async function getChangedFiles(project) {
  const status = await execGit(project.path, ["status", "--porcelain=v1", "-uall"]);
  return status.split(/\r?\n/).filter(Boolean).map(line => {
    const code = line.slice(0, 2);
    const raw = line.slice(3);
    const file = raw.includes(" -> ") ? raw.split(" -> ").pop() : raw;
    return { code, file };
  });
}

async function getDiff(project, denylist = []) {
  let changed;
  try {
    changed = await getChangedFiles(project);
  } catch (error) {
    return {
      files: [],
      diff: `[git diff unavailable: ${error.stderr?.trim() || error.message}]\n`,
      error: error.message,
      generatedAt: new Date().toISOString()
    };
  }
  const files = [];
  const chunks = [];

  for (const item of changed) {
    const sensitive = isSensitivePath(item.file, denylist);
    files.push({ ...item, sensitive });
    chunks.push(`diff --codex-remote ${item.file}\n`);
    if (sensitive) {
      chunks.push("[redacted by bridge denylist]\n\n");
      continue;
    }

    if (item.code.includes("?")) {
      chunks.push("[untracked file: content is not included in v1]\n\n");
      continue;
    }

    try {
      const diff = await execGit(project.path, ["diff", "--no-ext-diff", "--unified=3", "--", item.file]);
      const staged = await execGit(project.path, ["diff", "--cached", "--no-ext-diff", "--unified=3", "--", item.file]);
      chunks.push(diff || staged || "[no textual diff]\n");
      if (!chunks[chunks.length - 1].endsWith("\n")) chunks.push("\n");
      chunks.push("\n");
    } catch (error) {
      chunks.push(`[diff unavailable: ${error.message}]\n\n`);
    }
  }

  return {
    files,
    diff: chunks.join(""),
    generatedAt: new Date().toISOString()
  };
}

function assertInsideProject(project, candidate) {
  const resolved = path.resolve(project.path, candidate);
  const relative = path.relative(project.path, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path is outside the allowlisted project.");
  }
  return resolved;
}

function isSensitivePath(filePath, patterns = []) {
  const normalized = String(filePath || "").replace(/\\/g, "/").toLowerCase();
  return patterns.some(pattern => globToRegex(pattern).test(normalized) || globToRegex(`**/${pattern}`).test(normalized));
}

function globToRegex(pattern) {
  const escaped = String(pattern)
    .replace(/\\/g, "/")
    .toLowerCase()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__DOUBLE_STAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__DOUBLE_STAR__/g, ".*");
  return new RegExp(`^${escaped}$`);
}

module.exports = {
  assertInsideProject,
  getChangedFiles,
  getDiff,
  getSummary,
  isSensitivePath
};
