const fs = require("node:fs");
const path = require("node:path");

class JsonStore {
  constructor(filePath, defaults) {
    this.filePath = filePath;
    this.defaults = defaults;
    this.data = structuredClone(defaults);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.load();
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      this.save();
      return;
    }

    const raw = fs.readFileSync(this.filePath, "utf8");
    if (!raw.trim()) {
      this.data = structuredClone(this.defaults);
      this.save();
      return;
    }

    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    this.data = mergeDefaults(parsed, this.defaults);
  }

  save() {
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    fs.renameSync(tmp, this.filePath);
  }

  update(mutator) {
    const result = mutator(this.data);
    this.save();
    return result;
  }
}

function mergeDefaults(value, defaults) {
  if (Array.isArray(defaults)) return Array.isArray(value) ? value : structuredClone(defaults);
  if (!defaults || typeof defaults !== "object") return value ?? defaults;

  const merged = { ...structuredClone(defaults), ...(value && typeof value === "object" ? value : {}) };
  for (const key of Object.keys(defaults)) {
    merged[key] = mergeDefaults(merged[key], defaults[key]);
  }
  return merged;
}

module.exports = { JsonStore };
