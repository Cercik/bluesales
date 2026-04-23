import { deleteDoc, doc, getDoc, setDoc } from "firebase/firestore";
import { env } from "../../config/env.js";
import { firestore, isFirebaseConfigured } from "../../config/firebase.js";

const revokedSessions = new Map();
const issuedSessions = new Map();
const revokedPrincipals = new Map();
const sessionNotRevokedCache = new Map();
const principalNotRevokedCache = new Map();
const NEGATIVE_CACHE_TTL_MS =
  env.nodeEnv === "production"
    ? 0
    : 30_000;

function nowMs() {
  return Date.now();
}

function principalKey(role, id) {
  return `${String(role || "").trim()}:${String(id || "").trim()}`;
}

function principalDocId(role, id) {
  return `${encodeURIComponent(String(role || "").trim())}__${encodeURIComponent(String(id || "").trim())}`;
}

function serializeError(error) {
  return {
    message: error?.message || "unknown_error",
    name: error?.name || "Error",
    code: error?.code || null
  };
}

function upsertNegativeCache(cache, key, now) {
  if (NEGATIVE_CACHE_TTL_MS <= 0) return;
  if (!key) return;
  cache.set(key, now + NEGATIVE_CACHE_TTL_MS);
}

function hasFreshNegativeCache(cache, key, now) {
  if (!key) return false;
  const expiresAt = Number(cache.get(key) || 0);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

function cleanupExpiredEntries(now = nowMs()) {
  for (const [sessionId, expiresAt] of revokedSessions.entries()) {
    if (!Number.isFinite(expiresAt) || expiresAt <= now) revokedSessions.delete(sessionId);
  }
  for (const [sessionId, meta] of issuedSessions.entries()) {
    if (!meta || !Number.isFinite(meta.exp) || meta.exp <= now) issuedSessions.delete(sessionId);
  }
  for (const [key, expiresAt] of revokedPrincipals.entries()) {
    if (!Number.isFinite(expiresAt) || expiresAt <= now) revokedPrincipals.delete(key);
  }
  for (const [sid, cacheUntil] of sessionNotRevokedCache.entries()) {
    if (!Number.isFinite(cacheUntil) || cacheUntil <= now) sessionNotRevokedCache.delete(sid);
  }
  for (const [key, cacheUntil] of principalNotRevokedCache.entries()) {
    if (!Number.isFinite(cacheUntil) || cacheUntil <= now) principalNotRevokedCache.delete(key);
  }
}

async function fetchRevokedSessionFromStore(sessionId, now) {
  if (!isFirebaseConfigured || !firestore) return false;
  try {
    const ref = doc(firestore, "security_revoked_sessions", sessionId);
    const snapshot = await getDoc(ref);
    if (!snapshot.exists()) return false;
    const data = snapshot.data() || {};
    const expiresAt = Number(data.exp || 0);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      await deleteDoc(ref).catch(() => {});
      return false;
    }
    revokedSessions.set(sessionId, expiresAt);
    return true;
  } catch (error) {
    console.warn("[security] No se pudo consultar revocacion de sesión en Firestore.", serializeError(error));
    return false;
  }
}

async function fetchRevokedPrincipalFromStore(role, id, now) {
  if (!isFirebaseConfigured || !firestore) return false;
  const key = principalKey(role, id);
  try {
    const ref = doc(firestore, "security_revoked_principals", principalDocId(role, id));
    const snapshot = await getDoc(ref);
    if (!snapshot.exists()) return false;
    const data = snapshot.data() || {};
    const expiresAt = Number(data.exp || 0);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      await deleteDoc(ref).catch(() => {});
      return false;
    }
    revokedPrincipals.set(key, expiresAt);
    return true;
  } catch (error) {
    console.warn("[security] No se pudo consultar revocacion de principal en Firestore.", serializeError(error));
    return false;
  }
}

export function registerIssuedSession(payload) {
  cleanupExpiredEntries();
  const sid = String(payload?.sid || "").trim();
  if (!sid) return;
  const role = String(payload?.role || "").trim();
  const id = String(payload?.id || "").trim();
  const exp = Number(payload?.exp || 0);
  issuedSessions.set(sid, { sid, role, id, exp });
}

