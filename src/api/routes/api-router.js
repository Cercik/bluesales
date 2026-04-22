import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  adminUserCreateBodySchema,
  authRevokeBodySchema,
  dniLookupParamsSchema,
  dniLookupQuerySchema,
  exportOrdersTemplateBodySchema,
  loginBodySchema,
  registerBodySchema,
  stateUpdateBodySchema,
  workerCreateOrderBodySchema,
  workerOrderParamsSchema
} from "../validation/request-schemas.js";
import { parseBody, parseInput } from "../validation/request-validator.js";
import { env } from "../../config/env.js";
import { isFirebaseConfigured } from "../../config/firebase.js";
import {
  authenticateAdminCredentials,
  createAdminUserBySuperAdmin,
  listAdminUsersForActor
} from "../../modules/auth/admin-users.service.js";
import { hashPassword, migrateWorkerPassword, verifyWorkerPassword } from "../../modules/auth/password.service.js";
import { isSessionRevoked, revokePrincipalSessions, revokeSession } from "../../modules/auth/session-revocation.service.js";
import { logSecurityEvent } from "../../modules/security/security-log.service.js";
import { sanitizeUnknown } from "../../modules/security/data-sanitizer.service.js";
import { createToken, readBearerToken, verifyToken } from "../../modules/auth/token.service.js";
import { lookupDniIdentity, validateWorkerIdentity } from "../../modules/identity/dni-validation.service.js";
import { buildOrdersTemplateWorkbook } from "../../modules/reports/orders-template-export.service.js";
import { buildDefaultState } from "../../modules/state/default-state.factory.js";
import { getState, persistState } from "../../modules/state/state.repository.js";

const router = Router();
let memoryState = null;
const STATE_ENDPOINT_TRANSITION_NOTICE =
  "Endpoint /api/state en transicion. Migrar gradualmente a endpoints especificos por recurso.";
const STATE_ENDPOINT_SUNSET = "Wed, 31 Dec 2026 23:59:59 GMT";

async function safeGetState() {
  try {
    const data = await getState();
    const migrated = await migrateStateUserPasswordsIfRequired(data);
    memoryState = migrated;
    return migrated;
  } catch (error) {
    if (env.nodeEnv === "production") throw error;
    if (!memoryState) memoryState = buildDefaultState();
    const migrated = await migrateStateUserPasswordsIfRequired(memoryState);
    memoryState = migrated;
    return migrated;
  }
}

function markStateEndpointAsTransition(res) {
  res.setHeader("Deprecation", "true");
  res.setHeader("Sunset", STATE_ENDPOINT_SUNSET);
  res.setHeader("Warning", `299 - "${STATE_ENDPOINT_TRANSITION_NOTICE}"`);
  res.setHeader("X-API-Transition", "state-endpoint");
}

async function safePersistState(data) {
  if (!isFirebaseConfigured && env.nodeEnv === "production") {
    throw new Error("[state] Persistencia en memoria bloqueada en produccion.");
  }
  memoryState = data;
  if (!isFirebaseConfigured) return false;
  try {
    await persistState(data);
    return true;
  } catch (error) {
    if (env.nodeEnv === "production") throw error;
    // Keep in-memory fallback when Firestore is not available.
    return false;
  }
}

async function migrateStateUserPasswordsIfRequired(data) {
  const users = Array.isArray(data?.users) ? data.users : [];
  if (!users.length) return data;

  let changed = false;
  const migratedUsers = await Promise.all(
    users.map(async (worker) => {
      const migrated = await migrateWorkerPassword(worker);
      if (migrated.changed) changed = true;
      return migrated.worker;
    })
  );

  if (!changed) return data;

  const nextData = {
    ...data,
    users: migratedUsers
  };
  await safePersistState(nextData);
  return nextData;
}

function stripUserCredentials(worker) {
  const safeWorker = worker && typeof worker === "object" ? { ...worker } : {};
  delete safeWorker.password;
  delete safeWorker.passwordHash;
  return safeWorker;
}

