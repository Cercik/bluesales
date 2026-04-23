import { env } from "../../config/env.js";

function isEnabled() {
  return env.dniValidation.enabled;
}

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getValueByPath(obj, path) {
  return path.split(".").reduce((acc, key) => (acc && typeof acc === "object" ? acc[key] : undefined), obj);
}

function getFirstStringByPaths(obj, paths) {
  for (const path of paths) {
    const raw = getValueByPath(obj, path);
    const text = String(raw || "").trim();
    if (text) return text;
  }
  return "";
}

function buildNameFromParts(source) {
  if (!source || typeof source !== "object") return "";
  const firstNames = getFirstStringByPaths(source, ["nombres", "nombre", "prenombres", "firstName"]);
  const fatherLastName = getFirstStringByPaths(source, ["apellidoPaterno", "apellido_paterno", "apePaterno", "lastName"]);
  const motherLastName = getFirstStringByPaths(source, ["apellidoMaterno", "apellido_materno", "apeMaterno", "secondLastName"]);
  return [firstNames, fatherLastName, motherLastName].filter(Boolean).join(" ").trim();
}

function extractNameParts(payload) {
  const containers = [payload, payload?.data, payload?.result, payload?.resultado].filter(Boolean);
  for (const source of containers) {
    const nombres = getFirstStringByPaths(source, ["nombres", "nombre", "prenombres", "firstName"]);
    const apellidoPaterno = getFirstStringByPaths(source, ["apellidoPaterno", "apellido_paterno", "apePaterno", "lastName"]);
    const apellidoMaterno = getFirstStringByPaths(source, ["apellidoMaterno", "apellido_materno", "apeMaterno", "secondLastName"]);
    if (nombres || apellidoPaterno || apellidoMaterno) {
      return { nombres, apellidoPaterno, apellidoMaterno };
    }
  }
  return { nombres: "", apellidoPaterno: "", apellidoMaterno: "" };
}

function extractOfficialName(payload) {
  const directName = getFirstStringByPaths(payload, [
    "nombreCompleto",
    "nombre_completo",
    "fullName",
    "nombre",
    "data.nombreCompleto",
    "data.nombre_completo",
    "data.fullName",
    "data.nombre",
    "result.nombreCompleto",
    "result.nombre_completo",
    "result.fullName",
    "result.nombre"
  ]);
  if (directName) return directName;

  const containers = [payload, payload?.data, payload?.result, payload?.resultado];
  for (const container of containers) {
    const built = buildNameFromParts(container);
    if (built) return built;
  }
  return "";
}

function extractDocumentNumber(payload) {
  return getFirstStringByPaths(payload, [
    "dni",
    "numeroDocumento",
    "numero_documento",
    "num_documento",
    "numero",
    "documento",
    "data.dni",
    "data.numeroDocumento",
    "data.numero_documento",
    "data.num_documento",
    "result.dni",
    "result.numeroDocumento",
    "result.numero_documento",
    "result.num_documento"
  ]);
}

function namesMatch(expected, official) {
  const expectedNorm = normalizeName(expected);
  const officialNorm = normalizeName(official);
  if (!expectedNorm || !officialNorm) return false;
  if (expectedNorm === officialNorm) return true;
  if (officialNorm.includes(expectedNorm) || expectedNorm.includes(officialNorm)) return true;

  const expectedTokens = expectedNorm.split(" ").filter(Boolean);
  const officialTokens = new Set(officialNorm.split(" ").filter(Boolean));
  if (expectedTokens.length < 2) return false;
  return expectedTokens.every((token) => officialTokens.has(token));
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function buildUrl(dni) {
  let template = env.dniValidation.apiUrlTemplate;
  if (!template) return null;
  const lookupToken = env.dniValidation.apiToken || env.dniValidation.apiKey;
  if (template.includes("{token}")) {
    template = template.replaceAll("{token}", encodeURIComponent(lookupToken));
  }
  if (template.includes("{dni}")) return template.replaceAll("{dni}", encodeURIComponent(dni));
  if (/\/dni\/\d{8}(?=[/?]|$)/.test(template)) {
    return template.replace(/\/dni\/\d{8}(?=[/?]|$)/, `/dni/${encodeURIComponent(dni)}`);
  }
  const separator = template.includes("?") ? "&" : "?";
  return `${template}${separator}dni=${encodeURIComponent(dni)}`;
}

function buildHeaders() {
  const headers = { Accept: "application/json" };
  if (env.dniValidation.apiToken) {
    headers.Authorization = env.dniValidation.apiAuthScheme
      ? `${env.dniValidation.apiAuthScheme} ${env.dniValidation.apiToken}`
      : env.dniValidation.apiToken;
  }
  if (env.dniValidation.apiKey && env.dniValidation.apiKeyHeader) {
    headers[env.dniValidation.apiKeyHeader] = env.dniValidation.apiKey;
  }
  return headers;
}

export async function validateWorkerIdentity({ dni, fullName }) {
  if (!isEnabled()) return { ok: true, skipped: true };
  const identity = await lookupDniIdentity(dni);
  if (!identity.ok) return identity;
  if (env.dniValidation.strictNameMatch && !namesMatch(fullName, identity.officialName)) {
    return {
      ok: false,
      status: 422,
      message: "El nombre ingresado no coincide con el DNI consultado."
    };
  }
  return { ok: true, officialName: identity.officialName };
}

export async function lookupDniIdentity(dni) {
  if (!isEnabled()) {
    return { ok: false, status: 503, message: "La validacion de DNI no esta habilitada." };
  }

  const url = buildUrl(dni);
  if (!url) {
    return { ok: false, status: 500, message: "Validacion DNI activa, pero falta SUNAT_DNI_API_URL_TEMPLATE." };
  }

  let response;
  try {
    response = await fetchWithTimeout(url, { method: "GET", headers: buildHeaders() }, env.dniValidation.timeoutMs);
  } catch {
    return { ok: false, status: 503, message: "No se pudo conectar al servicio de validacion DNI." };
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const apiMessage = String(payload?.message || payload?.error || "").trim();
    return {
      ok: false,
      status: response.status === 404 ? 422 : 503,
      message: apiMessage || "No se pudo validar el DNI con el servicio externo."
    };
  }

  const officialDni = extractDocumentNumber(payload);
  if (officialDni && String(officialDni).trim() !== String(dni).trim()) {
    return { ok: false, status: 422, message: "El DNI consultado no coincide con la respuesta de validacion." };
  }

  const nameParts = extractNameParts(payload);
  const fullNameFromParts = [nameParts.nombres, nameParts.apellidoPaterno, nameParts.apellidoMaterno].filter(Boolean).join(" ").trim();
  const officialName = fullNameFromParts || extractOfficialName(payload);
  if (!officialName) {
    return { ok: false, status: 503, message: "El servicio de validacion no devolvio nombre del DNI consultado." };
  }

  return {
    ok: true,
    dni: officialDni || String(dni).trim(),
    officialName,
    nameParts
  };
}
