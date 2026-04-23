import dotenv from "dotenv";

dotenv.config();

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value == null || value === "") return fallback;
  return String(value).toLowerCase() === "true";
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNumberInRange(value, fallback, min, max) {
  const parsed = parseNumber(value, fallback);
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

function parseStringList(value) {
  if (value == null || value === "") return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeApiCredential(value) {
  const raw = String(value || "").trim().replace(/^['"]|['"]$/g, "");
  if (!raw) return "";
  const withoutBearer = raw.replace(/^bearer\s+/i, "");
  return withoutBearer.replace(/\s+/g, "");
}

function validateTokenSecret(rawValue) {
  const secret = String(rawValue || "").trim();
  if (secret.length < 32) {
    throw new Error("[startup] APP_TOKEN_SECRET debe tener al menos 32 caracteres y rotarse antes de iniciar.");
  }
  const complexityRules = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/];
  const score = complexityRules.reduce((acc, regex) => acc + (regex.test(secret) ? 1 : 0), 0);
  if (score < 3) {
    throw new Error("[startup] APP_TOKEN_SECRET debe mezclar mayusculas, minusculas, numeros y/o simbolos.");
  }
  const blocked = new Set(["bluesales-dev-secret", "changeme", "change-me", "default-secret"]);
  if (blocked.has(secret.toLowerCase())) {
    throw new Error("[startup] APP_TOKEN_SECRET usa un valor inseguro conocido. Rotar inmediatamente.");
  }
  return secret;
}

function validateAdminPin(rawValue) {
  const pin = String(rawValue || "").trim();
  if (!/^\d{6,}$/.test(pin)) {
    throw new Error("[startup] ADMIN_PIN debe tener al menos 6 digitos numericos.");
  }
  if (/^(\d)\1+$/.test(pin)) {
    throw new Error("[startup] ADMIN_PIN no puede repetir un mismo digito.");
  }
  const blocked = new Set([
    "000000",
    "111111",
    "123456",
    "123123",
    "654321",
    "202620",
    "202601",
    "202600",
    "112233",
    "121212"
  ]);
  if (blocked.has(pin)) {
    throw new Error("[startup] ADMIN_PIN usa una secuencia insegura. Rotar inmediatamente.");
  }
  return pin;
}

function validateSuperAdminUser(rawValue) {
  const user = String(rawValue || "").trim();
  if (!user) return "";
  if (user.length < 3 || user.length > 80) {
    throw new Error("[startup] SUPER_ADMIN_USER invalido. Debe tener entre 3 y 80 caracteres.");
  }
  return user;
}

function validateSuperAdminPassword(rawValue) {
  const password = String(rawValue || "");
  if (!password) return "";
  if (password.length < 8 || password.length > 128) {
    throw new Error("[startup] SUPER_ADMIN_PASSWORD invalido. Debe tener entre 8 y 128 caracteres.");
  }
  return password;
}

const nodeEnv = process.env.NODE_ENV || "development";
const port = parseNumber(process.env.PORT, 3000);
const configuredCorsOrigins = parseStringList(process.env.CORS_ALLOWED_ORIGINS);
const defaultCorsOrigins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
const corsAllowedOrigins = configuredCorsOrigins.length ? configuredCorsOrigins : (nodeEnv === "production" ? [] : defaultCorsOrigins);
const corsAllowNoOrigin = parseBoolean(process.env.CORS_ALLOW_NO_ORIGIN, true);
const superAdminUser = validateSuperAdminUser(process.env.SUPER_ADMIN_USER);
const superAdminPassword = validateSuperAdminPassword(process.env.SUPER_ADMIN_PASSWORD);
const superAdminName = String(process.env.SUPER_ADMIN_NAME || "Super Administrador").trim() || "Super Administrador";
const defaultDniApiTemplate = "https://dniruc.apisperu.com/api/v1/dni/{dni}?token=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6ImNhcmxvc2x1aXMuY3J1Y2VzQGdtYWlsLmNvbSJ9.LDxksKmWK0N9gYuKykJLjv9KcJmWVovf7usyVfH_Hhk";
const dniApiUrlTemplate = nodeEnv === "production"
  ? defaultDniApiTemplate
  : String(process.env.SUNAT_DNI_API_URL_TEMPLATE || "").trim();
const dniApiToken = normalizeApiCredential(process.env.SUNAT_DNI_API_TOKEN);
const dniApiKey = normalizeApiCredential(process.env.SUNAT_DNI_API_KEY);
const dniValidationEnabled = nodeEnv === "production"
  ? true
  : parseBoolean(process.env.SUNAT_DNI_VALIDATION_ENABLED, false);

if (nodeEnv === "production" && corsAllowedOrigins.length === 0) {
  throw new Error("[startup] En produccion debes definir CORS_ALLOWED_ORIGINS con una whitelist explicita.");
}

if (nodeEnv === "production" && corsAllowNoOrigin) {
  throw new Error("[startup] CORS_ALLOW_NO_ORIGIN debe ser false en produccion.");
}

if (nodeEnv === "production" && (!superAdminUser || !superAdminPassword)) {
  throw new Error("[startup] En produccion debes definir SUPER_ADMIN_USER y SUPER_ADMIN_PASSWORD.");
}

export const env = {
  nodeEnv,
  port,
  auth: {
    tokenSecret: validateTokenSecret(process.env.APP_TOKEN_SECRET),
    tokenTtlMs: parseNumber(process.env.APP_TOKEN_TTL_MS, 1000 * 60 * 60 * 12),
    adminUser: String(process.env.ADMIN_USER || "admin").trim() || "admin",
    adminPin: validateAdminPin(process.env.ADMIN_PIN),
    superAdminUser,
    superAdminPassword,
    superAdminName,
    passwordHashRounds: parseNumberInRange(process.env.PASSWORD_HASH_ROUNDS, 12, 8, 14),
    loginRateLimitWindowMs: parseNumber(process.env.AUTH_LOGIN_RATE_LIMIT_WINDOW_MS, 10 * 60 * 1000),
    loginRateLimitMax: parseNumber(process.env.AUTH_LOGIN_RATE_LIMIT_MAX, 6),
    registerRateLimitWindowMs: parseNumber(process.env.AUTH_REGISTER_RATE_LIMIT_WINDOW_MS, 30 * 60 * 1000),
    registerRateLimitMax: parseNumber(process.env.AUTH_REGISTER_RATE_LIMIT_MAX, 5)
  },
  http: {
    bodyLimit: String(process.env.HTTP_BODY_LIMIT || "256kb").trim() || "256kb",
    corsAllowNoOrigin,
    corsAllowedOrigins
  },
  firebase: {
    apiKey: String(process.env.FIREBASE_API_KEY || "").trim(),
    authDomain: String(process.env.FIREBASE_AUTH_DOMAIN || "").trim(),
    projectId: String(process.env.FIREBASE_PROJECT_ID || "").trim(),
    storageBucket: String(process.env.FIREBASE_STORAGE_BUCKET || "").trim(),
    messagingSenderId: String(process.env.FIREBASE_MESSAGING_SENDER_ID || "").trim(),
    appId: String(process.env.FIREBASE_APP_ID || "").trim(),
    measurementId: String(process.env.FIREBASE_MEASUREMENT_ID || "").trim()
  },
  dniValidation: {
    enabled: dniValidationEnabled,
    apiUrlTemplate: dniApiUrlTemplate,
    apiToken: dniApiToken,
    apiAuthScheme: String(process.env.SUNAT_DNI_API_AUTH_SCHEME || "Bearer").trim(),
    apiKey: dniApiKey,
    apiKeyHeader: String(process.env.SUNAT_DNI_API_KEY_HEADER || "x-api-key").trim(),
    timeoutMs: parseNumber(process.env.SUNAT_DNI_TIMEOUT_MS, 8000),
    strictNameMatch: parseBoolean(process.env.SUNAT_DNI_STRICT_NAME_MATCH, true)
  }
};
