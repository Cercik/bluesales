import { env } from "../../config/env.js";

function normalizeWhatsappTarget(rawPhone) {
  const raw = String(rawPhone || "").trim();
  if (!raw) return "";
  if (raw.includes("@")) return raw;
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  return `${digits}@s.whatsapp.net`;
}

function isConfigured() {
  return Boolean(env.whatsapp.enabled && env.whatsapp.apiToken && env.whatsapp.deviceId);
}

function buildHeaders() {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${env.whatsapp.apiToken}`,
    "device-id": env.whatsapp.deviceId
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function extractMessageId(payload) {
  return String(
    payload?.results?.id
    || payload?.results?.message_id
    || payload?.results?.key?.id
    || ""
  ).trim();
}

function extractErrorMessage(payload, fallback) {
  return String(payload?.error || payload?.message || fallback || "No se pudo enviar mensaje por WhatsApp.").trim();
}

export async function sendWhatsappTextMessage({ phone, message }) {
  const text = String(message || "").trim();
  const target = normalizeWhatsappTarget(phone);
  if (!text) {
    return { ok: false, skipped: true, reason: "empty_message", error: "Mensaje vacio." };
  }
  if (!target) {
    return { ok: false, skipped: true, reason: "invalid_phone", error: "Numero destino invalido." };
  }
  if (!isConfigured()) {
    return { ok: false, skipped: true, reason: "not_configured", error: "Integracion WhatsApp no configurada." };
  }

  const endpoint = `${env.whatsapp.apiBaseUrl}/send/message`;
  let response;
  try {
    response = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify({
          phone: target,
          message: text
        })
      },
      env.whatsapp.timeoutMs
    );
  } catch {
    return { ok: false, status: 503, error: "No se pudo conectar con WhatsApp APISPERU." };
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: extractErrorMessage(payload, `Error HTTP ${response.status} al enviar WhatsApp.`)
    };
  }

  return {
    ok: true,
    status: response.status,
    code: String(payload?.code || ""),
    providerMessage: String(payload?.message || ""),
    messageId: extractMessageId(payload),
    target
  };
}

