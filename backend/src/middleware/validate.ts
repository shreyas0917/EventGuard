import { Request, Response, NextFunction } from "express";
import { ZodTypeAny } from "zod";

interface RequestSchemas {
  params?: ZodTypeAny;
  query?: ZodTypeAny;
  body?: ZodTypeAny;
}

interface ValidationIssue {
  location: "params" | "query" | "body";
  path: string;
  message: string;
}

/**
 * Validate and normalise request parts with zod. On success the parsed values
 * (trimmed strings, coerced numbers, defaults) replace the raw ones; on failure
 * the request is rejected with 400 before any handler or database work runs.
 */
export function validate(schemas: RequestSchemas) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const issues: ValidationIssue[] = [];

    for (const location of ["params", "query", "body"] as const) {
      const schema = schemas[location];
      if (!schema) continue;

      const result = schema.safeParse(req[location] ?? {});
      if (result.success) {
        (req as any)[location] = result.data;
      } else {
        for (const issue of result.error.issues) {
          issues.push({ location, path: issue.path.join("."), message: issue.message });
        }
      }
    }

    if (issues.length > 0) {
      res.status(400).json({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: issues,
        },
      });
      return;
    }

    next();
  };
}
