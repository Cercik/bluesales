import "dotenv/config";

const PRODUCTION_AUDIT_ALLOWED = process.env.ALLOW_PROD_AUDIT === "true";

if (process.env.NODE_ENV === "production" && !PRODUCTION_AUDIT_ALLOWED) {
  throw new Error("Auditoria bloqueada. Define ALLOW_PROD_AUDIT=true para ejecutar en produccion.");
}

function classifyWorker(worker, isBcryptHash) {
  const id = String(worker?.id || "").trim() || "(sin-id)";
  const hasLegacyPassword = Object.prototype.hasOwnProperty.call(worker || {}, "password");
  const passwordHash = String(worker?.passwordHash || "").trim();
  const hasHash = Boolean(passwordHash);
  const hashValid = hasHash && isBcryptHash(passwordHash);

  if (!hasHash && hasLegacyPassword) return { id, status: "legacy_plain_password" };
  if (!hasHash) return { id, status: "missing_password_hash" };
  if (!hashValid) return { id, status: "invalid_password_hash_format" };
  if (hasLegacyPassword) return { id, status: "hash_ok_but_legacy_field_present" };
  return { id, status: "ok" };
}

async function run() {
  const { isBcryptHash } = await import("../src/modules/auth/password.service.js");
  const { ensureSchema, getState } = await import("../src/modules/state/state.repository.js");

  await ensureSchema();
  const state = await getState();
  const users = Array.isArray(state?.users) ? state.users : [];

  const rows = users.map((worker) => classifyWorker(worker, isBcryptHash));
  const findings = rows.filter((row) => row.status !== "ok");

  const byStatus = findings.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});

  console.log("[audit:passwords] users total:", users.length);
  if (!findings.length) {
    console.log("[audit:passwords] OK: no se detectaron usuarios legacy o hashes invalidos.");
    return;
  }

  console.log("[audit:passwords] hallazgos:", findings.length);
  Object.entries(byStatus).forEach(([status, count]) => {
    console.log(`- ${status}: ${count}`);
  });

  console.log("[audit:passwords] detalle:");
  findings.forEach((row) => {
    console.log(`- ${row.id}: ${row.status}`);
  });

  process.exitCode = 1;
}

run().catch((error) => {
  console.error("[audit:passwords] failed:", {
    message: error?.message || "unknown_error",
    name: error?.name || "Error",
    code: error?.code || null
  });
  process.exitCode = 1;
});