function sanitizeStateForResponse(data, profile) {
  const safeUsers = (Array.isArray(data?.users) ? data.users : []).map((worker) => stripUserCredentials(worker));
  if (profile?.role !== "worker") {
    return {
      ...data,
      users: safeUsers
    };
  }

  const workerId = String(profile?.id || "");
  const ownUser = safeUsers.filter((user) => String(user?.id || "") === workerId);
  const ownOrders = (Array.isArray(data?.orders) ? data.orders : []).filter((order) => String(order?.workerId || "") === workerId);
  const ownHistory = (Array.isArray(data?.orderHistory) ? data.orderHistory : []).filter((item) => {
    const historyWorkerId = String(item?.workerId || "");
    const actor = String(item?.actor || "");
    return historyWorkerId === workerId || actor === workerId;
  });

  return {
    ...data,
    users: ownUser,
    orders: ownOrders,
    notifications: [],
    orderHistory: ownHistory,
    noticeReads: {
      [workerId]: Array.isArray(data?.noticeReads?.[workerId]) ? data.noticeReads[workerId] : []
    }
  };
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function toLocalDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getCycleRange(reference) {
  const d = new Date(reference);
  d.setHours(0, 0, 0, 0);
  let diff = d.getDay() - 3;
  if (diff < 0) diff += 7;
  const start = new Date(d);
  start.setDate(d.getDate() - diff);
  const end = new Date(start);
  end.setDate(start.getDate() + 5);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function getCycleKey(reference = new Date()) {
  const { start } = getCycleRange(reference);
  return toLocalDateKey(start);
}

function getCycleDateFromKey(cycleKey) {
  if (!cycleKey || !/^\d{4}-\d{2}-\d{2}$/.test(cycleKey)) return null;
  const date = new Date(`${cycleKey}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(0, 0, 0, 0);
  return date;
}

function getOrderCycleKey(order) {
  if (order?.cycleKey && /^\d{4}-\d{2}-\d{2}$/.test(String(order.cycleKey))) return order.cycleKey;
  return getCycleKey(new Date(order?.createdAt || new Date()));
}

function getWeeklyPriceEntry(settings, cycleKey) {
  const weeklyPrices = settings?.weeklyPrices && typeof settings.weeklyPrices === "object" ? settings.weeklyPrices : {};
  const row = weeklyPrices[cycleKey];
  if (!row || typeof row !== "object") return { pricePerKg: 0, published: false };
  return row;
}

function getPricePerKg(settings, cycleKey) {
  return toNumber(getWeeklyPriceEntry(settings, cycleKey).pricePerKg);
}

function isPricePublished(settings, cycleKey) {
  const row = getWeeklyPriceEntry(settings, cycleKey);
  return Boolean(row.published) && getPricePerKg(settings, cycleKey) > 0;
}

function getDeliveryFridayForCycleKey(cycleKey) {
  const start = getCycleDateFromKey(cycleKey);
  if (!start) return new Date().toISOString();
  const delivery = new Date(start);
  delivery.setDate(start.getDate() + 9);
  delivery.setHours(0, 0, 0, 0);
  return delivery.toISOString();
}

function getPendingConfirmDeadline(order) {
  const cycleKey = getOrderCycleKey(order);
  const range = getCycleRange(getCycleDateFromKey(cycleKey) || new Date());
  const deadline = new Date(range.end);
  deadline.setHours(23, 59, 59, 999);
  return deadline;
}

function isBeforePendingDeadline(order, now = new Date()) {
  return now < getPendingConfirmDeadline(order);
}

function isOrderWindowOpen(now = new Date()) {
  const { start, end } = getCycleRange(now);
  return now >= start && now <= end;
}

function getWorkerWeeklyKg(orders, workerId, now = new Date()) {
  const { start, end } = getCycleRange(now);
  return (Array.isArray(orders) ? orders : [])
    .filter((order) => String(order?.workerId || "") === String(workerId || ""))
    .filter((order) => String(order?.status || "") !== "cancelled")
    .filter((order) => {
      const timestamp = new Date(order?.createdAt || 0);
      return timestamp >= start && timestamp <= end;
    })
    .reduce((sum, order) => sum + toNumber(order?.kg), 0);
}

function applyTemplate(template, order) {
  return String(template || "")
    .replaceAll("{{orderId}}", String(order?.id || "-"))
    .replaceAll("{{status}}", String(order?.status || "-"))
    .replaceAll("{{deliveryDate}}", String(order?.deliveryDate || "-"));
}

function addOrderHistoryEntry(state, order, action, detail, actor) {
  if (!Array.isArray(state.orderHistory)) state.orderHistory = [];
  state.orderHistory.unshift({
    id: uid("hist"),
    orderId: String(order?.id || "-"),
    workerId: String(order?.workerId || ""),
    workerName: String(order?.workerName || ""),
    action: String(action || "updated"),
    detail: String(detail || ""),
    actor: String(actor || "system"),
    createdAt: new Date().toISOString()
  });
  if (state.orderHistory.length > 1000) {
    state.orderHistory = state.orderHistory.slice(0, 1000);
  }
}

function addOrderNotifications(state, order) {
  if (!Array.isArray(state.notifications)) state.notifications = [];
  const templates = state?.settings?.notificationTemplates || {};
  const whatsappTemplate = templates.whatsapp || "BlueSales: tu pedido {{orderId}} ahora esta en estado {{status}}.";
  const emailTemplate = templates.email || "BlueSales: tu pedido {{orderId}} ahora esta en estado {{status}}.";

  if (order?.workerPhone) {
    state.notifications.unshift({
      id: uid("ntf"),
      workerId: String(order.workerId || ""),
      workerName: String(order.workerName || ""),
      channel: "WhatsApp",
      target: String(order.workerPhone || ""),
      message: applyTemplate(whatsappTemplate, order),
      sent: false,
      createdAt: new Date().toISOString()
    });
  }
  if (order?.workerEmail) {
    state.notifications.unshift({
      id: uid("ntf"),
      workerId: String(order.workerId || ""),
      workerName: String(order.workerName || ""),
      channel: "Correo",
      target: String(order.workerEmail || ""),
      message: applyTemplate(emailTemplate, order),
      sent: false,
      createdAt: new Date().toISOString()
    });
  }
}

async function mergeUsersWithCredentials(nextUsers, currentUsers) {
  const currentById = new Map(
    (Array.isArray(currentUsers) ? currentUsers : []).map((worker) => [String(worker?.id || ""), worker])
  );

  const inputUsers = Array.isArray(nextUsers) ? nextUsers : [];
  return Promise.all(
    inputUsers.map(async (row) => {
      const incoming = row && typeof row === "object" ? { ...row } : {};
      const workerId = String(incoming.id || "");
      const existing = currentById.get(workerId);
      const plainPassword = String(incoming.password || "").trim();

      const candidate = {
        ...(existing && typeof existing === "object" ? existing : {}),
        ...incoming
      };

      if (plainPassword) {
        candidate.password = plainPassword;
        delete candidate.passwordHash;
      }

      const migrated = await migrateWorkerPassword(candidate);
      return migrated.worker;
    })
  );
}

async function mergeIncomingStateWithCredentials(nextState, currentState) {
  return {
    ...nextState,
    users: await mergeUsersWithCredentials(nextState?.users, currentState?.users)
  };
}

function createAuthRateLimiter(windowMs, max) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      logSecurityEvent("auth_rate_limited", req, { maxAttempts: max, windowMs });
      return res.status(429).json({ message: "Demasiados intentos. Intenta nuevamente mas tarde." });
    }
  });
}

const loginRateLimiter = createAuthRateLimiter(env.auth.loginRateLimitWindowMs, env.auth.loginRateLimitMax);
const registerRateLimiter = createAuthRateLimiter(env.auth.registerRateLimitWindowMs, env.auth.registerRateLimitMax);

function hasRoleAccess(profileRole, requiredRoles) {
  const role = String(profileRole || "").trim();
  const normalizedRequired = Array.isArray(requiredRoles) ? requiredRoles.map((value) => String(value || "").trim()) : [];
  if (!normalizedRequired.length) return true;
  if (normalizedRequired.includes(role)) return true;
  if (role === "super_admin" && normalizedRequired.includes("admin")) return true;
  return false;
}

async function authenticateRequest(req, res, options = {}) {
  const { roles = [] } = options;
  const token = readBearerToken(req);
  const profile = verifyToken(token);
  if (!profile) {
    logSecurityEvent("session_invalid", req);
    res.status(401).json({ message: "Sesion invalida o expirada." });
    return null;
  }

  if (await isSessionRevoked(profile)) {
    logSecurityEvent("session_revoked", req, { sid: profile.sid, role: profile.role, id: profile.id });
    res.status(401).json({ message: "Sesion revocada." });
    return null;
  }

  if (!hasRoleAccess(profile.role, roles)) {
    logSecurityEvent("authorization_denied", req, { role: profile.role, requiredRoles: roles });
    res.status(403).json({ message: "No autorizado para esta operacion." });
    return null;
  }

  if (profile.role === "worker") {
    const state = await safeGetState();
    const worker = (state.users || []).find((u) => u.id === profile.id);
    if (!worker || worker.active === false) {
      logSecurityEvent("worker_disabled_or_missing", req, { workerId: profile.id });
      res.status(403).json({ message: "Usuario inhabilitado." });
      return null;
    }
  }

  return profile;
}

function readOrderIdParam(req, res) {
  const parsed = parseInput(workerOrderParamsSchema, req?.params || {}, res);
  if (!parsed) {
    logSecurityEvent("request_validation_failed", req, { endpoint: req.originalUrl || "/api/worker/orders/:orderId" });
    return null;
  }
  return parsed.orderId;
}

function findActiveWorkerByProfile(data, profile) {
  const users = Array.isArray(data?.users) ? data.users : [];
  const worker = users.find((row) => String(row?.id || "") === String(profile?.id || ""));
  if (!worker || worker.active === false) return null;
  return worker;
}

router.get("/health", async (_req, res) => {
  try {
    await getState();
    res.json({
      ok: true,
      db: isFirebaseConfigured ? "connected" : "memory_fallback",
      storage: isFirebaseConfigured ? "firestore" : "memory"
    });
  } catch (error) {
    res.status(500).json({ ok: false, db: "disconnected", message: error.message });
  }
});

async function handleDniLookup(dniRaw, req, res, next) {
  try {
    const parsed = parseInput(dniLookupQuerySchema, { dni: dniRaw }, res);
    if (!parsed) {
      logSecurityEvent("request_validation_failed", req, { endpoint: req.originalUrl || "/api/identity/dni" });
      return;
    }
    const dni = parsed.dni;
    const result = await lookupDniIdentity(dni);
    if (!result.ok) return res.status(result.status || 422).json({ message: result.message || "No se pudo consultar DNI." });
    return res.json({
      dni: result.dni || dni,
      name: result.officialName,
      nombres: result.nameParts?.nombres || "",
      apellidoPaterno: result.nameParts?.apellidoPaterno || "",
      apellidoMaterno: result.nameParts?.apellidoMaterno || ""
    });
  } catch (error) {
    return next(error);
  }
}

router.get("/identity/dni/:dni", async (req, res, next) => {
  const params = parseInput(dniLookupParamsSchema, req.params || {}, res);
  if (!params) {
    logSecurityEvent("request_validation_failed", req, { endpoint: "/api/identity/dni/:dni" });
    return;
  }
  return handleDniLookup(params.dni, req, res, next);
});
router.get("/identity/dni", async (req, res, next) => handleDniLookup(req.query?.dni, req, res, next));
router.get("/dni/:dni", async (req, res, next) => {
  const params = parseInput(dniLookupParamsSchema, req.params || {}, res);
  if (!params) {
    logSecurityEvent("request_validation_failed", req, { endpoint: "/api/dni/:dni" });
    return;
  }
  return handleDniLookup(params.dni, req, res, next);
});

router.post("/auth/login", loginRateLimiter, async (req, res, next) => {
  try {
    const input = parseBody(loginBodySchema, req, res);
    if (!input) {
      logSecurityEvent("request_validation_failed", req, { endpoint: "/api/auth/login" });
      return;
    }

    if (input.role === "admin") {
      const authResult = await authenticateAdminCredentials({
        username: input.user,
        password: input.pin
      });
      if (!authResult.ok) {
        if (authResult.blocked) {
          logSecurityEvent("auth_login_blocked_disabled_admin", req, { role: authResult.profile?.role || "admin", user: input.user });
          return res.status(403).json({ message: "Usuario admin inhabilitado." });
        }
        logSecurityEvent("auth_login_failed", req, { role: "admin", user: input.user });
        return res.status(401).json({ message: "Credenciales invalidas." });
      }

      const profile = authResult.profile;
      const token = createToken(profile);
      logSecurityEvent("auth_login_success", req, { role: profile.role, user: profile.username || input.user });
      return res.json({ token, profile });
    }

    const workerId = input.id;
    const workerPass = input.password;
    const data = await safeGetState();
    const users = Array.isArray(data.users) ? data.users : [];
    const workerIndex = users.findIndex((u) => u.id === workerId);
    const worker = workerIndex >= 0 ? users[workerIndex] : null;
    const passwordStatus = worker ? await verifyWorkerPassword(worker, workerPass) : { matches: false };
    if (!worker || !passwordStatus.matches) {
      logSecurityEvent("auth_login_failed", req, { role: "worker", workerId });
      return res.status(401).json({ message: "Credenciales invalidas." });
    }
    if (worker.active === false) {
      logSecurityEvent("auth_login_blocked_disabled_user", req, { workerId });
      return res.status(403).json({ message: "Tu usuario esta inhabilitado. Contacta al administrador." });
    }

    const secureWorker = passwordStatus.worker || worker;
    if (passwordStatus.needsMigration) {
      users[workerIndex] = secureWorker;
      data.users = users;
      await safePersistState(data);
    }
    logSecurityEvent("auth_login_success", req, {
      role: "worker",
      workerId,
      passwordMigrated: Boolean(passwordStatus.needsMigration)
    });

    const profile = {
      role: "worker",
      id: secureWorker.id,
      name: secureWorker.name || "",
      phone: secureWorker.phone || "",
      email: secureWorker.email || ""
    };
    const token = createToken(profile);
    return res.json({ token, profile });
  } catch (error) {
    return next(error);
  }
});

router.post("/auth/register", registerRateLimiter, async (req, res, next) => {
  try {
    const input = parseBody(registerBodySchema, req, res);
    if (!input) {
      logSecurityEvent("request_validation_failed", req, { endpoint: "/api/auth/register" });
      return;
    }
    const dni = input.id;
    const fullName = input.name;
    const normalizedPhone = input.phone.replace(/\D/g, "");
    const workerEmail = input.email.trim();
    const pass = input.password;

    const identityCheck = await validateWorkerIdentity({ dni, fullName });
    if (!identityCheck.ok) {
      logSecurityEvent("auth_register_identity_failed", req, { dni, status: identityCheck.status || 422 });
      return res.status(identityCheck.status || 422).json({ message: identityCheck.message || "No se pudo validar identidad." });
    }

    const data = await safeGetState();
    const alreadyExists = (data.users || []).some((u) => u.id === dni || u.email === workerEmail);
    if (alreadyExists) {
      logSecurityEvent("auth_register_conflict", req, { dni, email: workerEmail });
      return res.status(409).json({ message: "Ese DNI o correo ya existe." });
    }

    data.users = Array.isArray(data.users) ? data.users : [];
    const passwordHash = await hashPassword(pass);
    const worker = {
      id: dni,
      name: fullName,
      phone: normalizedPhone,
      email: workerEmail,
      passwordHash,
      active: true,
      createdAt: new Date().toISOString()
    };

    data.users = data.users.filter((u) => u.id !== dni);
    data.users.push(worker);
    await safePersistState(data);
    logSecurityEvent("auth_register_success", req, { dni, email: workerEmail });

    const profile = { role: "worker", id: worker.id, name: worker.name, phone: worker.phone, email: worker.email };
    const token = createToken(profile);
    return res.json({ token, profile });
  } catch (error) {
    return next(error);
  }
});

router.post("/worker/orders", async (req, res, next) => {
  try {
    const profile = await authenticateRequest(req, res, { roles: ["worker"] });
    if (!profile) return;
    const input = parseBody(workerCreateOrderBodySchema, req, res);
    if (!input) {
      logSecurityEvent("request_validation_failed", req, { endpoint: "/api/worker/orders" });
      return;
    }

    const data = await safeGetState();
    const worker = findActiveWorkerByProfile(data, profile);
    if (!worker) return res.status(403).json({ message: "Usuario inhabilitado." });
    if (!isOrderWindowOpen()) return res.status(400).json({ message: "Ventas cerradas (martes)." });

    const usedKg = getWorkerWeeklyKg(data.orders, profile.id, new Date());
    const nextKg = toNumber(input.kg);
    if (usedKg + nextKg > 2) {
      return res.status(400).json({ message: "Superas limite semanal de 2 Kg." });
    }

    const cycleKey = getCycleKey(new Date());
    const published = isPricePublished(data.settings, cycleKey);
    const pricePerKg = published ? getPricePerKg(data.settings, cycleKey) : 0;

    const order = {
      id: uid("ord"),
      workerId: worker.id,
      workerName: worker.name || "",
      workerPhone: worker.phone || "",
      workerEmail: worker.email || "",
      cycleKey,
      kg: nextKg,
      pricePerKg,
      total: published ? nextKg * pricePerKg : 0,
      status: published ? "price_published" : "pending_confirm",
      createdAt: new Date().toISOString(),
      deliveryDate: getDeliveryFridayForCycleKey(cycleKey)
    };

    data.orders = Array.isArray(data.orders) ? data.orders : [];
    data.orders.push(order);
    addOrderHistoryEntry(data, order, "created", "Solicitud registrada", profile.id);
    const persisted = await safePersistState(data);
    logSecurityEvent("worker_order_created", req, {
      workerId: profile.id,
      orderId: order.id,
      kg: order.kg,
      persisted
    });

    return res.json({ ok: true, order, persisted });
  } catch (error) {
    return next(error);
  }
});

router.post("/worker/orders/:orderId/confirm", async (req, res, next) => {
  try {
    const profile = await authenticateRequest(req, res, { roles: ["worker"] });
    if (!profile) return;
    const orderId = readOrderIdParam(req, res);
    if (!orderId) return;

    const data = await safeGetState();
    const worker = findActiveWorkerByProfile(data, profile);
    if (!worker) return res.status(403).json({ message: "Usuario inhabilitado." });

    const order = (Array.isArray(data.orders) ? data.orders : []).find((row) => row.id === orderId && row.workerId === worker.id);
    if (!order) return res.status(404).json({ message: "Pedido no encontrado." });
    if (order.status !== "price_published") {
      return res.status(400).json({ message: "Aun no hay precio publicado para confirmar esta compra." });
    }

    if (!isBeforePendingDeadline(order)) {
      order.status = "cancelled";
      order.cancelledAt = new Date().toISOString();
      order.cancelReason = "No confirmo su compra hasta el lunes a las 23:59.";
      addOrderNotifications(data, order);
      addOrderHistoryEntry(data, order, "cancelled", order.cancelReason, profile.id);
      const persisted = await safePersistState(data);
      logSecurityEvent("worker_order_auto_cancelled_deadline", req, {
        workerId: profile.id,
        orderId: order.id,
        persisted
      });
      return res.status(409).json({ message: "Plazo vencido. Tu compra paso a cancelada.", order });
    }

    const cycleKey = getOrderCycleKey(order);
    const pricePerKg = getPricePerKg(data.settings, cycleKey);
    order.pricePerKg = pricePerKg;
    order.total = toNumber(order.kg) * pricePerKg;
    order.status = "requested";
    order.confirmedAt = new Date().toISOString();
    delete order.cancelledAt;
    delete order.cancelReason;

    addOrderNotifications(data, order);
    addOrderHistoryEntry(data, order, "confirmed", "Compra confirmada por trabajador", profile.id);
    const persisted = await safePersistState(data);
    logSecurityEvent("worker_order_confirmed", req, {
      workerId: profile.id,
      orderId: order.id,
      persisted
    });
    return res.json({ ok: true, order, persisted });
  } catch (error) {
    return next(error);
  }
});

router.post("/worker/orders/:orderId/cancel", async (req, res, next) => {
  try {
    const profile = await authenticateRequest(req, res, { roles: ["worker"] });
    if (!profile) return;
    const orderId = readOrderIdParam(req, res);
    if (!orderId) return;

    const data = await safeGetState();
    const worker = findActiveWorkerByProfile(data, profile);
    if (!worker) return res.status(403).json({ message: "Usuario inhabilitado." });

    const order = (Array.isArray(data.orders) ? data.orders : []).find((row) => row.id === orderId && row.workerId === worker.id);
    if (!order) return res.status(404).json({ message: "Pedido no encontrado." });
    if (!["pending_confirm", "price_published"].includes(String(order.status || ""))) {
      return res.status(400).json({ message: "No puedes cancelar este pedido." });
    }

    order.status = "cancelled";
    order.cancelledAt = new Date().toISOString();
    order.cancelReason = "Cancelado por trabajador.";
    addOrderNotifications(data, order);
    addOrderHistoryEntry(data, order, "cancelled_by_worker", order.cancelReason, profile.id);

    const persisted = await safePersistState(data);
    logSecurityEvent("worker_order_cancelled", req, {
      workerId: profile.id,
      orderId: order.id,
      persisted
    });
    return res.json({ ok: true, order, persisted });
  } catch (error) {
    return next(error);
  }
});

router.get("/auth/me", async (req, res, next) => {
  try {
    const profile = await authenticateRequest(req, res, { roles: ["admin", "worker"] });
    if (!profile) return;
    return res.json({ profile });
  } catch (error) {
    return next(error);
  }
});

router.post("/auth/logout", async (req, res, next) => {
  try {
    const profile = await authenticateRequest(req, res, { roles: ["admin", "worker"] });
    if (!profile) return;
    const revoked = await revokeSession(profile.sid, profile.exp, {
      role: profile.role,
      id: profile.id,
      revokedByRole: profile.role,
      revokedById: profile.id,
      reason: "self_logout"
    });
    logSecurityEvent("auth_logout", req, {
      role: profile.role,
      id: profile.id,
      sid: profile.sid,
      revoked
    });
    return res.json({ ok: true, revoked });
  } catch (error) {
    return next(error);
  }
});

router.post("/auth/revoke", async (req, res, next) => {
  try {
    const profile = await authenticateRequest(req, res, { roles: ["admin"] });
    if (!profile) return;

    const input = parseBody(authRevokeBodySchema, req, res);
    if (!input) {
      logSecurityEvent("request_validation_failed", req, { endpoint: "/api/auth/revoke" });
      return;
    }
    if ("role" in input && input.role === "super_admin" && profile.role !== "super_admin") {
      logSecurityEvent("authorization_denied", req, {
        endpoint: "/api/auth/revoke",
        actorRole: profile.role,
        targetRole: input.role,
        targetId: input.id
      });
      return res.status(403).json({ message: "Solo super administrador puede revocar sesiones de super administrador." });
    }

    if ("sessionId" in input) {
      const revoked = await revokeSession(input.sessionId, Date.now() + env.auth.tokenTtlMs, {
        revokedByRole: profile.role,
        revokedById: profile.id,
        reason: input.reason || "admin_revoke_session"
      });
      logSecurityEvent("auth_revoke_session", req, {
        adminId: profile.id,
        targetSessionId: input.sessionId,
        reason: input.reason || "",
        revoked
      });
      return res.json({ ok: true, revoked, mode: "session" });
    }

    const count = await revokePrincipalSessions({
      role: input.role,
      id: input.id,
      expiresAt: Date.now() + env.auth.tokenTtlMs,
      reason: input.reason || "admin_revoke_principal",
      revokedByRole: profile.role,
      revokedById: profile.id
    });
    logSecurityEvent("auth_revoke_principal", req, {
      adminId: profile.id,
      targetRole: input.role,
      targetId: input.id,
      reason: input.reason || "",
      revokedSessions: count
    });
    return res.json({ ok: true, revoked: true, mode: "principal", revokedSessions: count });
  } catch (error) {
    return next(error);
  }
});

router.post("/reports/orders/export-template", async (req, res, next) => {
  try {
    const profile = await authenticateRequest(req, res, { roles: ["admin"] });
    if (!profile) return;

    const input = parseBody(exportOrdersTemplateBodySchema, req, res);
    if (!input) {
      logSecurityEvent("request_validation_failed", req, { endpoint: "/api/reports/orders/export-template" });
      return;
    }
    const { orders, rangeFrom, rangeTo } = input;
    const workbook = await buildOrdersTemplateWorkbook({ orders, rangeFrom, rangeTo });
    const buffer = await workbook.xlsx.writeBuffer();

    const timestamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=\"formato_venta_arandano_${timestamp}.xlsx\"`);
    return res.send(Buffer.from(buffer));
  } catch (error) {
    if (String(error?.code || "") === "ENOENT") {
      return res.status(500).json({ message: "No se encontro el formato de exportacion en /templates." });
    }
    return next(error);
  }
});

