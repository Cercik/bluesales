import bcrypt from "bcryptjs";
import { collection, doc, getDoc, getDocs, setDoc } from "firebase/firestore";
import { env } from "../../config/env.js";
import { firestore, isFirebaseConfigured } from "../../config/firebase.js";
import { hashPassword } from "./password.service.js";

const ADMIN_COLLECTION = "admin_users";
const ADMIN_ROLES = new Set(["admin", "super_admin"]);

const memoryAdmins = new Map();
let bootstrapPromise = null;

function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function docIdForUsername(username) {
  return encodeURIComponent(normalizeUsername(username));
}

function nowIso() {
  return new Date().toISOString();
}

function buildServiceError(message, statusCode, code) {
  const error = new Error(String(message || "Error de servicio."));
  error.statusCode = Number(statusCode) || 500;
  error.code = String(code || "service_error");
  return error;
}

function normalizeAdminRecord(input) {
  const row = input && typeof input === "object" ? { ...input } : {};
  const username = normalizeUsername(row.username || row.id);
  const role = ADMIN_ROLES.has(String(row.role || "")) ? String(row.role) : "admin";
  const createdAt = String(row.createdAt || nowIso());
  const updatedAt = String(row.updatedAt || createdAt);
  const passwordHash = String(row.passwordHash || "").trim();
  if (!username || !passwordHash) return null;
  return {
    id: docIdForUsername(username),
    username,
    name: String(row.name || username),
    role,
    active: row.active !== false,
    passwordHash,
    createdAt,
    updatedAt,
    lastLoginAt: row.lastLoginAt ? String(row.lastLoginAt) : null,
    createdBy: String(row.createdBy || "system")
  };
}

function sanitizeAdminRecord(input) {
  const row = normalizeAdminRecord(input);
  if (!row) return null;
  return {
    username: row.username,
    name: row.name,
    role: row.role,
    active: row.active,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastLoginAt: row.lastLoginAt,
    createdBy: row.createdBy
  };
}

async function getAdminFromStore(username) {
  const key = normalizeUsername(username);
  if (!key) return null;
  if (!isFirebaseConfigured || !firestore) {
    return normalizeAdminRecord(memoryAdmins.get(key));
  }
  const ref = doc(firestore, ADMIN_COLLECTION, docIdForUsername(key));
  const snapshot = await getDoc(ref);
  if (!snapshot.exists()) return null;
  return normalizeAdminRecord({
    id: snapshot.id,
    ...(snapshot.data() || {})
  });
}

async function listAdminsFromStore() {
  if (!isFirebaseConfigured || !firestore) {
    return [...memoryAdmins.values()]
      .map((row) => normalizeAdminRecord(row))
      .filter(Boolean);
  }
  const snapshot = await getDocs(collection(firestore, ADMIN_COLLECTION));
  return snapshot.docs
    .map((entry) => normalizeAdminRecord({ id: entry.id, ...(entry.data() || {}) }))
    .filter(Boolean);
}

async function setAdminInStore(record) {
  const normalized = normalizeAdminRecord(record);
  if (!normalized) return null;
  if (!isFirebaseConfigured || !firestore) {
    memoryAdmins.set(normalized.username, normalized);
    return normalized;
  }
  await setDoc(doc(firestore, ADMIN_COLLECTION, normalized.id), normalized, { merge: true });
  return normalized;
}

async function ensureSeedAdmin({ username, name, password, role, createdBy }) {
  const normalizedUsername = normalizeUsername(username);
  const plainPassword = String(password || "");
  if (!normalizedUsername || !plainPassword) return;

  const existing = await getAdminFromStore(normalizedUsername);
  if (existing) return;

  const passwordHash = await hashPassword(plainPassword);
  await setAdminInStore({
    username: normalizedUsername,
    name: String(name || normalizedUsername),
    role: ADMIN_ROLES.has(String(role || "")) ? String(role) : "admin",
    active: true,
    passwordHash,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    createdBy: String(createdBy || "bootstrap")
  });
}

