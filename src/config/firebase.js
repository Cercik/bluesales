import { getApp, getApps, initializeApp } from "firebase/app";
import { initializeFirestore } from "firebase/firestore";
import { env } from "./env.js";

function clearBrokenProxyEnv() {
  const proxyKeys = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "GIT_HTTP_PROXY",
    "GIT_HTTPS_PROXY",
    "git_http_proxy",
    "git_https_proxy"
  ];

  for (const key of proxyKeys) {
    const raw = String(process.env[key] || "").trim();
    if (!raw) continue;
    const normalized = raw.toLowerCase();
    if (normalized.includes("127.0.0.1:9") || normalized.includes("localhost:9")) {
      delete process.env[key];
      console.warn(`[startup] Ignored invalid proxy in ${key}: ${raw}`);
    }
  }
}

function validateFirebaseConfig(config) {
  const required = ["apiKey", "authDomain", "projectId", "storageBucket", "messagingSenderId", "appId"];
  return required.every((key) => Boolean(String(config[key] || "").trim()));
}

clearBrokenProxyEnv();

const firebaseConfig = {
  apiKey: env.firebase.apiKey,
  authDomain: env.firebase.authDomain,
  projectId: env.firebase.projectId,
  storageBucket: env.firebase.storageBucket,
  messagingSenderId: env.firebase.messagingSenderId,
  appId: env.firebase.appId,
  measurementId: env.firebase.measurementId
};

export const isFirebaseConfigured = validateFirebaseConfig(firebaseConfig);

if (!isFirebaseConfigured) {
  if (env.nodeEnv === "production") {
    throw new Error("[startup] Firebase es obligatorio en producción. Configura FIREBASE_* antes de iniciar.");
  }
  console.warn("[startup] Firebase env is incomplete. Falling back to in-memory state.");
}

export const firebaseApp = isFirebaseConfigured
  ? (getApps().length ? getApp() : initializeApp(firebaseConfig))
  : null;

export const firestore = isFirebaseConfigured
  ? initializeFirestore(firebaseApp, { ignoreUndefinedProperties: true })
  : null;

