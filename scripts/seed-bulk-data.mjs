import "dotenv/config";

const PRODUCTION_SEED_ALLOWED = process.env.ALLOW_PROD_SEED === "true";

if (process.env.NODE_ENV === "production" && !PRODUCTION_SEED_ALLOWED) {
  throw new Error("Seed bloqueado. Define ALLOW_PROD_SEED=true para ejecutar en produccion.");
}

function toDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getCycleStart(referenceDate = new Date()) {
  const date = new Date(referenceDate);
  date.setHours(0, 0, 0, 0);
  let diff = date.getDay() - 3;
  if (diff < 0) diff += 7;
  date.setDate(date.getDate() - diff);
  return date;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomPick(list) {
  return list[randomInt(0, list.length - 1)];
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".");
}

function buildWorkers() {
  const firstNames = [
    "Carlos", "Luis", "Jorge", "Miguel", "Hector", "Ruben", "Alberto", "Julio", "Rene", "Daniel",
    "Marco", "Victor", "Nestor", "Javier", "Percy", "Wilmer", "Elvis", "Cesar", "Raul", "Edgar",
    "Antonio", "Sergio", "Milton", "Felix", "Roger", "Brayan", "Moises", "Angel", "Martin", "Cristian"
  ];
  const lastNames = [
    "Quispe", "Huaman", "Flores", "Rojas", "Torres", "Vargas", "Mendoza", "Castillo", "Soto", "Paredes",
    "Guevara", "Lopez", "Carrasco", "Ramos", "Espinoza", "Salas", "Navarro", "Cabrera", "Condori", "Rivera",
    "Alvarez", "Mamani", "Chavez", "Rosales", "Vera", "Campos", "Montoya", "Valdivia", "Luna", "Garcia"
  ];

  return Array.from({ length: 30 }, (_, index) => {
    const first = firstNames[index];
    const lastA = lastNames[index];
    const lastB = lastNames[(index + 9) % lastNames.length];
    const fullName = `${first} ${lastA} ${lastB}`;
    const dni = String(73000001 + index);
    const phone = `9${String(1000000 + index).padStart(7, "0")}1`;
    const email = `${normalizeText(first)}.${normalizeText(lastA)}${index + 1}@bluesales.pe`;
    const createdAt = new Date(Date.now() - randomInt(20, 140) * 86400000).toISOString();
    return {
      id: dni,
      name: fullName,
      phone,
      email,
      password: "Trab2026!",
      active: true,
      createdAt
    };
  });
}

function buildNotices(baseDate) {
  const notices = [
    {
      title: "Auditoria SMETA abril 2026 aprobada",
      summary: "Se obtuvo resultado favorable en trabajo digno, seguridad y salud ocupacional.",
      content: "La auditoria SMETA de abril 2026 concluyo sin no conformidades mayores. Se validaron condiciones laborales, seguridad en campo y controles de bienestar para todo el personal de cosecha.",
      area: "Sostenibilidad"
    },
    {
      title: "Segunda evaluacion SMETA a contratistas superada",
      summary: "Contratistas y proveedores de servicios agricolas cumplieron los estandares requeridos.",
      content: "En la revision SMETA de cadena de suministro local se verifico cumplimiento en jornadas, uso de EPP y trazabilidad de pagos. El resultado fue satisfactorio para continuidad operativa.",
      area: "Compliance"
    },
    {
      title: "Apertura de programa comercial internacional 2026",
      summary: "Se confirma inicio de envios a nuevo cliente internacional en mercado europeo.",
      content: "A partir de mayo 2026 se activan lotes para exportacion a la Union Europea. Se refuerza trazabilidad de campo a packing y control documental de inocuidad para embarques internacionales.",
      area: "Comercio Exterior"
    },
    {
      title: "Plan de riego tecnificado para bloques productivos",
      summary: "Se inicia calibracion de caudales y monitoreo de humedad por sector.",
      content: "El equipo agricola implementa ajustes de riego por bloque para mejorar eficiencia hidrica y uniformidad de fruta. Se realizaran controles semanales con reportes por fundo.",
      area: "Produccion Agricola"
    },
    {
      title: "Refuerzo de manejo integrado de plagas en arandano",
      summary: "Actualizacion de monitoreo preventivo y acciones de control biologico.",
      content: "Se amplia el plan MIP con inspecciones programadas, liberacion controlada de agentes biologicos y seguimiento de umbrales de intervencion para proteger rendimiento y calidad.",
      area: "Sanidad Vegetal"
    }
  ];

  return notices.map((notice, index) => {
    const publishDateObj = new Date(baseDate);
    publishDateObj.setDate(baseDate.getDate() - (4 - index));
    const publishDate = toDateKey(publishDateObj);
    return {
      id: `notice_seed_${index + 1}`,
      ...notice,
      publishDate,
      archived: false,
      createdAt: new Date(`${publishDate}T08:00:00`).toISOString()
    };
  });
}

