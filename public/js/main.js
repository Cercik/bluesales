const API_BASE = "/api";
const SESSION_KEY = "bluesales_session_v3";
const PRIVACY_POLICY_PATH = "/privacy.html";
const PRIVACY_POLICY_VERSION = "2026-04-23";

const STATUS_LABELS = {
  pending_confirm: "Pendiente confirmación",
  price_published: "Precio publicado",
  requested: "Solicitado",
  approved: "Aprobado",
  ready: "Listo para entrega",
  delivered: "Entregado",
  cancelled: "Cancelado"
};

const state = {
  data: buildDefaultState(),
  session: loadSession(),
  activeNotice: null,
  adminView: "home",
  adminUsers: [],
  editingNoticeId: null,
  warnedMemoryStorage: false
};

let saveTimer = null;
let workerDniLookupSeq = 0;
let workerDniLookupManualMode = false;

    function isAdminRole(role) {
      return role === "admin" || role === "super_admin";
    }

    function isSuperAdminSession() {
      return state.session?.role === "super_admin";
    }

    function uid(prefix) {
      return prefix + "_" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
    }

    function todayISO() {
      const d = new Date();
      return d.toISOString().slice(0, 10);
    }

    function formatDateTime(iso) {
      const d = new Date(iso);
      return d.toLocaleString("es-PE", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      });
    }
    function formatDate(iso) {
      const d = new Date(iso);
      return d.toLocaleDateString("es-PE", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      });
    }
    function getIsoWeekNumber(date = new Date()) {
      const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
      const day = d.getUTCDay() || 7;
      d.setUTCDate(d.getUTCDate() + 4 - day);
      const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
      return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    }
    function toLocalDateKey(date) {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, "0");
      const d = String(date.getDate()).padStart(2, "0");
      return y + "-" + m + "-" + d;
    }
    function getOrderClosingWeek(order) {
      const cycleKey = getOrderCycleKey(order);
      const range = getCycleDateRangeByKey(cycleKey);
      return getIsoWeekNumber(range?.end || new Date(order.createdAt));
    }

    function getCycleRange(reference) {
      const d = new Date(reference);
      d.setHours(0, 0, 0, 0);
      let diff = d.getDay() - 3;
      if (diff < 0) diff += 7;
      const start = new Date(d);
      start.setDate(d.getDate() - diff);
      const end = new Date(start);
      end.setDate(start.getDate() + 5);
      end.setHours(23, 59, 59, 999);
      return { start, end };
    }
    function getCycleKey(now = new Date()) {
      const { start } = getCycleRange(now);
      return toLocalDateKey(start);
    }
    function getCycleDateFromKey(cycleKey) {
      if (!cycleKey || !/^\d{4}-\d{2}-\d{2}$/.test(cycleKey)) return null;
      const date = new Date(cycleKey + "T00:00:00");
      if (Number.isNaN(date.getTime())) return null;
      date.setHours(0, 0, 0, 0);
      return date;
    }
    function getNormalizedCycleKeyFromInput(dateStr) {
      const base = getCycleDateFromKey(dateStr);
      if (!base) return "";
      return getCycleKey(base);
    }
    function getOrderCycleKey(order) {
      if (order?.cycleKey) return order.cycleKey;
      return getCycleKey(new Date(order?.createdAt || new Date()));
    }
    function isPastCycle(cycleKey, now = new Date()) {
      const cycleDate = getCycleDateFromKey(cycleKey);
      const currentDate = getCycleDateFromKey(getCycleKey(now));
      if (!cycleDate || !currentDate) return false;
      return cycleDate.getTime() < currentDate.getTime();
    }
    function getCycleDateRangeByKey(cycleKey) {
      const start = getCycleDateFromKey(cycleKey);
      if (!start) return null;
      const end = new Date(start);
      end.setDate(start.getDate() + 5);
      end.setHours(23, 59, 59, 999);
      return { start, end };
    }
    function getDeliveryFridayForCycleKey(cycleKey) {
      const start = getCycleDateFromKey(cycleKey);
      if (!start) return new Date().toISOString();
      const delivery = new Date(start);
      delivery.setDate(start.getDate() + 9);
      delivery.setHours(0, 0, 0, 0);
      return delivery.toISOString();
    }

    function isOrderWindowOpen(now = new Date()) {
      const { start, end } = getCycleRange(now);
      return now >= start && now <= end;
    }

    function getWeeklyPriceEntry(cycleKey) {
      if (!state.data.settings.weeklyPrices || typeof state.data.settings.weeklyPrices !== "object") {
        state.data.settings.weeklyPrices = {};
      }
      const entry = state.data.settings.weeklyPrices[cycleKey];
      if (!entry || typeof entry !== "object") {
        state.data.settings.weeklyPrices[cycleKey] = { pricePerKg: 0, published: false };
      }
      return state.data.settings.weeklyPrices[cycleKey];
    }
    function getPricePerKg(cycleKey = getCycleKey(new Date())) {
      return numeric(getWeeklyPriceEntry(cycleKey).pricePerKg);
    }
    function isPricePublished(cycleKey = getCycleKey(new Date())) {
      return Boolean(getWeeklyPriceEntry(cycleKey).published) && getPricePerKg(cycleKey) > 0;
    }
    function isPricePublishedForOrder(order) {
      return isPricePublished(getOrderCycleKey(order));
    }
    function syncLegacyPriceFields() {
      const currentCycle = getCycleKey(new Date());
      state.data.settings.pricePerKg = getPricePerKg(currentCycle);
      state.data.settings.pricePublishedCycle = isPricePublished(currentCycle) ? currentCycle : "";
    }
    function getPendingConfirmDeadline(reference) {
      const cycleKey = typeof reference === "string" ? reference : getCycleKey(new Date(reference));
      const range = getCycleDateRangeByKey(cycleKey);
      const deadline = range ? new Date(range.end) : new Date();
      deadline.setHours(23, 59, 59, 999);
      return deadline;
    }
    function isBeforePendingDeadline(order, now = new Date()) {
      return now < getPendingConfirmDeadline(getOrderCycleKey(order));
    }
    function getRemainingDeadlineText(order, now = new Date()) {
      const deadline = getPendingConfirmDeadline(getOrderCycleKey(order));
      const ms = deadline.getTime() - now.getTime();
      if (ms <= 0) return "Plazo vencido";
      const hours = Math.floor(ms / (1000 * 60 * 60));
      const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
      return `Tiempo restante para confirmar: ${hours}h ${minutes}m`;
    }
    function syncPendingOrderPrices() {
      let changed = false;
      state.data.orders.forEach((o) => {
        if (o.status !== "price_published") return;
        const cycleKey = getOrderCycleKey(o);
        const pricePerKg = getPricePerKg(cycleKey);
        const nextTotal = numeric(o.kg) * pricePerKg;
        const priceChanged = Math.abs(numeric(o.pricePerKg) - pricePerKg) > 0.0001;
        const totalChanged = Math.abs(numeric(o.total) - nextTotal) > 0.0001;
        if (priceChanged || totalChanged) {
          o.pricePerKg = pricePerKg;
          o.total = nextTotal;
          changed = true;
        }
      });
      return changed;
    }
    function syncPricePublishedStatuses() {
      let changed = false;
      state.data.orders.forEach((o) => {
        if (!["pending_confirm", "price_published"].includes(o.status)) return;
        const published = isPricePublishedForOrder(o);
        const nextStatus = published ? "price_published" : "pending_confirm";
        if (o.status !== nextStatus) {
          o.status = nextStatus;
          changed = true;
        }
      });
      return changed;
    }
    function autoCancelExpiredPendingOrders(now = new Date()) {
      let changed = false;
      state.data.orders.forEach((o) => {
        if (!["pending_confirm", "price_published"].includes(o.status)) return;
        if (isBeforePendingDeadline(o, now)) return;
        o.status = "cancelled";
        o.cancelledAt = now.toISOString();
        o.cancelReason = "No confirmo su compra hasta el lunes a las 23:59.";
        addNotification(o);
        recordOrderHistory(o, "auto_cancelled", o.cancelReason);
        changed = true;
      });
      return changed;
    }

    function numeric(value) {
      return Number.parseFloat(value || 0);
    }
    function buildDefaultState() {
      const cycleKey = getCycleKey(new Date());
      return {
        settings: {
          pricePerKg: 22,
          pricePublishedCycle: "",
          weeklyPrices: {
            [cycleKey]: {
              pricePerKg: 22,
              published: false
            }
          },
          notificationTemplates: {
            whatsapp: "BlueSales: tu pedido {{orderId}} ahora está en estado {{status}}. Entrega estimada: {{deliveryDate}}.",
            email: "BlueSales: tu pedido {{orderId}} ahora está en estado {{status}}. Entrega estimada: {{deliveryDate}}."
          }
        },
        notices: [
          {
            id: uid("notice"),
            title: "Campana de cosecha 2026",
            summary: "Inicia el 20 de abril. Revise turno actualizado.",
            content: "Inicio oficial: 20 de abril de 2026.\n\nSe pide puntualidad y registro de asistencia.\nEl cronograma de turnos se valida con RR.HH.",
            area: "RR.HH.",
            publishDate: todayISO(),
            archived: false,
            createdAt: new Date().toISOString()
          },
          {
            id: uid("notice"),
            title: "Control de calidad",
            summary: "Nuevo protocolo de empaque entra en vigencia.",
            content: "Se refuerza verificacion de calibre, firmeza y temperatura.\nRegistrar observaciones en formato QC-04.",
            area: "Calidad",
            publishDate: todayISO(),
            archived: false,
            createdAt: new Date().toISOString()
          }
        ],
        users: [],
        orders: [],
        notifications: [],
        orderHistory: [],
        noticeReads: {},
        demoSeedVersion: 1
      };
    }

    function ensureStateDefaults(data) {
      if (!data.settings) data.settings = {};
      if (!("pricePerKg" in data.settings)) {
        if ("nationalPrice" in data.settings) data.settings.pricePerKg = numeric(data.settings.nationalPrice);
        else data.settings.pricePerKg = 22;
      }
      if (!("pricePublishedCycle" in data.settings)) data.settings.pricePublishedCycle = "";
      if (!data.settings.weeklyPrices || typeof data.settings.weeklyPrices !== "object") data.settings.weeklyPrices = {};
      Object.keys(data.settings.weeklyPrices).forEach((key) => {
        const row = data.settings.weeklyPrices[key];
        if (!row || typeof row !== "object") {
          data.settings.weeklyPrices[key] = { pricePerKg: 0, published: false };
          return;
        }
        data.settings.weeklyPrices[key] = {
          pricePerKg: numeric(row.pricePerKg),
          published: Boolean(row.published)
        };
      });
      const currentCycle = getCycleKey(new Date());
      if (!data.settings.weeklyPrices[currentCycle]) {
        data.settings.weeklyPrices[currentCycle] = {
          pricePerKg: numeric(data.settings.pricePerKg),
          published: false
        };
      }
      if (data.settings.pricePublishedCycle) {
        const publishedCycle = data.settings.pricePublishedCycle;
        if (!data.settings.weeklyPrices[publishedCycle]) {
          data.settings.weeklyPrices[publishedCycle] = {
            pricePerKg: numeric(data.settings.pricePerKg),
            published: true
          };
        } else {
          data.settings.weeklyPrices[publishedCycle].published = true;
          if (numeric(data.settings.weeklyPrices[publishedCycle].pricePerKg) <= 0) {
            data.settings.weeklyPrices[publishedCycle].pricePerKg = numeric(data.settings.pricePerKg);
          }
        }
      }
      if (!data.settings.notificationTemplates) {
        data.settings.notificationTemplates = {
          whatsapp: "BlueSales: tu pedido {{orderId}} ahora está en estado {{status}}. Entrega estimada: {{deliveryDate}}.",
          email: "BlueSales: tu pedido {{orderId}} ahora está en estado {{status}}. Entrega estimada: {{deliveryDate}}."
        };
      }
      if (!Array.isArray(data.users)) data.users = [];
      data.users = data.users.map((worker) => {
        const safeWorker = worker && typeof worker === "object" ? worker : {};
        return { ...safeWorker, active: safeWorker.active !== false };
      });
      if (!Array.isArray(data.orderHistory)) data.orderHistory = [];
      if (!Array.isArray(data.orders)) data.orders = [];
      data.orders.forEach((order) => {
        if (!order.cycleKey) order.cycleKey = getCycleKey(new Date(order.createdAt || new Date()));
        if (!order.deliveryDate) order.deliveryDate = getDeliveryFridayForCycleKey(order.cycleKey);
      });
      syncLegacyPriceFields();
      return data;
    }

    async function loadData() {
      if (!state.session?.token) return null;
      const response = await fetch(`${API_BASE}/state`, {
        headers: state.session?.token ? { Authorization: "Bearer " + state.session.token } : {}
      });
      if (response.status === 401) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (payload?.data && payload.data.settings && payload.data.orders && payload.data.notices) {
        return payload.data;
      }
      throw new Error("Respuesta inválida del servidor.");
    }

    function saveData() {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        try {
          const response = await fetch(`${API_BASE}/state`, {
            method: "PUT",
            headers: getAuthHeaders(),
            body: JSON.stringify({ data: state.data })
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const payload = await response.json().catch(() => ({}));
          if (payload?.storage === "memory" && !state.warnedMemoryStorage) {
            state.warnedMemoryStorage = true;
            showToast("Firebase no está configurado. Los cambios se guardan solo en memoria.", "error", 4200);
          }
          if (payload?.storage === "firestore" && state.warnedMemoryStorage) {
            state.warnedMemoryStorage = false;
          }
        } catch (error) {
          console.warn("No se pudo guardar en API.", error);
          showToast("No se pudo guardar en base de datos. Intenta nuevamente.", "error");
        }
      }, 120);
    }

    function saveSession(session) {
      if (!session) localStorage.removeItem(SESSION_KEY);
      else localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      state.session = session;
    }

    function loadSession() {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    }

    function getWorkerWeeklyKg(workerId) {
      const { start, end } = getCycleRange(new Date());
      return state.data.orders
        .filter((o) => o.workerId === workerId && o.status !== "cancelled")
        .filter((o) => {
          const t = new Date(o.createdAt);
          return t >= start && t <= end;
        })
        .reduce((s, o) => s + numeric(o.kg), 0);
    }

    function getWorkerYearKg(workerId) {
      const year = new Date().getFullYear();
      return state.data.orders
        .filter((o) => o.workerId === workerId && o.status !== "cancelled")
        .filter((o) => new Date(o.createdAt).getFullYear() === year)
        .reduce((s, o) => s + numeric(o.kg), 0);
    }

    function getVisibleNotices() {
      const t = todayISO();
      return state.data.notices.filter((n) => !n.archived && n.publishDate <= t).sort((a, b) => (a.publishDate < b.publishDate ? 1 : -1));
    }

    function escapeHtml(text) {
      return String(text || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    function isValidDni(dni) {
      return /^\d{8}$/.test(dni);
    }
    function isValidEmail(email) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }
    function normalizePhone(phone) {
      return String(phone || "").replace(/\D/g, "");
    }
    function normalizeForSearch(value) {
      return String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim();
    }
    function isValidPhone(phone) {
      const normalized = normalizePhone(phone);
      return normalized.length >= 9 && normalized.length <= 12;
    }
    function showToast(message, type = "info", timeout = 3200) {
      const stack = document.getElementById("toastStack");
      if (!stack) return;
      const item = document.createElement("div");
      item.className = "toast " + type;
      item.textContent = message;
      stack.appendChild(item);
      setTimeout(() => {
        item.style.opacity = "0";
        item.style.transform = "translateY(8px)";
        setTimeout(() => item.remove(), 180);
      }, timeout);
    }
    function getAuthHeaders() {
      const token = state.session?.token;
      if (!token) return { "Content-Type": "application/json" };
      return { "Content-Type": "application/json", Authorization: "Bearer " + token };
    }
    function applyTemplate(template, order) {
      return String(template || "")
        .replaceAll("{{orderId}}", order.id || "-")
        .replaceAll("{{status}}", STATUS_LABELS[order.status] || order.status || "-")
        .replaceAll("{{deliveryDate}}", formatDate(order.deliveryDate || new Date().toISOString()));
    }
    function recordOrderHistory(order, action, detail = "") {
      if (!Array.isArray(state.data.orderHistory)) state.data.orderHistory = [];
      const actor = state.session
        ? (isAdminRole(state.session.role)
          ? (state.session.role + ":" + (state.session.id || "admin"))
          : (state.session.id || "worker"))
        : "system";
      state.data.orderHistory.unshift({
        id: uid("hist"),
        orderId: String(order?.id || "-"),
        workerId: String(order?.workerId || ""),
        workerName: String(order?.workerName || ""),
        action: String(action || "").trim() || "updated",
        detail: String(detail || "").trim(),
        actor,
        createdAt: new Date().toISOString()
      });
      if (state.data.orderHistory.length > 1000) {
        state.data.orderHistory = state.data.orderHistory.slice(0, 1000);
      }
    }

    function renderSession() {
      const info = document.getElementById("sessionInfo");
      const authToggleGroup = document.getElementById("authToggleGroup");
      const profileMenu = document.getElementById("profileMenu");
      const profileTrigger = document.getElementById("profileTrigger");
      if (!state.session) {
        info.textContent = "No has iniciado sesión.";
        if (authToggleGroup) authToggleGroup.classList.remove("hidden");
        if (profileMenu) profileMenu.classList.add("hidden");
        closeProfileDropdown();
        return;
      }
      if (isAdminRole(state.session.role)) {
        const title = state.session.role === "super_admin" ? "Super Administrador" : "Administrador";
        info.textContent = "Sesión: " + title + " (" + (state.session.username || state.session.id || "-") + ")";
      } else {
        info.textContent = "Sesión: " + state.session.name + " (" + state.session.id + ")";
      }
      if (authToggleGroup) authToggleGroup.classList.add("hidden");
      if (profileMenu) profileMenu.classList.remove("hidden");
      if (profileTrigger) profileTrigger.setAttribute("aria-expanded", "false");
    }

    function closeProfileDropdown() {
      const dropdown = document.getElementById("profileDropdown");
      const trigger = document.getElementById("profileTrigger");
      if (dropdown) dropdown.classList.add("hidden");
      if (trigger) trigger.setAttribute("aria-expanded", "false");
    }

    function toggleProfileDropdown() {
      const dropdown = document.getElementById("profileDropdown");
      const trigger = document.getElementById("profileTrigger");
      if (!dropdown || !trigger || !state.session) return;
      const opening = dropdown.classList.contains("hidden");
      if (opening) {
        dropdown.classList.remove("hidden");
        trigger.setAttribute("aria-expanded", "true");
        return;
      }
      closeProfileDropdown();
    }

    function showProfileInfo() {
      if (!state.session) return;
      const info = isAdminRole(state.session.role)
        ? ("Perfil: " + (state.session.role === "super_admin" ? "Super Administrador" : "Administrador") + " | Usuario: " + (state.session.username || state.session.id || "-"))
        : "Perfil: " + (state.session.name || "Trabajador") + " | DNI: " + (state.session.id || "-");
      closeProfileDropdown();
      showToast(info, "info", 4500);
    }

    function renderPanels() {
      const login = document.getElementById("loginPanels");
      const worker = document.getElementById("workerApp");
      const admin = document.getElementById("adminApp");
      if (!state.session) {
        login.classList.remove("hidden");
        worker.classList.add("hidden");
        admin.classList.add("hidden");
        return;
      }
      login.classList.add("hidden");
      if (isAdminRole(state.session.role)) {
        admin.classList.remove("hidden");
        worker.classList.add("hidden");
        renderAdmin();
      } else {
        worker.classList.remove("hidden");
        admin.classList.add("hidden");
        renderWorker();
      }
    }

    function renderAdminNavigation() {
      const viewMap = {
        home: "adminViewHome",
        new_notice: "adminViewNewNotice",
        manage_notices: "adminViewManageNotices",
        prices: "adminViewPrices",
        orders: "adminViewOrders",
        workers: "adminViewWorkers",
        notifications: "adminViewNotifications",
        admins: "adminViewAdmins"
      };
      const requested = viewMap[state.adminView] ? state.adminView : "home";
      const current = !isSuperAdminSession() && requested === "admins" ? "home" : requested;
      if (current !== state.adminView) state.adminView = "home";

      document.querySelectorAll("[data-super-admin-only]").forEach((element) => {
        element.classList.toggle("hidden", !isSuperAdminSession());
      });

      Object.entries(viewMap).forEach(([key, elementId]) => {
        const section = document.getElementById(elementId);
        if (!section) return;
        section.classList.toggle("hidden", key !== current);
      });

      document.querySelectorAll("[data-admin-view]").forEach((button) => {
        button.classList.toggle("is-active", button.dataset.adminView === current);
      });
    }

    function setAdminView(view) {
      state.adminView = view || "home";
      closeAdminDropdowns();
      if (state.adminView === "admins" && isSuperAdminSession()) {
        loadAdminUsers().then(() => renderAll());
      }
      renderAll();
    }
    function closeAdminDropdowns() {
      document.querySelectorAll(".admin-dropdown.is-open").forEach((dropdown) => {
        dropdown.classList.remove("is-open");
        const trigger = dropdown.querySelector(".admin-dropdown-trigger");
        if (trigger) trigger.setAttribute("aria-expanded", "false");
      });
    }
    function toggleAdminDropdown(trigger) {
      const dropdown = trigger?.closest(".admin-dropdown");
      if (!dropdown) return;
      const willOpen = !dropdown.classList.contains("is-open");
      closeAdminDropdowns();
      if (!willOpen) return;
      dropdown.classList.add("is-open");
      trigger.setAttribute("aria-expanded", "true");
    }

    function clearWorkerFilters() {
      const ids = ["filterWorkerDni", "filterWorkerName", "filterWorkerContact"];
      ids.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = "";
      });
      renderAll();
    }

    function clearOrderFilters() {
      const ids = ["filterOrderDni", "filterOrderStatus", "filterOrderFrom", "filterOrderTo"];
      ids.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = "";
      });
      renderAll();
    }

    function getFilteredAdminOrders(adminSearchValue = null) {
      const adminSearch = adminSearchValue == null
        ? normalizeForSearch(document.getElementById("adminGlobalSearch")?.value || "")
        : adminSearchValue;
      const filterDni = (document.getElementById("filterOrderDni")?.value || "").trim();
      const filterStatus = (document.getElementById("filterOrderStatus")?.value || "").trim();
      const filterFrom = (document.getElementById("filterOrderFrom")?.value || "").trim();
      const filterTo = (document.getElementById("filterOrderTo")?.value || "").trim();

      return [...state.data.orders]
        .filter((o) => {
          if (adminSearch) {
            const bag = normalizeForSearch([o.id, o.workerId, o.workerName, o.workerEmail, o.workerPhone].join(" "));
            if (!bag.includes(adminSearch)) return false;
          }
          if (filterDni && !String(o.workerId || "").includes(filterDni)) return false;
          if (filterStatus && o.status !== filterStatus) return false;
          if (filterFrom) {
            const from = new Date(filterFrom + "T00:00:00");
            if (new Date(o.createdAt) < from) return false;
          }
          if (filterTo) {
            const to = new Date(filterTo + "T23:59:59");
            if (new Date(o.createdAt) > to) return false;
          }
          return true;
        })
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    }

    async function exportFilteredOrdersToExcel() {
      const orders = getFilteredAdminOrders();
      if (!orders.length) return showToast("No hay pedidos para exportar con los filtros actuales.", "info");

      const filterFrom = String(document.getElementById("filterOrderFrom")?.value || "").trim();
      const filterTo = String(document.getElementById("filterOrderTo")?.value || "").trim();
      const payload = {
        rangeFrom: filterFrom || "",
        rangeTo: filterTo || "",
        orders: orders.map((o) => ({
          id: o.id,
          cycleKey: getOrderCycleKey(o),
          workerId: o.workerId || "",
          workerName: o.workerName || "",
          createdAt: o.createdAt || "",
          deliveryDate: o.deliveryDate || "",
          pricePerKg: numeric(o.pricePerKg),
          kg: numeric(o.kg),
          total: numeric(o.total),
          status: o.status || ""
        }))
      };

      try {
        const response = await fetch(`${API_BASE}/reports/orders/export-template`, {
          method: "POST",
          headers: getAuthHeaders(),
          body: JSON.stringify(payload)
        });
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new Error(error.message || "No se pudo exportar el formato.");
        }

        const blob = await response.blob();
        const disposition = response.headers.get("content-disposition") || "";
        const match = disposition.match(/filename=\"?([^\";]+)\"?/i);
        const fileName = match?.[1] || ("formato_venta_arándano_" + todayISO() + ".xlsx");
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1200);
        showToast("Excel exportado con el formato solicitado.", "success");
      } catch (error) {
        showToast(error.message || "No se pudo exportar el Excel.", "error");
      }
    }

    function clearNotificationFilters() {
      const ids = ["filterNotifWorker", "filterNotifChannel", "filterNotifSent", "filterNotifFrom", "filterNotifTo"];
      ids.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = "";
      });
      renderAll();
    }
    async function loginWithApi(payload) {
      const response = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.message || "No se pudo iniciar sesión.");
      }
      return response.json();
    }
    async function validateSession() {
      if (!state.session?.token) return;
      try {
        const response = await fetch(`${API_BASE}/auth/me`, {
          headers: { Authorization: "Bearer " + state.session.token }
        });
        if (!response.ok) throw new Error("Sesión inválida");
        const payload = await response.json().catch(() => ({}));
        if (payload?.profile && typeof payload.profile === "object") {
          saveSession({
            ...state.session,
            ...payload.profile,
            token: state.session.token
          });
        }
      } catch {
        saveSession(null);
        showToast("La sesión expiró. Inicia sesión nuevamente.", "error");
      }
    }

    async function loadAdminUsers() {
      if (!isSuperAdminSession()) {
        state.adminUsers = [];
        return;
      }
      try {
        const response = await fetch(`${API_BASE}/admin/users`, {
          headers: getAuthHeaders()
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.message || "No se pudo cargar la lista de administradores.");
        }
        state.adminUsers = Array.isArray(payload.admins) ? payload.admins : [];
      } catch (error) {
        state.adminUsers = [];
        showToast(error.message || "No se pudo cargar la lista de administradores.", "error");
      }
    }

    function renderAdminUsers() {
      const section = document.getElementById("adminViewAdmins");
      if (!section) return;
      if (!isSuperAdminSession()) return;

      const body = document.getElementById("adminUsersBody");
      if (!body) return;

      const admins = Array.isArray(state.adminUsers) ? state.adminUsers : [];
      body.innerHTML = admins.length
        ? admins.map((row) => {
          const roleLabel = row.role === "super_admin" ? "Super administrador" : "Administrador";
          return "<tr>" +
            "<td>" + escapeHtml(row.username || "-") + "</td>" +
            "<td>" + escapeHtml(row.name || "-") + "</td>" +
            "<td>" + roleLabel + "</td>" +
            "<td>" + (row.active === false ? "Inhabilitado" : "Activo") + "</td>" +
            "<td>" + (row.createdAt ? formatDateTime(row.createdAt) : "-") + "</td>" +
            "<td>" + (row.lastLoginAt ? formatDateTime(row.lastLoginAt) : "-") + "</td>" +
            "</tr>";
        }).join("")
        : "<tr><td colspan='6' class='subtle'>No hay administradores registrados.</td></tr>";
    }

    async function createAdminFromPanel() {
      if (!isSuperAdminSession()) return showToast("Solo super administrador puede crear admins.", "error");
      const username = document.getElementById("newAdminUsername")?.value.trim() || "";
      const name = document.getElementById("newAdminName")?.value.trim() || "";
      const password = document.getElementById("newAdminPassword")?.value || "";

      if (!username || !name || !password) {
        return showToast("Completa usuario, nombre y contraseña.", "error");
      }
      if (password.length < 8) {
        return showToast("La contraseña debe tener al menos 8 caracteres.", "error");
      }

      try {
        const response = await fetch(`${API_BASE}/admin/users`, {
          method: "POST",
          headers: getAuthHeaders(),
          body: JSON.stringify({ username, name, password })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.message || "No se pudo crear el admin.");
        }

        const userInput = document.getElementById("newAdminUsername");
        const nameInput = document.getElementById("newAdminName");
        const passInput = document.getElementById("newAdminPassword");
        if (userInput) userInput.value = "";
        if (nameInput) nameInput.value = "";
        if (passInput) passInput.value = "";

        await loadAdminUsers();
        renderAll();
        showToast("Administrador creado correctamente.", "success");
      } catch (error) {
        showToast(error.message || "No se pudo crear el admin.", "error");
      }
    }

    async function refreshStateFromApi() {
      state.data = ensureStateDefaults(await loadData());
    }

    function renderWorker() {
      const used = getWorkerWeeklyKg(state.session.id);
      const left = Math.max(0, 2 - used);
      const yearly = getWorkerYearKg(state.session.id);
      const published = isPricePublished();
      const pendingForWorker = state.data.orders
        .filter((o) => o.workerId === state.session.id)
        .filter((o) => ["pending_confirm", "price_published"].includes(o.status))
        .sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1));
      const deadlineText = pendingForWorker.length ? getRemainingDeadlineText(pendingForWorker[0]) : "";
      document.getElementById("workerMetrics").innerHTML =
        "<div class='metric'><span class='subtle'>Kg usados esta semana</span><strong>" + used.toFixed(2) + " Kg</strong></div>" +
        "<div class='metric'><span class='subtle'>Kg disponibles para ti</span><strong>" + left.toFixed(2) + " Kg</strong></div>" +
        "<div class='metric'><span class='subtle'>Kg acumulados en el año</span><strong>" + yearly.toFixed(2) + " Kg</strong></div>";
      document.getElementById("orderWindowAlert").textContent = isOrderWindowOpen()
        ? (published
          ? ("Precio publicado. Confirma tus solicitudes antes del lunes a las 23:59. " + deadlineText).trim()
          : "Precio no publicado aún. Se habilita cuando administración lo publique y luego debes confirmar o cancelar tu compra.")
        : "Ventas cerradas (martes). Reapertura: miércoles 00:00.";

      const notices = getVisibleNotices();
      const reads = state.data.noticeReads[state.session.id] || [];
      const list = document.getElementById("workerNoticeList");
      if (!notices.length) list.innerHTML = "<div class='subtle'>No hay comunicados publicados.</div>";
      else {
        list.innerHTML = notices.map((n) => {
          const unread = !reads.includes(n.id);
          return "<button class='notice " + (unread ? "unread" : "") + "' data-id='" + n.id + "'><div class='notice-head'><strong>" + escapeHtml(n.title) + "</strong>" + (unread ? "<span class='badge-mini'>Nuevo</span>" : "") + "</div><div class='subtle'>" + escapeHtml(n.summary) + "</div></button>";
        }).join("");
        list.querySelectorAll(".notice").forEach((b) => b.addEventListener("click", () => openNoticeModal(state.data.notices.find((n) => n.id === b.dataset.id))));
      }

      const rows = state.data.orders.filter((o) => o.workerId === state.session.id).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      const tbody = document.getElementById("workerOrdersBody");
      tbody.innerHTML = rows.length ? rows.map((o) => {
        const pendingDeadlineOpen = isBeforePendingDeadline(o);
        const canCancel = ["pending_confirm", "price_published"].includes(o.status) && pendingDeadlineOpen;
        const canConfirm = o.status === "price_published" && pendingDeadlineOpen;
        const actionOptions = [
          "<option value=''>Seleccionar</option>",
          canConfirm ? "<option value='confirm'>Confirmar</option>" : "",
          canCancel ? "<option value='cancel'>Cancelar</option>" : ""
        ].join("");
        const action = (canConfirm || canCancel)
          ? "<select class='worker-action-select' data-worker-action='" + o.id + "'>" + actionOptions + "</select>"
          : (["pending_confirm", "price_published"].includes(o.status)
            ? (!pendingDeadlineOpen
              ? "<span class='subtle'>Plazo vencido</span>"
              : "<span class='subtle'>Esperando acción</span>")
            : "-");
        const orderCycleKey = getOrderCycleKey(o);
        const showPublishedPrice = o.status === "price_published";
        const showFixedPrice = !["pending_confirm", "price_published"].includes(o.status);
        const cyclePrice = getPricePerKg(orderCycleKey);
        const priceToShow = showPublishedPrice ? cyclePrice : (showFixedPrice ? numeric(o.pricePerKg) : null);
        const totalToShow = showPublishedPrice ? (numeric(o.kg) * cyclePrice) : (showFixedPrice ? numeric(o.total) : null);
        const priceCell = priceToShow === null ? "-" : ("S/ " + priceToShow.toFixed(2));
        const totalCell = totalToShow === null ? "-" : ("S/ " + totalToShow.toFixed(2));
        return "<tr><td>" + formatDateTime(o.createdAt) + "</td><td>Semana " + getOrderClosingWeek(o) + "</td><td>" + numeric(o.kg).toFixed(2) + "</td><td>" + priceCell + "</td><td>" + totalCell + "</td><td>" + formatDate(o.deliveryDate) + "</td><td><span class='status " + o.status + "'>" + STATUS_LABELS[o.status] + "</span></td><td>" + action + "</td></tr>";
      }).join("") : "<tr><td colspan='8' class='subtle'>Aún no tienes compras registradas.</td></tr>";
      tbody.querySelectorAll("select[data-worker-action]").forEach((select) => select.addEventListener("change", () => {
        if (!select.value) return;
        if (select.value === "confirm") return confirmOrder(select.dataset.workerAction);
        if (select.value === "cancel") return cancelOrder(select.dataset.workerAction);
      }));
      updatePriceTag();
    }
    function renderAdmin() {
      renderAdminNavigation();
      const adminSearch = normalizeForSearch(document.getElementById("adminGlobalSearch")?.value || "");
      const week = getCycleRange(new Date());
      const weekOrders = state.data.orders.filter((o) => {
        const t = new Date(o.createdAt);
        return t >= week.start && t <= week.end;
      });
      const accumulatedOrders = state.data.orders.filter((o) => !["cancelled", "pending_confirm", "price_published"].includes(o.status));
      const accumulatedKg = accumulatedOrders.reduce((s, o) => s + numeric(o.kg), 0);
      const accumulatedSoles = accumulatedOrders.reduce((s, o) => s + numeric(o.total), 0);
      const sold = weekOrders.filter((o) => o.status === "delivered").reduce((s, o) => s + numeric(o.kg), 0);
      const pending = state.data.orders.filter((o) => ["pending_confirm", "price_published", "requested", "approved", "ready"].includes(o.status)).length;
      document.getElementById("adminMetrics").innerHTML =
        "<div class='metric'><span class='subtle'>Venta acumulada</span><strong>" + accumulatedKg.toFixed(2) + " Kg - S/ " + accumulatedSoles.toFixed(2) + "</strong></div>" +
        "<div class='metric'><span class='subtle'>Kg entregados esta semana</span><strong>" + sold.toFixed(2) + " Kg</strong></div>" +
        "<div class='metric'><span class='subtle'>Pedidos pendientes</span><strong>" + pending + "</strong></div>";

      const currentCycle = getCycleKey(new Date());
      document.getElementById("cfgNationalPriceLabel").textContent = "Precio por Kg (S/) - Semana " + getIsoWeekNumber(new Date());
      document.getElementById("cfgNationalPrice").value = getPricePerKg(currentCycle);
      document.getElementById("pricePublishInfo").textContent = isPricePublished(currentCycle)
        ? "Precio publicado para la semana actual."
        : "Precio aún no publicado para la semana actual.";
      document.getElementById("tplWhatsapp").value = state.data.settings.notificationTemplates?.whatsapp || "";
      document.getElementById("tplEmail").value = state.data.settings.notificationTemplates?.email || "";
      renderPriceAdmin();
      updateNoticeFormMode();

      const nbody = document.getElementById("adminNoticeBody");
      const notices = [...state.data.notices]
        .filter((n) => {
          if (!adminSearch) return true;
          const bag = normalizeForSearch([n.title, n.summary, n.area, n.content].join(" "));
          return bag.includes(adminSearch);
        })
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      nbody.innerHTML = notices.length ? notices.map((n) => "<tr><td>" + escapeHtml(n.title) + "</td><td>" + escapeHtml(n.area || "-") + "</td><td>" + n.publishDate + "</td><td>" + (n.archived ? "Archivado" : "Activo") + "</td><td class='table-actions'><button class='icon-action icon-view' data-view='" + n.id + "' type='button' title='Ver comunicado' aria-label='Ver comunicado'><span aria-hidden='true'>👁</span></button><button class='icon-action icon-edit' data-edit='" + n.id + "' type='button' title='Editar comunicado' aria-label='Editar comunicado'><span aria-hidden='true'>✏</span></button><button class='icon-action " + (n.archived ? "icon-restore" : "icon-archive") + "' data-archive='" + n.id + "' type='button' title='" + (n.archived ? "Activar comunicado" : "Archivar comunicado") + "' aria-label='" + (n.archived ? "Activar comunicado" : "Archivar comunicado") + "'><span aria-hidden='true'>" + (n.archived ? "↩" : "📦") + "</span></button><button class='icon-action icon-delete' data-delete='" + n.id + "' type='button' title='Eliminar comunicado' aria-label='Eliminar comunicado'><span aria-hidden='true'>🗑</span></button></td></tr>").join("") : "<tr><td colspan='5' class='subtle'>No hay comunicados.</td></tr>";
      nbody.querySelectorAll("button[data-view]").forEach((b) => b.addEventListener("click", () => openNoticeModal(state.data.notices.find((x) => x.id === b.dataset.view))));
      nbody.querySelectorAll("button[data-edit]").forEach((b) => b.addEventListener("click", () => startNoticeEdit(b.dataset.edit)));
      nbody.querySelectorAll("button[data-archive]").forEach((b) => b.addEventListener("click", () => { const n = state.data.notices.find((x) => x.id === b.dataset.archive); n.archived = !n.archived; saveData(); renderAll(); }));
      nbody.querySelectorAll("button[data-delete]").forEach((b) => b.addEventListener("click", () => {
        const noticeId = b.dataset.delete;
        state.data.notices = state.data.notices.filter((x) => x.id !== noticeId);
        if (state.editingNoticeId === noticeId) cancelNoticeEdit(false);
        saveData();
        renderAll();
      }));

      const obody = document.getElementById("adminOrdersBody");
      const orders = getFilteredAdminOrders(adminSearch);
      obody.innerHTML = orders.length ? orders.map((o) => {
        const cyclePrice = getPricePerKg(getOrderCycleKey(o));
        const totalCell = o.status === "pending_confirm"
          ? "-"
          : ("S/ " + (o.status === "price_published" ? (numeric(o.kg) * cyclePrice) : numeric(o.total)).toFixed(2));
        return "<tr><td>" + escapeHtml(o.workerName) + "<br><span class='subtle'>" + escapeHtml(o.workerId) + "</span></td><td>" + formatDateTime(o.createdAt) + "</td><td>Semana " + getOrderClosingWeek(o) + "</td><td>" + numeric(o.kg).toFixed(2) + "</td><td>" + totalCell + "</td><td>" + formatDate(o.deliveryDate) + "</td><td><span class='status " + o.status + "'>" + STATUS_LABELS[o.status] + "</span></td><td><select data-status='" + o.id + "'>" + ["pending_confirm", "price_published", "requested", "approved", "ready", "delivered", "cancelled"].map((s) => "<option value='" + s + "' " + (s === o.status ? "selected" : "") + ">" + STATUS_LABELS[s] + "</option>").join("") + "</select></td></tr>";
      }).join("") : "<tr><td colspan='8' class='subtle'>No hay pedidos.</td></tr>";
      obody.querySelectorAll("select[data-status]").forEach((s) => s.addEventListener("change", () => {
        const o = state.data.orders.find((x) => x.id === s.dataset.status);
        const old = o.status;
        o.status = s.value;
        if (old !== o.status) {
          addNotification(o);
          recordOrderHistory(o, "status_changed", old + " -> " + o.status);
        }
        saveData();
        renderAll();
      }));

      const notif = document.getElementById("adminNotificationsBody");
      const filterNotifWorker = normalizeForSearch(document.getElementById("filterNotifWorker")?.value || "");
      const filterNotifChannel = (document.getElementById("filterNotifChannel")?.value || "").trim();
      const filterNotifSent = (document.getElementById("filterNotifSent")?.value || "").trim();
      const filterNotifFrom = (document.getElementById("filterNotifFrom")?.value || "").trim();
      const filterNotifTo = (document.getElementById("filterNotifTo")?.value || "").trim();
      const visibleNotifications = [...state.data.notifications]
        .filter((n) => {
          if (adminSearch) {
            const bag = normalizeForSearch([n.workerName, n.message, n.channel].join(" "));
            if (!bag.includes(adminSearch)) return false;
          }
          if (filterNotifWorker && !normalizeForSearch(n.workerName || "").includes(filterNotifWorker)) return false;
          if (filterNotifChannel && n.channel !== filterNotifChannel) return false;
          if (filterNotifSent === "sent" && !n.sent) return false;
          if (filterNotifSent === "pending" && n.sent) return false;
          if (filterNotifFrom) {
            const from = new Date(filterNotifFrom + "T00:00:00");
            if (new Date(n.createdAt) < from) return false;
          }
          if (filterNotifTo) {
            const to = new Date(filterNotifTo + "T23:59:59");
            if (new Date(n.createdAt) > to) return false;
          }
          return true;
        })
        .slice(0, 50);
      notif.innerHTML = visibleNotifications.length ? visibleNotifications.map((n) => {
        let action = "-";
        if (n.channel === "WhatsApp") action = "<a href='https://wa.me/" + String(n.target || "").replace(/\D/g, "") + "?text=" + encodeURIComponent(n.message) + "' target='_blank' rel='noopener'>Enviar</a>";
        if (n.channel === "Correo") action = "<a href='mailto:" + encodeURIComponent(n.target) + "?subject=" + encodeURIComponent("Estado de pedido BlueSales") + "&body=" + encodeURIComponent(n.message) + "'>Enviar</a>";
        if (!n.sent) action += " <button class='button-ghost' data-notif-sent='" + n.id + "' type='button'>Marcar enviado</button>";
        return "<tr><td>" + formatDateTime(n.createdAt) + "</td><td>" + escapeHtml(n.workerName) + "</td><td>" + n.channel + "</td><td>" + (n.sent ? "Enviado" : "Pendiente") + "</td><td>" + escapeHtml(n.message) + "</td><td>" + action + "</td></tr>";
      }).join("") : "<tr><td colspan='6' class='subtle'>No hay notificaciones para los filtros aplicados.</td></tr>";
      notif.querySelectorAll("button[data-notif-sent]").forEach((b) => b.addEventListener("click", () => {
        const n = state.data.notifications.find((x) => x.id === b.dataset.notifSent);
        if (!n) return;
        n.sent = true;
        n.sentAt = new Date().toISOString();
        saveData();
        renderAll();
      }));

      renderAdminWorkers();
      renderAdminUsers();
    }

    function getManagedCycleKeys() {
      const now = new Date();
      const keys = [];
      for (let i = -4; i <= 8; i += 1) {
        const date = new Date(now);
        date.setDate(now.getDate() + (i * 7));
        keys.push(getCycleKey(date));
      }
      return [...new Set(keys)].sort((a, b) => {
        const da = getCycleDateFromKey(a)?.getTime() || 0;
        const db = getCycleDateFromKey(b)?.getTime() || 0;
        return da - db;
      });
    }
    function renderPriceAdmin() {
      const weekInput = document.getElementById("priceWeekStart");
      const valueInput = document.getElementById("priceWeekValue");
      const info = document.getElementById("priceAdminInfo");
      const body = document.getElementById("adminPriceWeeksBody");
      if (!weekInput || !valueInput || !info || !body) return;

      if (!weekInput.value) weekInput.value = todayISO();
      const currentCycle = getCycleKey(new Date());
      weekInput.min = currentCycle;
      const cycleKey = getNormalizedCycleKeyFromInput(weekInput.value) || getCycleKey(new Date());
      const entry = getWeeklyPriceEntry(cycleKey);
      const editable = !isPastCycle(cycleKey);

      valueInput.value = numeric(entry.pricePerKg) > 0 ? numeric(entry.pricePerKg) : "";
      valueInput.disabled = !editable;
      document.getElementById("saveWeekPriceButton").disabled = !editable;
      document.getElementById("publishWeekPriceButton").disabled = !editable;
      document.getElementById("deleteWeekPriceButton").disabled = !editable;

      const range = getCycleDateRangeByKey(cycleKey);
      const cycleWeekNumber = getIsoWeekNumber(range?.start || new Date());
      const delivery = getDeliveryFridayForCycleKey(cycleKey);
      const statusText = editable
        ? "Semana editable."
        : "Semana cerrada: no se puede modificar.";
      info.textContent = "Semana " + cycleWeekNumber + " (desde " + formatDate(range?.start || new Date()) + " hasta " + formatDate(range?.end || new Date()) + "). Entrega: " + formatDate(delivery) + ". " + statusText;

      const rows = getManagedCycleKeys();
      body.innerHTML = rows.map((key) => {
        const row = getWeeklyPriceEntry(key);
        const rowRange = getCycleDateRangeByKey(key);
        const rowWeekNumber = getIsoWeekNumber(rowRange?.start || new Date());
        const canEdit = !isPastCycle(key);
        const actionCell = canEdit
          ? "<button class='button-ghost' type='button' data-manage-week='" + key + "'>Administrar</button>"
          : "<button class='button-ghost' type='button' disabled>Semana cerrada</button>";
        return "<tr>" +
          "<td>Semana " + rowWeekNumber + "</td>" +
          "<td>" + formatDate(rowRange?.start || new Date()) + " - " + formatDate(rowRange?.end || new Date()) + "</td>" +
          "<td>" + (numeric(row.pricePerKg) > 0 ? ("S/ " + numeric(row.pricePerKg).toFixed(2)) : "-") + "</td>" +
          "<td>" + (row.published ? "Si" : "No") + "</td>" +
          "<td>" + actionCell + "</td>" +
          "</tr>";
      }).join("");
      body.querySelectorAll("button[data-manage-week]").forEach((button) => {
        button.addEventListener("click", () => {
          const selectedCycle = button.dataset.manageWeek;
          if (!selectedCycle || isPastCycle(selectedCycle)) return;
          loadWeekIntoPriceManager(selectedCycle);
        });
      });
    }
    function loadWeekIntoPriceManager(cycleKey) {
      const weekInput = document.getElementById("priceWeekStart");
      if (!weekInput) return;
      weekInput.value = cycleKey;
      const card = weekInput.closest(".card");
      if (card) card.scrollIntoView({ behavior: "smooth", block: "nearest" });
      renderAll();
    }

    function renderAdminWorkers() {
      const body = document.getElementById("adminWorkersBody");
      const adminSearch = normalizeForSearch(document.getElementById("adminGlobalSearch")?.value || "");
      const filterWorkerDni = (document.getElementById("filterWorkerDni")?.value || "").trim();
      const filterWorkerName = normalizeForSearch(document.getElementById("filterWorkerName")?.value || "");
      const filterWorkerContact = normalizeForSearch(document.getElementById("filterWorkerContact")?.value || "");
      const workers = [...state.data.users]
        .filter((u) => {
          if (adminSearch) {
            const bag = normalizeForSearch([u.id, u.name, u.phone, u.email].join(" "));
            if (!bag.includes(adminSearch)) return false;
          }
          if (filterWorkerDni && !String(u.id || "").includes(filterWorkerDni)) return false;
          if (filterWorkerName && !normalizeForSearch(u.name || "").includes(filterWorkerName)) return false;
          if (filterWorkerContact) {
            const phone = normalizeForSearch(u.phone || "");
            const email = normalizeForSearch(u.email || "");
            if (!phone.includes(filterWorkerContact) && !email.includes(filterWorkerContact)) return false;
          }
          return true;
        })
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      body.innerHTML = workers.length
        ? workers.map((u) => {
          const isActive = u.active !== false;
          return "<tr>" +
            "<td><div class='worker-id'>" + escapeHtml(u.id) + "</div><span class='worker-state " + (isActive ? "active" : "inactive") + "'>" + (isActive ? "Activo" : "Inhabilitado") + "</span></td>" +
            "<td><input data-worker-name='" + escapeHtml(u.id) + "' value='" + escapeHtml(u.name || "") + "' /></td>" +
            "<td><input data-worker-phone='" + escapeHtml(u.id) + "' value='" + escapeHtml(u.phone || "") + "' /></td>" +
            "<td><input data-worker-email='" + escapeHtml(u.id) + "' value='" + escapeHtml(u.email || "") + "' /></td>" +
            "<td class='nowrap'>" + (u.createdAt ? formatDateTime(u.createdAt) : "-") + "</td>" +
            "<td class='table-actions'>" +
            "<button class='icon-action icon-save' data-worker-save='" + escapeHtml(u.id) + "' type='button' title='Guardar cambios' aria-label='Guardar cambios'><span aria-hidden='true'>💾</span></button>" +
            "<button class='icon-action icon-pass' data-worker-pass='" + escapeHtml(u.id) + "' type='button' title='Cambiar contraseña' aria-label='Cambiar contraseña'><span aria-hidden='true'>🔐</span></button>" +
            "<button class='icon-action " + (isActive ? "icon-disable" : "icon-enable") + "' data-worker-toggle='" + escapeHtml(u.id) + "' type='button' title='" + (isActive ? "Inhabilitar trabajador" : "Habilitar trabajador") + "' aria-label='" + (isActive ? "Inhabilitar trabajador" : "Habilitar trabajador") + "'><span aria-hidden='true'>" + (isActive ? "⛔" : "✅") + "</span></button>" +
            "<button class='icon-action icon-delete' data-worker-del='" + escapeHtml(u.id) + "' type='button' title='Eliminar trabajador' aria-label='Eliminar trabajador'><span aria-hidden='true'>🗑</span></button>" +
            "</td>" +
            "</tr>";
        }).join("")
        : "<tr><td colspan='6' class='subtle'>No hay trabajadores para los filtros aplicados.</td></tr>";

      body.querySelectorAll("button[data-worker-save]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const id = btn.dataset.workerSave;
          const worker = state.data.users.find((u) => u.id === id);
          if (!worker) return;
          const name = body.querySelector("input[data-worker-name='" + id + "']").value.trim();
          const phone = body.querySelector("input[data-worker-phone='" + id + "']").value.trim();
          const email = body.querySelector("input[data-worker-email='" + id + "']").value.trim();
          if (!name) return showToast("El nombre no puede estar vacio.", "error");
          if (phone && !isValidPhone(phone)) return showToast("Celular inválido. Usa 9 a 12 digitos.", "error");
          if (email && !isValidEmail(email)) return showToast("Correo inválido.", "error");
          worker.name = name;
          worker.phone = normalizePhone(phone);
          worker.email = email;
          saveData();
          showToast("Datos del trabajador actualizados.", "success");
          renderAll();
        });
      });

      body.querySelectorAll("button[data-worker-pass]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const id = btn.dataset.workerPass;
          const worker = state.data.users.find((u) => u.id === id);
          if (!worker) return;
          const newPass = prompt("Nueva contraseña para DNI " + id + ":", "");
          if (newPass === null) return;
          if (newPass.trim().length < 8) return showToast("La contraseña debe tener al menos 8 caracteres.", "error");
          worker.password = newPass.trim();
          saveData();
          showToast("Contraseña actualizada correctamente.", "success");
          renderAll();
        });
      });

      body.querySelectorAll("button[data-worker-toggle]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const id = btn.dataset.workerToggle;
          const worker = state.data.users.find((u) => u.id === id);
          if (!worker) return;
          const willEnable = worker.active === false;
          const ok = confirm(
            willEnable
              ? ("Se habilitará el acceso para DNI " + id + ". ¿Deseas continuar?")
              : ("Se inhabilitará el acceso para DNI " + id + ". El trabajador ya no podrá iniciar sesión. ¿Deseas continuar?")
          );
          if (!ok) return;
          worker.active = willEnable;
          saveData();
          showToast(willEnable ? "Trabajador habilitado." : "Trabajador inhabilitado.", "success");
          renderAll();
        });
      });

      body.querySelectorAll("button[data-worker-del]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const id = btn.dataset.workerDel;
          const hasOrders = state.data.orders.some((o) => o.workerId === id);
          if (hasOrders) {
            const ok = confirm("Este trabajador tiene pedidos registrados. ¿Deseas eliminar solo el acceso?");
            if (!ok) return;
          }
          state.data.users = state.data.users.filter((u) => u.id !== id);
          saveData();
          showToast("Trabajador eliminado.", "success");
          renderAll();
        });
      });
    }

    function addNotification(order) {
      const templates = state.data.settings.notificationTemplates || {};
      const msgWhatsApp = applyTemplate(templates.whatsapp, order);
      const msgEmail = applyTemplate(templates.email, order);
      if (order.workerPhone) state.data.notifications.unshift({ id: uid("ntf"), workerName: order.workerName, channel: "WhatsApp", target: order.workerPhone, message: msgWhatsApp, sent: false, createdAt: new Date().toISOString() });
      if (order.workerEmail) state.data.notifications.unshift({ id: uid("ntf"), workerName: order.workerName, channel: "Correo", target: order.workerEmail, message: msgEmail, sent: false, createdAt: new Date().toISOString() });
    }

    function openNoticeModal(notice) {
      if (!notice) return;
      document.getElementById("modalTitle").textContent = notice.title;
      document.getElementById("modalMeta").textContent = "Área: " + (notice.area || "General") + " | Publicado: " + notice.publishDate;
      document.getElementById("modalText").textContent = notice.content;
      const actions = document.getElementById("modalActions");
      actions.innerHTML = "";
      const modal = document.getElementById("noticeModal");
      modal.classList.add("is-open");
      modal.setAttribute("aria-hidden", "false");
    }

    function closeNoticeModal() {
      const modal = document.getElementById("noticeModal");
      modal.classList.remove("is-open");
      modal.setAttribute("aria-hidden", "true");
    }

    function updatePriceTag() {
      document.getElementById("priceTag").textContent = "Envase de 18 oz (500 gr)";
    }

    async function createOrder() {
      if (!isOrderWindowOpen()) return showToast("Ventas cerradas (martes). Reapertura: miércoles 00:00.", "error");
      const kg = numeric(document.getElementById("orderKg").value);
      if (!kg || kg <= 0) return showToast("Ingresa cantidad valida.", "error");
      if (kg > 2) return showToast("Máximo 2 Kg por persona.", "error");
      const used = getWorkerWeeklyKg(state.session.id);
      if (used + kg > 2) return showToast("Superas límite semanal. Te quedan " + Math.max(0, 2 - used).toFixed(2) + " Kg.", "error");
      try {
        const response = await fetch(`${API_BASE}/worker/orders`, {
          method: "POST",
          headers: getAuthHeaders(),
          body: JSON.stringify({ kg })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message || "No se pudo registrar la solicitud.");
        await refreshStateFromApi();
        renderAll();
        showToast("Solicitud registrada correctamente.", "success");
      } catch (error) {
        showToast(error.message || "No se pudo registrar la solicitud.", "error");
      }
    }

    async function confirmOrder(orderId) {
      const order = state.data.orders.find((o) => o.id === orderId && o.workerId === state.session.id);
      if (!order) return;
      if (order.status !== "price_published") return showToast("Aún no hay precio publicado para confirmar esta compra.", "error");
      try {
        const response = await fetch(`${API_BASE}/worker/orders/${encodeURIComponent(orderId)}/confirm`, {
          method: "POST",
          headers: getAuthHeaders()
        });
        const payload = await response.json().catch(() => ({}));
        await refreshStateFromApi();
        renderAll();
        if (response.status === 409) {
          return showToast(payload.message || "Plazo vencido. La compra fue cancelada.", "error");
        }
        if (!response.ok) throw new Error(payload.message || "No se pudo confirmar la compra.");
        showToast("Compra confirmada correctamente.", "success");
      } catch (error) {
        showToast(error.message || "No se pudo confirmar la compra.", "error");
      }
    }
    async function cancelOrder(orderId) {
      const order = state.data.orders.find((o) => o.id === orderId && o.workerId === state.session.id);
      if (!order) return;
      if (!["pending_confirm", "price_published"].includes(order.status)) return;
      try {
        const response = await fetch(`${API_BASE}/worker/orders/${encodeURIComponent(orderId)}/cancel`, {
          method: "POST",
          headers: getAuthHeaders()
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message || "No se pudo cancelar la compra.");
        await refreshStateFromApi();
        renderAll();
        showToast("Compra cancelada.", "info");
      } catch (error) {
        showToast(error.message || "No se pudo cancelar la compra.", "error");
      }
    }

    function saveConfig() {
      const cycleKey = getCycleKey(new Date());
      const entry = getWeeklyPriceEntry(cycleKey);
      entry.pricePerKg = numeric(document.getElementById("cfgNationalPrice").value);
      syncLegacyPriceFields();
      saveData();
      renderAll();
      showToast("Precio guardado para la semana actual.", "success");
    }
    function publishPriceNow() {
      const cycleKey = getCycleKey(new Date());
      const entry = getWeeklyPriceEntry(cycleKey);
      if (numeric(entry.pricePerKg) <= 0) {
        return showToast("Define primero un precio valido para la semana actual.", "error");
      }
      entry.published = true;
      entry.publishedAt = new Date().toISOString();
      syncPricePublishedStatuses();
      syncLegacyPriceFields();
      recordOrderHistory({ id: "-" }, "price_published", "Precio publicado para ciclo " + cycleKey);
      saveData();
      renderAll();
      showToast("Precio publicado para la semana actual.", "success");
    }
    function saveWeekPrice() {
      const input = document.getElementById("priceWeekStart");
      const valueInput = document.getElementById("priceWeekValue");
      const cycleKey = getNormalizedCycleKeyFromInput(input?.value || "");
      if (!cycleKey) return showToast("Selecciona una fecha valida.", "error");
      if (isPastCycle(cycleKey)) return showToast("No se puede modificar precio en semanas anteriores.", "error");
      const nextPrice = numeric(valueInput?.value);
      if (!(nextPrice > 0)) return showToast("Ingresa un precio mayor a 0.", "error");
      const entry = getWeeklyPriceEntry(cycleKey);
      entry.pricePerKg = nextPrice;
      entry.updatedAt = new Date().toISOString();
      syncPendingOrderPrices();
      syncLegacyPriceFields();
      saveData();
      renderAll();
      showToast("Precio guardado para la semana " + cycleKey + ".", "success");
    }
    function publishWeekPrice() {
      const input = document.getElementById("priceWeekStart");
      const cycleKey = getNormalizedCycleKeyFromInput(input?.value || "");
      if (!cycleKey) return showToast("Selecciona una fecha valida.", "error");
      if (isPastCycle(cycleKey)) return showToast("No se puede publicar precio en semanas anteriores.", "error");
      const entry = getWeeklyPriceEntry(cycleKey);
      if (numeric(entry.pricePerKg) <= 0) return showToast("Primero guarda un precio valido para esa semana.", "error");
      entry.published = true;
      entry.publishedAt = new Date().toISOString();
      syncPricePublishedStatuses();
      syncPendingOrderPrices();
      syncLegacyPriceFields();
      recordOrderHistory({ id: "-" }, "price_published", "Precio publicado para ciclo " + cycleKey);
      saveData();
      renderAll();
      showToast("Precio publicado para la semana " + cycleKey + ".", "success");
    }
    function deleteWeekPrice() {
      const input = document.getElementById("priceWeekStart");
      const cycleKey = getNormalizedCycleKeyFromInput(input?.value || "");
      if (!cycleKey) return showToast("Selecciona una fecha valida.", "error");
      if (isPastCycle(cycleKey)) return showToast("No se puede borrar precio en semanas anteriores.", "error");
      const entry = getWeeklyPriceEntry(cycleKey);
      const hasConfiguredPrice = numeric(entry.pricePerKg) > 0 || Boolean(entry.published);
      if (!hasConfiguredPrice) return showToast("No hay precio configurado para esa semana.", "info");
      const ok = confirm("Se borrará el precio de la semana " + cycleKey + ". Esta acción no afecta pedidos ya confirmados. ¿Deseas continuar?");
      if (!ok) return;
      delete state.data.settings.weeklyPrices[cycleKey];
      syncPricePublishedStatuses();
      syncPendingOrderPrices();
      syncLegacyPriceFields();
      recordOrderHistory({ id: "-" }, "price_deleted", "Precio eliminado para ciclo " + cycleKey);
      saveData();
      renderAll();
      showToast("Precio eliminado para la semana " + cycleKey + ".", "success");
    }
    function saveNotificationTemplates() {
      state.data.settings.notificationTemplates = {
        whatsapp: document.getElementById("tplWhatsapp").value.trim(),
        email: document.getElementById("tplEmail").value.trim()
      };
      saveData();
      showToast("Plantillas de notificacion guardadas.", "success");
    }

    function clearNoticeFormFields() {
      ["noticeTitle", "noticeSummary", "noticeArea", "noticeDate", "noticeContent"].forEach((id) => {
        const input = document.getElementById(id);
        if (input) input.value = "";
      });
    }
    function updateNoticeFormMode() {
      const title = document.getElementById("noticeFormTitle");
      const submit = document.getElementById("createNoticeButton");
      const cancel = document.getElementById("cancelNoticeEditButton");
      if (!title || !submit || !cancel) return;
      if (state.editingNoticeId && !state.data.notices.some((n) => n.id === state.editingNoticeId)) {
        state.editingNoticeId = null;
      }
      const editing = Boolean(state.editingNoticeId);
      title.textContent = editing ? "Editar comunicado" : "Nuevo comunicado";
      submit.textContent = editing ? "Guardar cambios" : "Publicar comunicado";
      cancel.classList.toggle("hidden", !editing);
    }
    function startNoticeEdit(noticeId) {
      const notice = state.data.notices.find((n) => n.id === noticeId);
      if (!notice) return showToast("No se encontró el comunicado a editar.", "error");
      state.editingNoticeId = notice.id;
      setAdminView("new_notice");
      document.getElementById("noticeTitle").value = notice.title || "";
      document.getElementById("noticeSummary").value = notice.summary || "";
      document.getElementById("noticeArea").value = notice.area || "";
      document.getElementById("noticeDate").value = notice.publishDate || "";
      document.getElementById("noticeContent").value = notice.content || "";
      updateNoticeFormMode();
      showToast("Editando comunicado seleccionado.", "info");
    }
    function cancelNoticeEdit(showMessage = true) {
      const wasEditing = Boolean(state.editingNoticeId);
      state.editingNoticeId = null;
      clearNoticeFormFields();
      updateNoticeFormMode();
      if (showMessage && wasEditing) showToast("Edición cancelada.", "info");
    }

    function createNotice() {
      const title = document.getElementById("noticeTitle").value.trim();
      const summary = document.getElementById("noticeSummary").value.trim();
      const area = document.getElementById("noticeArea").value.trim();
      const publishDate = document.getElementById("noticeDate").value;
      const content = document.getElementById("noticeContent").value.trim();
      if (!title || !summary || !publishDate || !content) return showToast("Completa título, resumen, fecha y contenido.", "error");
      if (state.editingNoticeId) {
        const notice = state.data.notices.find((n) => n.id === state.editingNoticeId);
        if (!notice) {
          cancelNoticeEdit(false);
          return showToast("No se encontró el comunicado a editar.", "error");
        }
        notice.title = title;
        notice.summary = summary;
        notice.area = area;
        notice.publishDate = publishDate;
        notice.content = content;
        notice.updatedAt = new Date().toISOString();
        cancelNoticeEdit(false);
        state.adminView = "manage_notices";
        saveData();
        renderAll();
        showToast("Comunicado actualizado.", "success");
        return;
      }
      state.data.notices.push({ id: uid("notice"), title, summary, area, publishDate, content, archived: false, createdAt: new Date().toISOString() });
      clearNoticeFormFields();
      saveData();
      renderAll();
      showToast("Comunicado publicado.", "success");
    }

    function renderAll() {
      if (isAdminRole(state.session?.role)) {
        const publishedStatusesSynced = syncPricePublishedStatuses();
        const pendingPricesSynced = syncPendingOrderPrices();
        const pendingOrdersCancelled = autoCancelExpiredPendingOrders();
        syncLegacyPriceFields();
        if (pendingPricesSynced || pendingOrdersCancelled || publishedStatusesSynced) saveData();
      } else {
        syncLegacyPriceFields();
      }
      renderSession();
      renderPanels();
    }
    function showWorkerLogin() {
      document.getElementById("workerLoginCard").classList.remove("hidden");
      document.getElementById("adminLoginCard").classList.add("hidden");
      document.getElementById("showWorkerLogin").classList.add("is-active");
      document.getElementById("showAdminLogin").classList.remove("is-active");
    }
    function showAdminLogin() {
      document.getElementById("workerLoginCard").classList.add("hidden");
      document.getElementById("adminLoginCard").classList.remove("hidden");
      document.getElementById("showAdminLogin").classList.add("is-active");
      document.getElementById("showWorkerLogin").classList.remove("is-active");
    }
    function showWorkerRegisterForm() { document.getElementById("workerRegisterBox").classList.remove("hidden"); }

    function setWorkerNameHint(message, isError = false) {
      const hint = document.getElementById("workerNameHint");
      if (!hint) return;
      const text = String(message || "").trim();
      if (!text) {
        hint.textContent = "";
        hint.style.display = "none";
        hint.style.color = "";
        return;
      }
      hint.style.display = "";
      hint.textContent = text;
      hint.style.color = isError ? "#9d2f25" : "";
    }

    function setWorkerNameReadOnly(readOnly) {
      const nameInput = document.getElementById("workerName");
      if (!nameInput) return;
      nameInput.readOnly = Boolean(readOnly);
    }

    function enableWorkerNameManualMode() {
      workerDniLookupManualMode = true;
      setWorkerNameReadOnly(false);
      setWorkerNameHint("Validación DNI no disponible. Escribe tu nombre completo manualmente.");
    }

    async function lookupWorkerNameByDni(dni, options = {}) {
      const silent = Boolean(options.silent);
      const nameInput = document.getElementById("workerName");
      if (!nameInput) return false;
      if (!/^\d{8}$/.test(dni)) {
        nameInput.value = "";
        setWorkerNameHint("Ingresa tu DNI para consultar el nombre oficial.");
        return false;
      }

      const seq = ++workerDniLookupSeq;
      setWorkerNameHint("Consultando nombre oficial...");
      try {
        const endpoints = [
          `${API_BASE}/identity/dni/${encodeURIComponent(dni)}`,
          `${API_BASE}/identity/dni?dni=${encodeURIComponent(dni)}`,
          `${API_BASE}/dni/${encodeURIComponent(dni)}`
        ];
        let payload = {};
        let response = null;
        for (const endpoint of endpoints) {
          const candidate = await fetch(endpoint);
          response = candidate;
          payload = await candidate.json().catch(() => ({}));
          if (candidate.ok) break;
          if (candidate.status >= 500) break;
        }
        if (seq !== workerDniLookupSeq) return false;
        if (!response || !response.ok) {
          const statusText = response ? ` (HTTP ${response.status})` : "";
          const message = String(payload?.message || ("No se pudo consultar el DNI." + statusText)).trim();
          const statusCode = Number(response?.status || 0);
          const isServiceUnavailable = statusCode >= 500
            || /validaci[oó]n de dni no est[aá] habilitada/i.test(message)
            || /no se pudo conectar al servicio de validaci[oó]n/i.test(message);
          if (isServiceUnavailable) {
            enableWorkerNameManualMode();
            if (!silent) showToast("Validación DNI no disponible. Ingresa tu nombre manualmente.", "info", 4500);
            return Boolean(nameInput.value.trim());
          }
          nameInput.value = "";
          setWorkerNameHint(message, true);
          if (!silent) showToast(message, "error");
          return false;
        }
        workerDniLookupManualMode = false;
        setWorkerNameReadOnly(true);
        const nombres = String(payload?.nombres || "").trim();
        const apellidoPaterno = String(payload?.apellidoPaterno || "").trim();
        const apellidoMaterno = String(payload?.apellidoMaterno || "").trim();
        const composedName = [nombres, apellidoPaterno, apellidoMaterno].filter(Boolean).join(" ").trim();
        const name = composedName || String(payload?.name || "").trim();
        nameInput.value = name;
        setWorkerNameHint(name ? "" : "No se encontró nombre para ese DNI.", !name);
        if (!name && !silent) showToast("No se encontró nombre para ese DNI.", "error");
        return Boolean(name);
      } catch (_error) {
        if (seq !== workerDniLookupSeq) return false;
        enableWorkerNameManualMode();
        if (!silent) showToast("No se pudo conectar para validar DNI. Ingresa tu nombre manualmente.", "info", 4500);
        return Boolean(nameInput.value.trim());
      }
    }

    async function workerLogin() {
      const dni = document.getElementById("workerDniLogin").value.trim();
      const password = document.getElementById("workerPasswordLogin").value;
      if (!dni || !password) return showToast("Ingresa DNI y contraseña.", "error");
      if (!isValidDni(dni)) return showToast("El DNI debe tener 8 digitos numéricos.", "error");
      try {
        const auth = await loginWithApi({ role: "worker", id: dni, password });
        saveSession({ ...auth.profile, token: auth.token });
        renderAll();
        showToast("Bienvenido, " + (auth.profile.name || "trabajador") + ".", "success");
      } catch (error) {
        document.getElementById("workerRegisterBox").classList.remove("hidden");
        document.getElementById("workerDniRegister").value = dni;
        if (isValidDni(dni)) lookupWorkerNameByDni(dni, { silent: true });
        showToast(error.message || "No se pudo iniciar sesión.", "error");
      }
    }

    async function workerRegister() {
      const dni = document.getElementById("workerDniRegister").value.trim();
      const nameInput = document.getElementById("workerName");
      let name = nameInput.value.trim();
      const phone = document.getElementById("workerPhone").value.trim();
      const email = document.getElementById("workerEmail").value.trim();
      const password = document.getElementById("workerPasswordRegister").value;
      const consentAccepted = Boolean(document.getElementById("workerDataConsent")?.checked);

      if (!dni || !phone || !email || !password) {
        return showToast("Completa DNI, celular, correo y contrase\u00f1a.", "error");
      }
      if (!isValidDni(dni)) return showToast("El DNI debe tener 8 d\u00edgitos num\u00e9ricos.", "error");
      if (password.length < 8) return showToast("La contrase\u00f1a debe tener al menos 8 caracteres.", "error");
      if (!isValidPhone(phone)) return showToast("Celular inv\u00e1lido. Usa 9 a 12 d\u00edgitos.", "error");
      if (!isValidEmail(email)) return showToast("Correo inv\u00e1lido.", "error");
      if (!consentAccepted) return showToast("Debes aceptar la Pol\u00edtica de Privacidad para registrarte.", "error");
      if (state.data.users.some((u) => u.id === dni)) return showToast("Ese DNI ya est\u00e1 registrado. Inicia sesi\u00f3n.", "error");
      if (!name) {
        const ok = await lookupWorkerNameByDni(dni);
        name = nameInput.value.trim();
        if (!ok && !name) return showToast("Ingresa tu nombre completo para continuar.", "error");
      }
      const privacyPolicyUrl = new URL(PRIVACY_POLICY_PATH, window.location.origin).toString();

      try {
        const response = await fetch(`${API_BASE}/auth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: dni,
            name,
            phone: normalizePhone(phone),
            email,
            password,
            privacyAccepted: true,
            privacyPolicyVersion: PRIVACY_POLICY_VERSION,
            privacyPolicyUrl
          })
        });
        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          throw new Error(err.message || "No se pudo registrar.");
        }
        const auth = await response.json();
        saveSession({ ...auth.profile, token: auth.token });
      } catch (error) {
        showToast(error.message || "No se pudo registrar en base de datos.", "error");
        return;
      }
      renderAll();
      showToast("Registro completado.", "success");
    }
    async function adminLogin() {
      const user = document.getElementById("adminUser").value.trim();
      const pin = document.getElementById("adminPin").value.trim();
      try {
        const auth = await loginWithApi({ role: "admin", user, pin });
        state.adminView = "home";
        saveSession({ ...auth.profile, token: auth.token });
        if (auth.profile?.role === "super_admin") {
          await loadAdminUsers();
        } else {
          state.adminUsers = [];
        }
        renderAll();
        showToast(auth.profile?.role === "super_admin" ? "Sesión super admin iniciada." : "Sesión admin iniciada.", "success");
      } catch (error) {
        showToast(error.message || "Credenciales inválidas.", "error");
      }
    }

    async function logout() {
      const token = state.session?.token;
      if (token) {
        try {
          await fetch(`${API_BASE}/auth/logout`, {
            method: "POST",
            headers: { Authorization: "Bearer " + token }
          });
        } catch (_error) {
          // Logout local must still complete even if network fails.
        }
      }
      saveSession(null);
      renderAll();
      showToast("Sesión cerrada.", "info");
    }
    function submitLoginOnEnter(e) {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const workerVisible = !document.getElementById("workerLoginCard").classList.contains("hidden");
      if (workerVisible) return workerLogin();
      return adminLogin();
    }

    document.getElementById("showWorkerLogin").addEventListener("click", showWorkerLogin);
    document.getElementById("showAdminLogin").addEventListener("click", showAdminLogin);
    document.getElementById("showWorkerRegisterButton").addEventListener("click", showWorkerRegisterForm);
    document.getElementById("workerLoginButton").addEventListener("click", workerLogin);
    document.getElementById("workerRegisterButton").addEventListener("click", workerRegister);
    document.getElementById("workerDniRegister").addEventListener("input", (e) => {
      const sanitized = String(e.target.value || "").replace(/\D/g, "").slice(0, 8);
      e.target.value = sanitized;
      const nameInput = document.getElementById("workerName");
      if (sanitized.length < 8) {
        workerDniLookupSeq++;
        if (nameInput) nameInput.value = "";
        setWorkerNameHint(workerDniLookupManualMode
          ? "Validación DNI no disponible. Escribe tu nombre completo manualmente."
          : "Ingresa tu DNI para consultar el nombre oficial.");
        return;
      }
      if (workerDniLookupManualMode) return;
      lookupWorkerNameByDni(sanitized, { silent: true });
    });
    document.getElementById("workerDniRegister").addEventListener("blur", (e) => {
      const dni = String(e.target.value || "").trim();
      if (workerDniLookupManualMode) return;
      if (dni.length === 8) lookupWorkerNameByDni(dni, { silent: true });
    });
    document.getElementById("adminLoginButton").addEventListener("click", adminLogin);
    document.getElementById("workerDniLogin").addEventListener("keydown", submitLoginOnEnter);
    document.getElementById("workerPasswordLogin").addEventListener("keydown", submitLoginOnEnter);
    document.getElementById("adminUser").addEventListener("keydown", submitLoginOnEnter);
    document.getElementById("adminPin").addEventListener("keydown", submitLoginOnEnter);
    document.getElementById("profileTrigger").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleProfileDropdown();
    });
    document.getElementById("profileInfoButton").addEventListener("click", showProfileInfo);
    document.getElementById("profileLogoutButton").addEventListener("click", () => {
      closeProfileDropdown();
      logout();
    });
    document.getElementById("createOrderButton").addEventListener("click", createOrder);
    document.getElementById("saveConfigButton").addEventListener("click", saveConfig);
    document.getElementById("publishPriceButton").addEventListener("click", publishPriceNow);
    document.getElementById("priceWeekStart").addEventListener("change", renderAll);
    document.getElementById("saveWeekPriceButton").addEventListener("click", saveWeekPrice);
    document.getElementById("publishWeekPriceButton").addEventListener("click", publishWeekPrice);
    document.getElementById("deleteWeekPriceButton").addEventListener("click", deleteWeekPrice);
    document.getElementById("saveTemplatesButton").addEventListener("click", saveNotificationTemplates);
    const createAdminUserButton = document.getElementById("createAdminUserButton");
    if (createAdminUserButton) {
      createAdminUserButton.addEventListener("click", createAdminFromPanel);
    }
    document.getElementById("createNoticeButton").addEventListener("click", createNotice);
    document.getElementById("cancelNoticeEditButton").addEventListener("click", () => cancelNoticeEdit(true));
    document.querySelectorAll("[data-admin-view]").forEach((button) => {
      button.addEventListener("click", () => setAdminView(button.dataset.adminView));
    });
    document.querySelectorAll(".admin-dropdown-trigger").forEach((button) => {
      button.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleAdminDropdown(button);
      });
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".admin-topbar")) closeAdminDropdowns();
      if (!e.target.closest(".profile-menu")) closeProfileDropdown();
    });
    document.getElementById("filterOrderDni").addEventListener("input", renderAll);
    document.getElementById("filterOrderStatus").addEventListener("change", renderAll);
    document.getElementById("filterOrderFrom").addEventListener("change", renderAll);
    document.getElementById("filterOrderTo").addEventListener("change", renderAll);
    document.getElementById("clearOrderFilters").addEventListener("click", clearOrderFilters);
    document.getElementById("exportOrdersButton").addEventListener("click", exportFilteredOrdersToExcel);
    document.getElementById("filterWorkerDni").addEventListener("input", renderAll);
    document.getElementById("filterWorkerName").addEventListener("input", renderAll);
    document.getElementById("filterWorkerContact").addEventListener("input", renderAll);
    document.getElementById("clearWorkerFilters").addEventListener("click", clearWorkerFilters);
    document.getElementById("filterNotifWorker").addEventListener("input", renderAll);
    document.getElementById("filterNotifChannel").addEventListener("change", renderAll);
    document.getElementById("filterNotifSent").addEventListener("change", renderAll);
    document.getElementById("filterNotifFrom").addEventListener("change", renderAll);
    document.getElementById("filterNotifTo").addEventListener("change", renderAll);
    document.getElementById("clearNotifFilters").addEventListener("click", clearNotificationFilters);
    document.getElementById("adminGlobalSearch").addEventListener("input", renderAll);
    document.getElementById("modalClose").addEventListener("click", closeNoticeModal);
    document.getElementById("noticeModal").addEventListener("click", (e) => { if (e.target.id === "noticeModal") closeNoticeModal(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeAdminDropdowns();
        closeProfileDropdown();
        closeNoticeModal();
      }
    });
    async function initializeApp() {
      try {
        const loadedData = await loadData();
        state.data = ensureStateDefaults(loadedData || buildDefaultState());
      } catch (error) {
        console.warn("No se pudo cargar estado inicial desde API.", error);
        showToast("No se pudo conectar con la base de datos.", "error");
        state.data = ensureStateDefaults(buildDefaultState());
      }
      await validateSession();
      if (isSuperAdminSession()) {
        await loadAdminUsers();
      }
      renderAll();
    }

    initializeApp();