router.get("/admin/users", async (req, res, next) => {
  try {
    const profile = await authenticateRequest(req, res, { roles: ["super_admin"] });
    if (!profile) return;
    const admins = await listAdminUsersForActor(profile);
    return res.json({ admins });
  } catch (error) {
    return next(error);
  }
});

router.post("/admin/users", async (req, res, next) => {
  try {
    const profile = await authenticateRequest(req, res, { roles: ["super_admin"] });
    if (!profile) return;

    const input = parseBody(adminUserCreateBodySchema, req, res);
    if (!input) {
      logSecurityEvent("request_validation_failed", req, { endpoint: "/api/admin/users" });
      return;
    }

    const created = await createAdminUserBySuperAdmin(input, profile);
    logSecurityEvent("admin_user_created", req, {
      actorRole: profile.role,
      actorId: profile.id,
      createdUsername: created.username
    });
    return res.status(201).json({ ok: true, admin: created });
  } catch (error) {
    return next(error);
  }
});

router.get("/state", async (req, res, next) => {
  try {
    const profile = await authenticateRequest(req, res, { roles: ["admin", "worker"] });
    if (!profile) return;
    markStateEndpointAsTransition(res);
    const data = await safeGetState();
    logSecurityEvent("transition_endpoint_used", req, {
      endpoint: "/api/state",
      method: "GET",
      actorRole: profile.role,
      actorId: profile.id
    });
    res.json({
      data: sanitizeStateForResponse(data, profile),
      transition: {
        deprecated: true,
        endpoint: "/api/state",
        message: STATE_ENDPOINT_TRANSITION_NOTICE,
        sunset: STATE_ENDPOINT_SUNSET
      }
    });
  } catch (error) {
    next(error);
  }
});

