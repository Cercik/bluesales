export function buildDefaultState() {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const nowDate = new Date();
  nowDate.setHours(0, 0, 0, 0);
  let diff = nowDate.getDay() - 3;
  if (diff < 0) diff += 7;
  const cycleStart = new Date(nowDate);
  cycleStart.setDate(nowDate.getDate() - diff);
  const cycleKey = cycleStart.toISOString().slice(0, 10);

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
        whatsapp: "BlueSales: tu pedido {{orderId}} ahora esta en estado {{status}}. Entrega estimada: {{deliveryDate}}.",
        email: "BlueSales: tu pedido {{orderId}} ahora esta en estado {{status}}. Entrega estimada: {{deliveryDate}}."
      }
    },
    notices: [
      {
        id: `notice_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36)}`,
        title: "Campana de cosecha 2026",
        summary: "Inicia el 20 de abril. Revise turno actualizado.",
        content:
          "Inicio oficial: 20 de abril de 2026.\\n\\nSe pide puntualidad y registro de asistencia.\\nEl cronograma de turnos se valida con RR.HH.",
        area: "RR.HH.",
        publishDate: today,
        archived: false,
        createdAt: now
      },
      {
        id: `notice_${Math.random().toString(36).slice(2, 9)}${(Date.now() + 1).toString(36)}`,
        title: "Control de calidad",
        summary: "Nuevo protocolo de empaque entra en vigencia.",
        content: "Se refuerza verificacion de calibre, firmeza y temperatura.\\nRegistrar observaciones en formato QC-04.",
        area: "Calidad",
        publishDate: today,
        archived: false,
        createdAt: now
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