function weightedStatus() {
  const roll = Math.random();
  if (roll < 0.7) return "delivered";
  if (roll < 0.82) return "ready";
  if (roll < 0.92) return "approved";
  return "requested";
}

function buildOrders(workers, cycleStarts) {
  const distribution = [22, 34, 39, 47, 58];
  const prices = [20.9, 21.4, 22.0, 22.8, 23.2];
  const kgOptions = [0.5, 1, 1.5, 2];
  const orders = [];

  cycleStarts.forEach((cycleStart, weekIndex) => {
    const cycleKey = toDateKey(cycleStart);
    const qty = distribution[weekIndex];
    const pricePerKg = prices[weekIndex];

    for (let i = 0; i < qty; i += 1) {
      const worker = randomPick(workers);
      const kg = randomPick(kgOptions);
      const status = weightedStatus();

      const createdAt = new Date(cycleStart);
      createdAt.setDate(cycleStart.getDate() + randomInt(0, 5));
      createdAt.setHours(randomInt(7, 18), randomInt(0, 59), randomInt(0, 59), 0);

      const deliveryDate = new Date(cycleStart);
      deliveryDate.setDate(cycleStart.getDate() + 9);
      deliveryDate.setHours(0, 0, 0, 0);

      const total = Number((kg * pricePerKg).toFixed(2));
      orders.push({
        id: `ord_seed_${weekIndex + 1}_${String(i + 1).padStart(3, "0")}`,
        workerId: worker.id,
        workerName: worker.name,
        workerPhone: worker.phone,
        workerEmail: worker.email,
        cycleKey,
        kg,
        pricePerKg,
        total,
        status,
        createdAt: createdAt.toISOString(),
        deliveryDate: deliveryDate.toISOString()
      });
    }
  });

  return { orders, distribution, prices };
}

function buildWeeklyPrices(cycleStarts, prices) {
  const weeklyPrices = {};
  cycleStarts.forEach((cycleStart, index) => {
    const key = toDateKey(cycleStart);
    weeklyPrices[key] = {
      pricePerKg: prices[index],
      published: true
    };
  });
  return weeklyPrices;
}

async function main() {
  const { getState, persistState } = await import("../src/modules/state/state.repository.js");
  const currentState = await getState();
  const now = new Date();
  const currentCycle = getCycleStart(now);
  const cycleStarts = Array.from({ length: 5 }, (_, index) => {
    const d = new Date(currentCycle);
    d.setDate(currentCycle.getDate() - ((4 - index) * 7));
    return d;
  });

  const workers = buildWorkers();
  const notices = buildNotices(now);
  const { orders, distribution, prices } = buildOrders(workers, cycleStarts);
  const weeklyPrices = buildWeeklyPrices(cycleStarts, prices);

  const nextState = {
    ...currentState,
    settings: {
      ...(currentState.settings || {}),
      weeklyPrices,
      pricePerKg: prices[prices.length - 1],
      pricePublishedCycle: toDateKey(cycleStarts[cycleStarts.length - 1])
    },
    users: workers,
    notices,
    orders,
    notifications: [],
    orderHistory: [],
    noticeReads: {},
    demoSeedVersion: Number(currentState.demoSeedVersion || 1) + 1
  };

  await persistState(nextState);

  console.log("Carga completada:");
  console.log(`- Trabajadores: ${workers.length}`);
  console.log(`- Comunicados: ${notices.length}`);
  console.log(`- Pedidos: ${orders.length}`);
  console.log(`- Distribucion semanal: ${distribution.join(", ")}`);
}

await main();
