import { z } from "zod";

const dniSchema = z.string().trim().regex(/^\d{8}$/, "DNI inválido.");
const emailSchema = z.string().trim().email("Correo inválido.").max(120, "Correo demasiado largo.");
const nameSchema = z.string().trim().min(1, "Nombre requerido.").max(120, "Nombre demasiado largo.");
const phoneSchema = z.string().trim().regex(/^\d{9,12}$/, "Celular inválido.");
const passwordSchema = z.string().min(8, "Contraseña inválida. Mínimo 8 caracteres.").max(128, "Contraseña demasiado larga.");
const workerLoginPasswordSchema = z
  .string()
  .min(4, "Contraseña inválida.")
  .max(128, "Contraseña demasiado larga.");
const orderIdSchema = z.string().trim().regex(/^[A-Za-z0-9_-]{4,120}$/, "orderId inválido.");
const adminUsernameSchema = z.string().trim().min(3, "Usuario admin inválido.").max(80, "Usuario admin demasiado largo.").regex(/^[A-Za-z0-9._-]+$/, "Usuario admin inválido.");

export const loginBodySchema = z.discriminatedUnion("role", [
  z
    .object({
      role: z.literal("admin"),
      user: z.string().trim().min(1, "Usuario requerido.").max(80, "Usuario demasiado largo."),
      pin: z.string().trim().min(6, "PIN inválido.").max(20, "PIN demasiado largo.")
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
    kg: z.number().positive("Cantidad inválida.").max(2, "Máximo 2 Kg por persona.")
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
      sessionId: z.string().trim().uuid("sessionId inválido."),
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
        message: "Contraseña inválida. Mínimo 8 caracteres.",
        path: ["password"]
      });
    }
  });

