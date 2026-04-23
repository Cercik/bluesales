import { collection, doc, getDoc, getDocs, setDoc, writeBatch } from "firebase/firestore";
import { env } from "../../config/env.js";
import { firestore } from "../../config/firebase.js";
import { buildDefaultState } from "./default-state.factory.js";

const LEGACY_STATE_REF = firestore ? doc(firestore, "app", "state") : null;
const SETTINGS_REF = firestore ? doc(firestore, "settings", "global") : null;

const COLLECTIONS = {
  users: "users",
  orders: "orders",
  notices: "notices",
  notifications: "notifications",
  orderHistory: "order_history"
};

let memoryState = buildDefaultState();
let schemaReadyPromise = null;
let stateHydratedFromStore = false;
let lastStateSyncMs = 0;
const STATE_CACHE_TTL_MS = (() => {
  const raw = Number(process.env.STATE_CACHE_TTL_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return env.nodeEnv === "production" ? 60_000 : 1_000;
})();

function assertPersistentStorageAvailable() {
  if (firestore && SETTINGS_REF) return;
  if (env.nodeEnv === "production") {
    throw new Error("[state] Persistencia en memoria bloqueada en producción. Firebase/Firestore no disponible.");
  }
}

function randomId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeId(value, prefix) {
  const raw = String(value || "").trim().replaceAll("/", "_");
  return raw || randomId(prefix);
}

function ensureDefaults(data) {
  const next = data && typeof data === "object" ? data : buildDefaultState();
  if (!next.settings) next.settings = {};
  if (!("pricePerKg" in next.settings)) next.settings.pricePerKg = 22;
  if (!("pricePublishedCycle" in next.settings)) next.settings.pricePublishedCycle = "";
  if (!next.settings.notificationTemplates) {
    next.settings.notificationTemplates = {
      whatsapp: "BlueSales: tu pedido {{orderId}} ahora está en estado {{status}}. Entrega estimada: {{deliveryDate}}.",
      email: "BlueSales: tu pedido {{orderId}} ahora está en estado {{status}}. Entrega estimada: {{deliveryDate}}."
    };
  }
  if (!Array.isArray(next.users)) next.users = [];
  if (!Array.isArray(next.orders)) next.orders = [];
  if (!Array.isArray(next.notifications)) next.notifications = [];
  if (!Array.isArray(next.orderHistory)) next.orderHistory = [];
  if (!Array.isArray(next.notices)) next.notices = [];
  if (!next.noticeReads || typeof next.noticeReads !== "object") next.noticeReads = {};
  if (!("demoSeedVersion" in next)) next.demoSeedVersion = 1;
  return next;
}

function normalizeRecords(items, fallbackPrefix) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const row = item && typeof item === "object" ? { ...item } : {};
      const id = sanitizeId(row.id, fallbackPrefix);
      return { ...row, id };
    });
}

async function commitOperations(operations) {
  if (!operations.length) return;
  const chunkSize = 450;
  for (let index = 0; index < operations.length; index += chunkSize) {
    const chunk = operations.slice(index, index + chunkSize);
    const batch = writeBatch(firestore);
    chunk.forEach((op) => {
      if (op.type === "set") batch.set(op.ref, op.data);
      if (op.type === "delete") batch.delete(op.ref);
    });
    await batch.commit();
  }
}

async function syncCollection(collectionName, items, fallbackPrefix) {
  const records = normalizeRecords(items, fallbackPrefix);
  const colRef = collection(firestore, collectionName);
  const snapshot = await getDocs(colRef);
  const existingIds = new Set(snapshot.docs.map((row) => row.id));
  const targetIds = new Set();
  const operations = [];

  records.forEach((record) => {
    const id = sanitizeId(record.id, fallbackPrefix);
    targetIds.add(id);
    operations.push({
      type: "set",
      ref: doc(firestore, collectionName, id),
      data: { ...record, id }
    });
  });

  existingIds.forEach((id) => {
    if (!targetIds.has(id)) {
      operations.push({ type: "delete", ref: doc(firestore, collectionName, id) });
    }
  });

  await commitOperations(operations);
  return records;
}

function normalizeNoticeReadsMap(noticeReads) {
  const input = noticeReads && typeof noticeReads === "object" ? noticeReads : {};
  const output = {};
  Object.entries(input).forEach(([userIdRaw, values]) => {
    const userId = sanitizeId(userIdRaw, "user");
    const list = Array.isArray(values) ? values : [];
    output[userId] = [...new Set(list.map((value) => sanitizeId(value, "notice")))];
  });
  return output;
}

