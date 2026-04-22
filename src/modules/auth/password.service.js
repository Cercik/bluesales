import bcrypt from "bcryptjs";
import { env } from "../../config/env.js";

const BCRYPT_HASH_PATTERN = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

function asObject(value) {
  return value && typeof value === "object" ? value : {};
}

export function isBcryptHash(value) {
  return BCRYPT_HASH_PATTERN.test(String(value || "").trim());
}

export async function hashPassword(plainTextPassword) {
  const raw = String(plainTextPassword || "");
  if (!raw) throw new Error("Contrasena vacia.");
  return bcrypt.hash(raw, env.auth.passwordHashRounds);
}

export function withPasswordHash(worker, passwordHash) {
  const base = { ...asObject(worker) };
  delete base.password;
  return {
    ...base,
    passwordHash
  };
}

export async function migrateWorkerPassword(worker) {
  const base = asObject(worker);
  const currentHash = String(base.passwordHash || "").trim();
  const legacyPassword = String(base.password || "");

  if (isBcryptHash(currentHash)) {
    if (!("password" in base)) return { worker: base, changed: false };
    return { worker: withPasswordHash(base, currentHash), changed: true };
  }

  if (currentHash && !isBcryptHash(currentHash)) {
    const repairedHash = await hashPassword(currentHash);
    return { worker: withPasswordHash(base, repairedHash), changed: true };
  }

  if (isBcryptHash(legacyPassword)) {
    return { worker: withPasswordHash(base, legacyPassword), changed: true };
  }

  if (!legacyPassword) return { worker: base, changed: false };

  const nextHash = await hashPassword(legacyPassword);
  return { worker: withPasswordHash(base, nextHash), changed: true };
}

export async function verifyWorkerPassword(worker, plainTextPassword) {
  const base = asObject(worker);
  const candidate = String(plainTextPassword || "");
  const storedHash = String(base.passwordHash || "").trim();

  if (isBcryptHash(storedHash)) {
    const matches = await bcrypt.compare(candidate, storedHash);
    if (!matches) return { matches: false, needsMigration: false };

    const hasLegacyPasswordField = "password" in base;
    return {
      matches: true,
      needsMigration: hasLegacyPasswordField,
      worker: hasLegacyPasswordField ? withPasswordHash(base, storedHash) : base
    };
  }

  const legacyPassword = String(base.password || "");
  if (!legacyPassword) return { matches: false, needsMigration: false };
  if (legacyPassword !== candidate) return { matches: false, needsMigration: false };

  const nextHash = await hashPassword(candidate);
  return {
    matches: true,
    needsMigration: true,
    worker: withPasswordHash(base, nextHash)
  };
}