export function isSessionRevokedInMemory(payload) {
  cleanupExpiredEntries();
  const sid = String(payload?.sid || "").trim();
  const role = String(payload?.role || "").trim();
  const id = String(payload?.id || "").trim();
  const now = nowMs();

  if (sid && revokedSessions.has(sid)) {
    const expiresAt = Number(revokedSessions.get(sid) || 0);
    if (Number.isFinite(expiresAt) && expiresAt > now) return true;
  }

  const key = principalKey(role, id);
  if (key && revokedPrincipals.has(key)) {
    const expiresAt = Number(revokedPrincipals.get(key) || 0);
    if (Number.isFinite(expiresAt) && expiresAt > now) return true;
  }

  return false;
}

export async function isSessionRevoked(payload) {
  cleanupExpiredEntries();
  if (isSessionRevokedInMemory(payload)) return true;

  const sid = String(payload?.sid || "").trim();
  const role = String(payload?.role || "").trim();
  const id = String(payload?.id || "").trim();
  const key = principalKey(role, id);
  const now = nowMs();

  if (sid && !hasFreshNegativeCache(sessionNotRevokedCache, sid, now)) {
    const revoked = await fetchRevokedSessionFromStore(sid, now);
    if (revoked) return true;
    upsertNegativeCache(sessionNotRevokedCache, sid, now);
  }

  if (key && !hasFreshNegativeCache(principalNotRevokedCache, key, now)) {
    const revoked = await fetchRevokedPrincipalFromStore(role, id, now);
    if (revoked) return true;
    upsertNegativeCache(principalNotRevokedCache, key, now);
  }

  return false;
}

export async function revokeSession(sessionId, expiresAt, meta = {}) {
  cleanupExpiredEntries();
  const sid = String(sessionId || "").trim();
  if (!sid) return false;

  const now = nowMs();
  const exp = Number(expiresAt || 0);
  const ttl = Number.isFinite(exp) && exp > 0 ? exp : now + 1000 * 60 * 60 * 24;

  revokedSessions.set(sid, ttl);
  issuedSessions.delete(sid);
  sessionNotRevokedCache.delete(sid);

  if (isFirebaseConfigured && firestore) {
    try {
      await setDoc(doc(firestore, "security_revoked_sessions", sid), {
        sid,
        exp: ttl,
        revokedAt: new Date(now).toISOString(),
        reason: String(meta?.reason || "").trim(),
        revokedByRole: String(meta?.revokedByRole || "").trim(),
        revokedById: String(meta?.revokedById || "").trim(),
        role: String(meta?.role || "").trim(),
        id: String(meta?.id || "").trim()
      });
    } catch (error) {
      console.warn("[security] No se pudo persistir revocacion de sesión en Firestore.", serializeError(error));
    }
  }

  return true;
}

export async function revokePrincipalSessions({ role, id, expiresAt, reason = "", revokedByRole = "", revokedById = "" }) {
  cleanupExpiredEntries();
  const key = principalKey(role, id);
  const now = nowMs();
  const exp = Number(expiresAt || 0);
  const ttl = Number.isFinite(exp) && exp > 0 ? exp : now + 1000 * 60 * 60 * 24;
  revokedPrincipals.set(key, ttl);
  principalNotRevokedCache.delete(key);

  if (isFirebaseConfigured && firestore) {
    try {
      await setDoc(doc(firestore, "security_revoked_principals", principalDocId(role, id)), {
        key,
        role: String(role || "").trim(),
        id: String(id || "").trim(),
        exp: ttl,
        revokedAt: new Date(now).toISOString(),
        reason: String(reason || "").trim(),
        revokedByRole: String(revokedByRole || "").trim(),
        revokedById: String(revokedById || "").trim()
      });
    } catch (error) {
      console.warn("[security] No se pudo persistir revocacion de principal en Firestore.", serializeError(error));
    }
  }

  let revokedCount = 0;
  for (const [sid, meta] of issuedSessions.entries()) {
    if (!meta) continue;
    if (principalKey(meta.role, meta.id) !== key) continue;
    revokedSessions.set(sid, meta.exp || ttl);
    issuedSessions.delete(sid);
    sessionNotRevokedCache.delete(sid);
    revokedCount += 1;
  }
  return revokedCount;
}