router.put("/state", async (req, res, next) => {
  try {
    const profile = await authenticateRequest(req, res, { roles: ["admin"] });
    if (!profile) return;
    markStateEndpointAsTransition(res);

    const input = parseBody(stateUpdateBodySchema, req, res);
    if (!input) {
      logSecurityEvent("request_validation_failed", req, { endpoint: "/api/state" });
      return;
    }
    const sanitizedData = sanitizeUnknown(input.data);
    if (!sanitizedData || typeof sanitizedData !== "object" || Array.isArray(sanitizedData)) {
      return res.status(400).json({ message: "El payload requiere { data: object } valido." });
    }

    const currentState = await safeGetState();
    const mergedState = await mergeIncomingStateWithCredentials(sanitizedData, currentState);
    const persisted = await safePersistState(mergedState);
    logSecurityEvent("transition_endpoint_used", req, {
      endpoint: "/api/state",
      method: "PUT",
      actorRole: profile.role,
      actorId: profile.id
    });
    logSecurityEvent("state_updated", req, {
      actorRole: profile.role,
      actorId: profile.id,
      persisted,
      usersCount: Array.isArray(mergedState.users) ? mergedState.users.length : 0,
      ordersCount: Array.isArray(mergedState.orders) ? mergedState.orders.length : 0
    });
    return res.json({
      ok: true,
      persisted,
      storage: persisted ? "firestore" : "memory",
      message: persisted
        ? "State persisted to Firestore."
        : "Firebase is not configured. State saved only in memory.",
      transition: {
        deprecated: true,
        endpoint: "/api/state",
        message: STATE_ENDPOINT_TRANSITION_NOTICE,
        sunset: STATE_ENDPOINT_SUNSET
      }
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