async function syncNoticeReads(noticeReads, users) {
  const readsMap = normalizeNoticeReadsMap(noticeReads);
  const userIds = [...new Set(normalizeRecords(users, "user").map((user) => sanitizeId(user.id, "user")))];

  for (const userId of userIds) {
    const subCollectionPath = [COLLECTIONS.users, userId, "notice_reads"];
    const subRef = collection(firestore, ...subCollectionPath);
    const snapshot = await getDocs(subRef);
    const existingIds = new Set(snapshot.docs.map((row) => row.id));
    const targetIds = new Set((readsMap[userId] || []).map((value) => sanitizeId(value, "notice")));

    const operations = [];
    targetIds.forEach((noticeId) => {
      operations.push({
        type: "set",
        ref: doc(firestore, ...subCollectionPath, noticeId),
        data: {
          noticeId,
          read: true,
          updatedAt: new Date().toISOString()
        }
      });
    });

    existingIds.forEach((noticeId) => {
      if (!targetIds.has(noticeId)) {
        operations.push({ type: "delete", ref: doc(firestore, ...subCollectionPath, noticeId) });
      }
    });

    await commitOperations(operations);
  }
}

async function readCollection(collectionName) {
  const snapshot = await getDocs(collection(firestore, collectionName));
  return snapshot.docs.map((row) => ({ id: row.id, ...(row.data() || {}) }));
}

async function readNoticeReads(users) {
  const result = {};
  const list = normalizeRecords(users, "user");

  await Promise.all(list.map(async (user) => {
    const userId = sanitizeId(user.id, "user");
    const snapshot = await getDocs(collection(firestore, COLLECTIONS.users, userId, "notice_reads"));
    const noticeIds = snapshot.docs.map((row) => row.id);
    if (noticeIds.length) result[userId] = noticeIds;
  }));

  return result;
}

async function persistToCollections(data) {
  const next = ensureDefaults(data);
  const users = await syncCollection(COLLECTIONS.users, next.users, "user");
  const orders = await syncCollection(COLLECTIONS.orders, next.orders, "ord");
  const notices = await syncCollection(COLLECTIONS.notices, next.notices, "notice");
  const notifications = await syncCollection(COLLECTIONS.notifications, next.notifications, "ntf");
  const orderHistory = await syncCollection(COLLECTIONS.orderHistory, next.orderHistory, "hist");

  await setDoc(SETTINGS_REF, {
    id: "global",
    settings: next.settings,
    demoSeedVersion: next.demoSeedVersion,
    updatedAt: new Date().toISOString()
  });

  await syncNoticeReads(next.noticeReads, users);

  return ensureDefaults({
    settings: next.settings,
    users,
    orders,
    notices,
    notifications,
    orderHistory,
    noticeReads: normalizeNoticeReadsMap(next.noticeReads),
    demoSeedVersion: next.demoSeedVersion
  });
}

async function readFromCollections() {
  const settingsSnapshot = await getDoc(SETTINGS_REF);
  const users = await readCollection(COLLECTIONS.users);
  const orders = await readCollection(COLLECTIONS.orders);
  const notices = await readCollection(COLLECTIONS.notices);
  const notifications = await readCollection(COLLECTIONS.notifications);
  const orderHistory = await readCollection(COLLECTIONS.orderHistory);
  const noticeReads = await readNoticeReads(users);

  const settingsPayload = settingsSnapshot.exists() ? settingsSnapshot.data() : {};

  return ensureDefaults({
    settings: settingsPayload?.settings,
    users,
    orders,
    notices,
    notifications,
    orderHistory,
    noticeReads,
    demoSeedVersion: settingsPayload?.demoSeedVersion
  });
}

async function migrateLegacyStateIfRequired() {
  const settingsSnapshot = await getDoc(SETTINGS_REF);
  if (settingsSnapshot.exists()) return;

  const legacySnapshot = await getDoc(LEGACY_STATE_REF);
  if (legacySnapshot.exists()) {
    const legacyState = ensureDefaults(legacySnapshot.data());
    await persistToCollections(legacyState);
    await setDoc(LEGACY_STATE_REF, { ...legacyState, migratedAt: new Date().toISOString() }, { merge: true });
    return;
  }

  await persistToCollections(buildDefaultState());
}

export async function ensureSchema() {
  assertPersistentStorageAvailable();
  if (!firestore || !SETTINGS_REF || !LEGACY_STATE_REF) return;
  if (!schemaReadyPromise) {
    schemaReadyPromise = migrateLegacyStateIfRequired();
  }
  await schemaReadyPromise;
}

export async function getState() {
  assertPersistentStorageAvailable();
  if (!firestore || !SETTINGS_REF) return ensureDefaults(memoryState);
  await ensureSchema();
  const now = Date.now();
  if (stateHydratedFromStore && (now - lastStateSyncMs) <= STATE_CACHE_TTL_MS) {
    return ensureDefaults(memoryState);
  }
  const state = await readFromCollections();
  memoryState = state;
  stateHydratedFromStore = true;
  lastStateSyncMs = now;
  return state;
}

export async function persistState(data) {
  assertPersistentStorageAvailable();
  if (!firestore || !SETTINGS_REF) {
    memoryState = ensureDefaults(data);
    stateHydratedFromStore = true;
    lastStateSyncMs = Date.now();
    return;
  }
  await ensureSchema();
  memoryState = await persistToCollections(data);
  stateHydratedFromStore = true;
  lastStateSyncMs = Date.now();
}

