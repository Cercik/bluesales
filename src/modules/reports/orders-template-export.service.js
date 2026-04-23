import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";

const STATUS_LABELS = {
  pending_confirm: "Pendiente confirmación",
  price_published: "Precio publicado",
  requested: "Solicitado",
  approved: "Aprobado",
  ready: "Listo para entrega",
  delivered: "Entregado",
  cancelled: "Cancelado"
};

function toDate(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    const date = new Date(`${value.trim()}T00:00:00`);
    if (!Number.isNaN(date.getTime())) return date;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function formatDateCell(value) {
  const date = toDate(value);
  if (!date) return "";
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

function getIsoWeekNumber(dateValue) {
  const d = new Date(Date.UTC(dateValue.getFullYear(), dateValue.getMonth(), dateValue.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function getCycleDateFromKey(cycleKey) {
  if (!cycleKey || !/^\d{4}-\d{2}-\d{2}$/.test(String(cycleKey))) return null;
  const date = new Date(`${cycleKey}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function getOrderClosingWeek(order) {
  const cycleStart = getCycleDateFromKey(order?.cycleKey);
  if (cycleStart) {
    const end = new Date(cycleStart);
    end.setDate(cycleStart.getDate() + 5);
    return getIsoWeekNumber(end);
  }
  const created = toDate(order?.createdAt);
  return created ? getIsoWeekNumber(created) : "";
}

function ensureTemplateExists(templatePath) {
  return fs.access(templatePath);
}

function sanitizeOrders(input) {
  return (Array.isArray(input) ? input : []).map((order) => ({
    id: String(order?.id || "").trim(),
    cycleKey: String(order?.cycleKey || "").trim(),
    workerId: String(order?.workerId || "").trim(),
    workerName: String(order?.workerName || "").trim(),
    createdAt: String(order?.createdAt || "").trim(),
    deliveryDate: String(order?.deliveryDate || "").trim(),
    pricePerKg: Number(order?.pricePerKg || 0),
    kg: Number(order?.kg || 0),
    total: Number(order?.total || 0),
    status: String(order?.status || "").trim()
  }));
}

function resolveRange(orders, rangeFrom, rangeTo) {
  const fromInput = toDate(rangeFrom);
  const toInput = toDate(rangeTo);
  if (fromInput && toInput) return { from: fromInput, to: toInput };

  const dates = orders
    .map((order) => toDate(order.createdAt))
    .filter(Boolean)
    .sort((a, b) => a.getTime() - b.getTime());

  const now = new Date();
  if (!dates.length) return { from: fromInput || now, to: toInput || now };
  return {
    from: fromInput || dates[0],
    to: toInput || dates[dates.length - 1]
  };
}

export async function buildOrdersTemplateWorkbook({
  orders: rawOrders,
  rangeFrom,
  rangeTo
}) {
  const templatePath = path.join(process.cwd(), "templates", "Formato de venta arandano.xlsx");
  await ensureTemplateExists(templatePath);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(templatePath);
  const worksheet = workbook.getWorksheet("Hoja1") || workbook.worksheets[0];
  if (!worksheet) throw new Error("No se pudo abrir la hoja del formato.");

  const orders = sanitizeOrders(rawOrders);
  const range = resolveRange(orders, rangeFrom, rangeTo);
  worksheet.getCell("D9").value = formatDateCell(range.from);
  worksheet.getCell("H9").value = formatDateCell(range.to);

  const dataStartRow = 12;
  const dataEndRow = dataStartRow + Math.max(orders.length - 1, 0);

  orders.forEach((order, index) => {
    const row = dataStartRow + index;
    const pricePerKg = Number.isFinite(order.pricePerKg) ? order.pricePerKg : 0;
    const kg = Number.isFinite(order.kg) ? order.kg : 0;
    const total = Number.isFinite(order.total) && order.total > 0 ? order.total : Number((pricePerKg * kg).toFixed(2));

    worksheet.getCell(`A${row}`).value = `Semana ${getOrderClosingWeek(order)}`;
    worksheet.getCell(`B${row}`).value = formatDateCell(order.createdAt);
    worksheet.getCell(`C${row}`).value = order.workerId;
    worksheet.getCell(`D${row}`).value = order.workerName;
    worksheet.getCell(`E${row}`).value = "Kg";
    worksheet.getCell(`F${row}`).value = STATUS_LABELS[order.status] || order.status || "-";
    worksheet.getCell(`G${row}`).value = formatDateCell(order.deliveryDate);
    worksheet.getCell(`H${row}`).value = Number(pricePerKg.toFixed(2));
    worksheet.getCell(`I${row}`).value = Number(kg.toFixed(2));
    worksheet.getCell(`J${row}`).value = Number(total.toFixed(2));

    worksheet.getCell(`H${row}`).numFmt = "#,##0.00";
    worksheet.getCell(`I${row}`).numFmt = "#,##0.00";
    worksheet.getCell(`J${row}`).numFmt = "#,##0.00";
  });

  const tableRowEnd = Math.max(21, dataEndRow || 21);
  if (Array.isArray(worksheet.model.tables) && worksheet.model.tables[0]) {
    worksheet.model.tables[0].tableRef = `A11:J${tableRowEnd}`;
    worksheet.model.tables[0].autoFilterRef = `A11:J${tableRowEnd}`;
  }

  return workbook;
}
