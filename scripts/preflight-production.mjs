import "dotenv/config";

function resultLine(type, message) {
  const prefix = type === "ok" ? "[ok]" : type === "warn" ? "[warn]" : "[error]";
  console.log(`${prefix} ${message}`);
}

async function run() {
  if (process.env.NODE_ENV !== "production") {
    throw new Error("Preflight productivo requiere NODE_ENV=production.");
  }

  const { env } = await import("../src/config/env.js");
  const { isFirebaseConfigured } = await import("../src/config/firebase.js");

  const errors = [];
  const warnings = [];

  if (!isFirebaseConfigured) {
    errors.push("Firebase/Firestore no configurado.");
  }

  if (env.http.corsAllowNoOrigin) {
    errors.push("CORS_ALLOW_NO_ORIGIN debe ser false en produccion.");
  }

  if (!Array.isArray(env.http.corsAllowedOrigins) || env.http.corsAllowedOrigins.length === 0) {
    errors.push("CORS_ALLOWED_ORIGINS debe contener al menos un origen explicito.");
  }

  const localhostOrigins = env.http.corsAllowedOrigins.filter(
    (origin) =>
      String(origin).includes("localhost") ||
      String(origin).includes("127.0.0.1")
  );
  if (localhostOrigins.length) {
    warnings.push(`CORS incluye origenes locales: ${localhostOrigins.join(", ")}`);
  }

  if (env.auth.passwordHashRounds < 12) {
    errors.push("PASSWORD_HASH_ROUNDS debe ser >= 12 en produccion.");
  }

  if (env.auth.tokenTtlMs > 1000 * 60 * 60 * 24) {
    warnings.push("APP_TOKEN_TTL_MS supera 24h. Recomendado <= 12h.");
  }

  const dangerousFlags = [
    "ALLOW_PROD_MIGRATION",
    "ALLOW_PROD_SEED",
    "ALLOW_PROD_AUDIT",
    "ALLOW_PROD_PROXY_CLEAN"
  ];
  const activeFlags = dangerousFlags.filter((name) => process.env[name] === "true");
  if (activeFlags.length) {
    warnings.push(`Flags de ejecucion sensible activos: ${activeFlags.join(", ")}`);
  }

  if (String(env.auth.adminUser || "").trim().toLowerCase() === "admin") {
    warnings.push("ADMIN_USER usa valor generico 'admin'. Recomendado usar un usuario no predecible.");
  }

  resultLine("ok", `NODE_ENV=${env.nodeEnv}`);
  resultLine("ok", `PORT=${env.port}`);
  resultLine("ok", `CORS_ALLOWED_ORIGINS=${env.http.corsAllowedOrigins.length}`);
  resultLine("ok", `AUTH_LOGIN_RATE_LIMIT_MAX=${env.auth.loginRateLimitMax}`);
  resultLine("ok", `AUTH_REGISTER_RATE_LIMIT_MAX=${env.auth.registerRateLimitMax}`);
  resultLine("ok", `PASSWORD_HASH_ROUNDS=${env.auth.passwordHashRounds}`);

  warnings.forEach((line) => resultLine("warn", line));
  errors.forEach((line) => resultLine("error", line));

  if (errors.length) {
    throw new Error(`Preflight productivo fallido con ${errors.length} error(es).`);
  }

  console.log(`[preflight] listo con ${warnings.length} warning(s).`);
}

run().catch((error) => {
  console.error("[preflight:prod] failed:", {
    message: error?.message || "unknown_error",
    name: error?.name || "Error",
    code: error?.code || null
  });
  process.exitCode = 1;
});
