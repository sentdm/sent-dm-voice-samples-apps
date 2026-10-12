import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { NotConfiguredError } from "./config-store";
import { SentApiError } from "./sent-api";
import { SetupPasswordError } from "./setup-password";
import { TransferError } from "./transfer";

/** One error shape for everything this app's own API answers. */
export interface AppErrorBody {
  error: string;
  code?: string | null;
  details?: unknown;
}

export function jsonError(
  status: number,
  error: string,
  extra: Omit<AppErrorBody, "error"> = {}
): NextResponse<AppErrorBody> {
  return NextResponse.json({ error, ...extra }, { status });
}

export function handleRouteError(error: unknown): NextResponse<AppErrorBody> {
  if (error instanceof NotConfiguredError) return jsonError(503, error.message);
  if (error instanceof SetupPasswordError)
    return jsonError(401, error.message, { code: "setup_password" });
  if (error instanceof ZodError) {
    return jsonError(400, "The request is not valid", {
      details: error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  if (error instanceof SentApiError) {
    return jsonError(error.status === 0 ? 502 : error.status, error.message, {
      code: error.code,
      details: error.details,
    });
  }
  if (error instanceof TransferError) {
    return jsonError(409, error.message, { details: error.steps });
  }
  if (error instanceof SyntaxError)
    return jsonError(400, "The body is not valid JSON");
  console.error(error);
  return jsonError(
    500,
    error instanceof Error ? error.message : "Unexpected error"
  );
}

export async function readJsonBody<T = unknown>(request: Request): Promise<T> {
  const text = await request.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}
