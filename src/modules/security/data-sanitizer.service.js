const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const CONTROL_CHARS_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function sanitizeString(value) {
  return String(value || "").replace(CONTROL_CHARS_REGEX, "").trim();
}

function isPlainObject(value) {
  if (!value || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeInternal(value, depth, maxDepth) {
  if (depth > maxDepth) return null;
  if (value == null) return value;

  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeInternal(item, depth + 1, maxDepth));
  }

  if (isPlainObject(value)) {
    const output = {};
    Object.entries(value).forEach(([key, item]) => {
      if (BLOCKED_KEYS.has(key)) return;
      output[key] = sanitizeInternal(item, depth + 1, maxDepth);
    });
    return output;
  }

  return null;
}

export function sanitizeUnknown(value, options = {}) {
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 30;
  return sanitizeInternal(value, 0, maxDepth);
}
