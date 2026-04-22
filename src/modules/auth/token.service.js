import crypto from "node:crypto";
import { env } from "../../config/env.js";
import { isSessionRevokedInMemory, registerIssuedSession } from "./session-revocation.service.js";

function encode(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function decode(raw) {
  return JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
}

function sign(raw) {
  return crypto.createHmac("sha256", env.auth.tokenSecret).update(raw).digest("base64url");
}

export function createToken(payload) {
  const body = {
    ...payload,
    sid: crypto.randomUUID(),
    iat: Date.now(),
    exp: Date.now() + env.auth.tokenTtlMs
  };
  const encoded = encode(body);
  const signature = sign(encoded);
  registerIssuedSession(body);
  return `${encoded}.${signature}`;
}

export function verifyToken(token) {
  if (!token || !token.includes(".")) return null;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;
  const expected = sign(encoded);
  if (signature !== expected) return null;
  let payload;
  try {
    payload = decode(encoded);
  } catch {
    return null;
  }
  if (!payload?.exp || Date.now() > Number(payload.exp)) return null;
  if (!payload?.sid || typeof payload.sid !== "string") return null;
  if (isSessionRevokedInMemory(payload)) return null;
  return payload;
}

export function readBearerToken(req) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer") return null;
  return token || null;
}
