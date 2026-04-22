import { z } from "zod";

const dniSchema = z.string().trim().regex(/^\d{8}$/, "DNI invalido.");
const emailSchema = z.string().trim().email("Correo invalido.").max(120, "Correo demasiado largo.");
const nameSchema = z.string().trim().min(1, "Nombre requerido.").max(120, "Nombre demasiado largo.");
const phoneSchema = z.string().trim().regex(/^\d{9,12}$/, "Celular invalido.");
const passwordSchema = z.string().min(8, "Contrasena invalida. Minimo 8 caracteres.").max(128, "Contrasena demasiado larga.");
const workerLoginPasswordSchema = z
  .string()
  .min(4, "Contrasena invalida.")
  .max(128, "Contrasena demasiado larga.");
const orderIdSchema = z.string().trim().regex(/^[A-Za-z0-9_-]{4,120}$/, "orderId invalido.");
const adminUsernameSchema = z.string().trim().min(3, "Usuario admin invalido.").max(80, "Usuario admin demasiado largo.").regex(/^[A-Za-z0-9._-]+$/, "Usuario admin invalido.");

export const loginBodySchema = z.discriminatedUnion("role", [
  z
    .object({
      role: z.literal("admin"),
      user: z.string().trim().min(1, "Usuario requerido.").max(80, "Usuario demasiado largo."),
      pin: z.string().trim().min(6, "PIN invalido.").max(20, "PIN demasiado largo.")
    })
    .strict(),
  z
    .object({
      role: z.literal("worker"),
      id: dniSchema,
      password: workerLoginPasswordSchema
    })
    .strict()
]);

export const registerBodySchema = z
  .object({
    id: dniSchema,
    name: nameSchema,
    phone: phoneSchema,
    email: emailSchema,
    password: passwordSchema
  })
  .strict();

export const exportOrdersTemplateBodySchema = z
  .object({
    orders: z.array(z.object({}).passthrough()).max(5000, "Demasiados pedidos para exportar."),
    rangeFrom: z.string().trim().optional(),
    rangeTo: z.string().trim().optional()
  })
  .strict();

export const stateUpdateBodySchema = z
  .object({
    data: z.object({}).passthrough()
  })
  .strict();

export const workerCreateOrderBodySchema = z
  .object({
    kg: z.number().positive("Cantidad invalida.").max(2, "Maximo 2 Kg por persona.")
  })
  .strict();

export const workerOrderParamsSchema = z
  .object({
    orderId: orderIdSchema
  })
  .strict();

export const dniLookupParamsSchema = z
  .object({
    dni: dniSchema
  })
  .strict();

export const dniLookupQuerySchema = z
  .object({
    dni: dniSchema
  })
  .strict();

export const authRevokeBodySchema = z.union([
  z
    .object({
      sessionId: z.string().trim().uuid("sessionId invalido."),
      reason: z.string().trim().max(200, "Motivo demasiado largo.").optional()
    })
    .strict(),
  z
    .object({
      role: z.enum(["super_admin", "admin", "worker"]),
      id: z.string().trim().min(1, "id requerido.").max(80, "id demasiado largo."),
      reason: z.string().trim().max(200, "Motivo demasiado largo.").optional()
    })
    .strict()
]);

export const adminUserCreateBodySchema = z
  .object({
    username: adminUsernameSchema,
    name: z.string().trim().min(1, "Nombre requerido.").max(120, "Nombre demasiado largo."),
    password: passwordSchema
  })
  .strict();

export const legacyCreateUserBodySchema = z
  .object({
    id: z.string().trim().optional(),
    dni: z.string().trim().optional(),
    name: z.string().trim().max(120).optional(),
    email: emailSchema,
    password: passwordSchema.optional(),
    password_hash: z.string().trim().optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasId = Boolean(String(value.id || value.dni || "").trim());
    if (!hasId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "id/dni requerido.",
        path: ["id"]
      });
    }
    const pass = String(value.password || value.password_hash || "");
    if (pass.length < 8) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Contrasena invalida. Minimo 8 caracteres.",
        path: ["password"]
      });
    }
  });
