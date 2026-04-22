import "dotenv/config";

const LEGACY_STATE_PATH = ["app", "state"];
const ROOT_COLLECTIONS = ["settings", "users", "orders", "order_history", "notifications", "notices"];
const PRODUCTION_MIGRATION_ALLOWED = process.env.ALLOW_PROD_MIGRATION === "true";

if (process.env.NODE_ENV === "production" && !PRODUCTION_MIGRATION_ALLOWED) {
  throw new Error("Migracion bloqueada. Define ALLOW_PROD_MIGRATION=true para ejecutar en produccion.");
}

function countList(value) {
  return Array.isArray(value) ? value.length : 0;
}

async function countCollection(firestore, collection, getDocs, collectionName) {
  const snapshot = await getDocs(collection(firestore, collectionName));
  return snapshot.size;
}

async function run() {
  const { collection, deleteDoc, doc, getDoc, getDocs } = await import("firebase/firestore");
  const { firestore, isFirebaseConfigured } = await import("../src/config/firebase.js");
  const { persistState } = await import("../src/modules/state/state.repository.js");

  if (!isFirebaseConfigured || !firestore) {
    throw new Error("Firebase is not configured. Complete FIREBASE_* vars in .env before migrating.");
  }

  const legacyRef = doc(firestore, ...LEGACY_STATE_PATH);
  const legacySnapshot = await getDoc(legacyRef);

  if (!legacySnapshot.exists()) {
    console.log("[migration] Legacy document app/state not found. Nothing to migrate.");
    return;
  }

  const legacyState = legacySnapshot.data() || {};
  console.log("[migration] Legacy app/state found.");
  console.log(`[migration] users=${countList(legacyState.users)}, orders=${countList(legacyState.orders)}, notices=${countList(legacyState.notices)}, notifications=${countList(legacyState.notifications)}, orderHistory=${countList(legacyState.orderHistory)}`);

  await persistState(legacyState);
  console.log("[migration] Data written to root collections.");

  await deleteDoc(legacyRef);
  console.log("[migration] Legacy document app/state deleted.");

  for (const collectionName of ROOT_COLLECTIONS) {
    const total = await countCollection(firestore, collection, getDocs, collectionName);
    console.log(`[migration] ${collectionName}: ${total} document(s)`);
  }
}

run().catch((error) => {
  console.error(`[migration] Failed: ${error.message}`);
  process.exitCode = 1;
});
