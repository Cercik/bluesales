import { ZodError } from "zod";

function formatValidationErrors(error) {
  if (!(error instanceof ZodError)) return ["Payload inválido."];
  return error.issues.map((issue) => {
    const path = Array.isArray(issue.path) && issue.path.length ? `${issue.path.join(".")}: ` : "";
    return `${path}${issue.message}`;
  });
}

export function parseBody(schema, req, res) {
  return parseInput(schema, req.body || {}, res);
}

export function parseInput(schema, rawInput, res) {
  const result = schema.safeParse(rawInput);
  if (result.success) return result.data;
  const errors = formatValidationErrors(result.error);
  res.status(400).json({
    message: "Payload inválido.",
    errors
  });
  return null;
}

