function getClientIp(req) {
  const forwarded = req?.headers?.["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req?.ip || req?.socket?.remoteAddress || "unknown";
}

function sanitizeValue(value, depth = 0) {
  if (depth > 3) return "[max-depth]";
  if (value == null) return value;
  if (typeof value === "string") {
    if (value.length > 300) return `${value.slice(0, 300)}...[truncated]`;
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const blockedKeys = new Set(["password", "passwordHash", "pin", "token", "authorization"]);
    const output = {};
    Object.entries(value).forEach(([key, item]) => {
      if (blockedKeys.has(String(key))) {
        output[key] = "[redacted]";
        return;
      }
      output[key] = sanitizeValue(item, depth + 1);
    });
    return output;
  }
  return String(value);
}

export function logSecurityEvent(event, req, details = {}) {
  const payload = {
    type: "security",
    ts: new Date().toISOString(),
    event: String(event || "unknown_event"),
    method: req?.method || "-",
    path: req?.originalUrl || req?.url || "-",
    ip: getClientIp(req),
    userAgent: req?.headers?.["user-agent"] || "-",
    details: sanitizeValue(details)
  };
  console.info("[security]", JSON.stringify(payload));
}
