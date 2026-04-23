import cors from "cors";
import express from "express";
import helmet from "helmet";
import path from "node:path";
import { legacyCreateUserBodySchema } from "./api/validation/request-schemas.js";
import { parseBody } from "./api/validation/request-validator.js";
import { env } from "./config/env.js";
import apiRouter from "./api/routes/api-router.js";
import { hashPassword } from "./modules/auth/password.service.js";
import { isSessionRevoked } from "./modules/auth/session-revocation.service.js";
import { logSecurityEvent } from "./modules/security/security-log.service.js";
import { readBearerToken, verifyToken } from "./modules/auth/token.service.js";
import { ensureSchema, getState, persistState } from "./modules/state/state.repository.js";

const CORS_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const CORS_ALLOWED_HEADERS = ["Content-Type", "Authorization"];

function buildApiCorsOptions(req, callback) {
  const allowedOrigins = new Set(env.http.corsAllowedOrigins);
  const requestMethod = String(req?.method || "GET").toUpperCase();
  const isReadOnlyMethod = requestMethod === "GET" || requestMethod === "HEAD" || requestMethod === "OPTIONS";
  const allowNoOrigin = env.http.corsAllowNoOrigin || isReadOnlyMethod;

  callback(null, {
    origin(origin, originCallback) {
      if (!origin) {
        if (allowNoOrigin) return originCallback(null, true);
        return originCallback(new Error("CORS policy: origin requerido."));
      }
      if (allowedOrigins.has(origin)) return originCallback(null, true);
      return originCallback(new Error("CORS policy: origin no permitido."));
    },
    methods: CORS_METHODS,
    allowedHeaders: CORS_ALLOWED_HEADERS,
    maxAge: 60 * 60
  });
}

function isPrivilegedAdminRole(role) {
  return role === "admin" || role === "super_admin";
}

async function requireAdminToken(req, res, next) {
  try {
    const token = readBearerToken(req);
    const profile = verifyToken(token);
    if (!profile) {
      logSecurityEvent("session_invalid", req, { context: "legacy_admin_route" });
      return res.status(401).json({ message: "Sesion invalida o expirada." });
    }
    if (await isSessionRevoked(profile)) {
      logSecurityEvent("session_revoked", req, { context: "legacy_admin_route", sid: profile.sid, role: profile.role, id: profile.id });
      return res.status(401).json({ message: "Sesion revocada." });
    }
    if (!isPrivilegedAdminRole(profile.role)) {
      logSecurityEvent("authorization_denied", req, { context: "legacy_admin_route", role: profile.role });
      return res.status(403).json({ message: "Solo administradores." });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

function stripUserCredentials(worker) {
  const safeWorker = worker && typeof worker === "object" ? { ...worker } : {};
  delete safeWorker.password;
  delete safeWorker.passwordHash;
  return safeWorker;
}

export async function createApp() {
  const app = express();
  const publicDir = path.join(process.cwd(), "public");
  const legacyImagesDir = path.join(process.cwd(), "Imagenes");

  app.disable("x-powered-by");
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" }
    })
  );
  app.use("/api", cors(buildApiCorsOptions));
  app.use(express.json({ limit: env.http.bodyLimit }));
  app.use((req, res, next) => {
    res.on("finish", () => {
      if ([401, 403, 429].includes(res.statusCode)) {
        logSecurityEvent("http_denied_response", req, { statusCode: res.statusCode });
      }
    });
    next();
  });
  app.use(express.static(publicDir));

  // Backward compatibility for existing frontend references.
  app.use("/Imagenes", express.static(legacyImagesDir));
  app.use("/imagenes", express.static(path.join(publicDir, "assets", "images")));

  await ensureSchema();

  app.get("/", (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });

  app.get("/api", (_req, res) => {
    res.send("API BlueSales running");
  });

  app.use("/api", apiRouter);

  app.get("/users", requireAdminToken, async (_req, res) => {
    try {
      const state = await getState();
      res.json((state.users || []).map((worker) => stripUserCredentials(worker)));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/users", requireAdminToken, async (req, res) => {
    try {
      const input = parseBody(legacyCreateUserBodySchema, req, res);
      if (!input) {
        logSecurityEvent("request_validation_failed", req, { endpoint: "/users" });
        return;
      }
      const { id, dni, name, email, password, password_hash } = input;
      const state = await getState();
      const users = Array.isArray(state.users) ? state.users : [];
      const nextId = String(id || dni || "").trim();
      const nextEmail = String(email || "").trim();
      const plainPassword = String(password || password_hash || "");

      if (users.some((u) => u.id === nextId || u.email === nextEmail)) {
        logSecurityEvent("legacy_user_create_conflict", req, { userId: nextId, email: nextEmail });
        return res.status(409).json({ error: "Usuario ya existe." });
      }

      const passwordHash = await hashPassword(plainPassword);
      users.push({
        id: nextId,
        name: String(name || ""),
        phone: "",
        email: nextEmail,
        passwordHash,
        active: true,
        createdAt: new Date().toISOString()
      });

      await persistState({ ...state, users });
      logSecurityEvent("legacy_user_created", req, { userId: nextId, email: nextEmail });
      return res.json({ message: "Usuario creado" });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get("/orders", requireAdminToken, async (_req, res) => {
    try {
      const state = await getState();
      res.json(state.orders || []);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.use((error, _req, res, _next) => {
    if (String(error?.message || "").toLowerCase().includes("cors policy")) {
      return res.status(403).json({ message: "Origen bloqueado por politica CORS." });
    }
    const statusCode = Number(error?.statusCode || 0);
    if (Number.isFinite(statusCode) && statusCode >= 400 && statusCode < 500) {
      return res.status(statusCode).json({ message: error?.message || "Solicitud invalida." });
    }
    console.error("[api:error]", {
      message: error?.message,
      name: error?.name,
      code: error?.code || null
    });
    res.status(500).json({ message: "Internal server error." });
  });

  return { app };
}