export async function ensureAdminDirectoryReady() {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      await ensureSeedAdmin({
        username: env.auth.superAdminUser,
        name: env.auth.superAdminName || env.auth.superAdminUser,
        password: env.auth.superAdminPassword,
        role: "super_admin",
        createdBy: "bootstrap_super_admin"
      });
      await ensureSeedAdmin({
        username: env.auth.adminUser,
        name: "Administrador",
        password: env.auth.adminPin,
        role: "admin",
        createdBy: "bootstrap_legacy_admin"
      });
    })();
  }
  await bootstrapPromise;
}

function buildAuthProfile(adminRecord) {
  const row = normalizeAdminRecord(adminRecord);
  if (!row) return null;
  return {
    role: row.role,
    id: row.username,
    name: row.name,
    username: row.username
  };
}

function sortAdmins(admins) {
  return [...admins].sort((a, b) => {
    if (a.role !== b.role) {
      if (a.role === "super_admin") return -1;
      if (b.role === "super_admin") return 1;
    }
    return String(a.username || "").localeCompare(String(b.username || ""));
  });
}

export async function authenticateAdminCredentials({ username, password }) {
  await ensureAdminDirectoryReady();
  const normalizedUsername = normalizeUsername(username);
  const plainPassword = String(password || "");
  if (!normalizedUsername || !plainPassword) {
    return { ok: false, blocked: false, profile: null };
  }

  const admin = await getAdminFromStore(normalizedUsername);
  if (!admin) {
    return { ok: false, blocked: false, profile: null };
  }
  if (admin.active === false) {
    return { ok: false, blocked: true, profile: buildAuthProfile(admin) };
  }

  const matches = await bcrypt.compare(plainPassword, admin.passwordHash);
  if (!matches) {
    return { ok: false, blocked: false, profile: null };
  }

  const updated = await setAdminInStore({
    ...admin,
    lastLoginAt: nowIso(),
    updatedAt: nowIso()
  });

  return {
    ok: true,
    blocked: false,
    profile: buildAuthProfile(updated || admin)
  };
}

export async function listAdminUsersForActor(actorProfile) {
  await ensureAdminDirectoryReady();
  const actorRole = String(actorProfile?.role || "");
  const all = await listAdminsFromStore();
  const filtered = actorRole === "super_admin" ? all : all.filter((row) => row.role !== "super_admin");
  return sortAdmins(filtered)
    .map((row) => sanitizeAdminRecord(row))
    .filter(Boolean);
}

export async function createAdminUserBySuperAdmin(input, actorProfile) {
  await ensureAdminDirectoryReady();
  if (String(actorProfile?.role || "") !== "super_admin") {
    throw buildServiceError("Solo super administrador puede crear admins.", 403, "forbidden_super_admin_required");
  }

  const username = normalizeUsername(input?.username);
  const name = String(input?.name || "").trim();
  const password = String(input?.password || "");

  if (!username) {
    throw buildServiceError("username requerido.", 400, "invalid_username");
  }
  if (!name) {
    throw buildServiceError("name requerido.", 400, "invalid_name");
  }
  if (password.length < 8) {
    throw buildServiceError("password invalido. Minimo 8 caracteres.", 400, "invalid_password");
  }

  const existing = await getAdminFromStore(username);
  if (existing) {
    throw buildServiceError("El usuario admin ya existe.", 409, "admin_already_exists");
  }

  const passwordHash = await hashPassword(password);
  const created = await setAdminInStore({
    username,
    name,
    role: "admin",
    active: true,
    passwordHash,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    createdBy: String(actorProfile?.id || "super_admin")
  });

  const safe = sanitizeAdminRecord(created);
  if (!safe) {
    throw buildServiceError("No se pudo crear el admin.", 500, "admin_creation_failed");
  }
  return safe;
}
