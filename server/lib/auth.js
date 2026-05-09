const crypto = require("node:crypto");

function randomId(prefix = "id") {
  return `${prefix}_${crypto.randomBytes(18).toString("base64url")}`;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const hash = crypto.scryptSync(password, salt, 64).toString("base64url");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, encoded) {
  const [scheme, salt, expectedHash] = String(encoded || "").split("$");
  if (scheme !== "scrypt" || !salt || !expectedHash) return false;
  const actual = crypto.scryptSync(password, salt, 64).toString("base64url");
  return safeEqual(actual, expectedHash);
}

function signSessionId(sessionId, secret) {
  const signature = crypto.createHmac("sha256", secret).update(sessionId).digest("base64url");
  return `${sessionId}.${signature}`;
}

function verifySessionCookie(cookieValue, secret) {
  const [sessionId, signature] = String(cookieValue || "").split(".");
  if (!sessionId || !signature) return null;
  const expected = crypto.createHmac("sha256", secret).update(sessionId).digest("base64url");
  return safeEqual(signature, expected) ? sessionId : null;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function cookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge != null) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.secure) parts.push("Secure");
  parts.push(`Path=${options.path || "/"}`);
  return parts.join("; ");
}

module.exports = {
  cookie,
  hashPassword,
  parseCookies,
  randomId,
  signSessionId,
  verifyPassword,
  verifySessionCookie
};
