/**
 * JSON response helpers for Cloudflare Pages Functions.
 *
 * Replaces the Express `res.json()` / `res.status().json()` patterns
 * with Workers-native `Response.json()` calls, plus utility functions
 * for safe logging and BigInt serialization.
 */

/**
 * Sanitize user-provided strings for safe logging.
 * Strips newlines and control characters to prevent log injection.
 * Uses charCode-based filtering to avoid Biome noControlCharactersInRegex.
 */
export function sanitizeForLog(value: unknown): string {
  const str = String(value);
  let result = "";
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code === 0x0d || code === 0x0a) {
      // Collapse consecutive \r\n into a single space
      if (result.length === 0 || result[result.length - 1] !== " ") {
        result += " ";
      }
    } else if (code <= 0x1f || code === 0x7f) {
      // Strip other control characters
    } else {
      result += str[i];
    }
  }
  return result;
}

/**
 * Recursively converts BigInt values to strings for JSON serialization.
 */
export function serializeBigInts<T>(
  obj: T,
  visited?: WeakSet<object>,
): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "bigint") return obj.toString() as unknown as T;
  if (typeof obj !== "object") return obj;
  const seen = visited ?? new WeakSet<object>();
  if (seen.has(obj as object)) return "[Circular]" as unknown as T;
  seen.add(obj as object);
  if (Array.isArray(obj))
    return obj.map((v) => serializeBigInts(v, seen)) as unknown as T;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = serializeBigInts(value, seen);
  }
  return result as T;
}

/**
 * Return a JSON error response.
 *
 * Optional `details` can be included for actionable client-facing errors
 * (for example, transaction validation failures returned by chain providers).
 */
export function jsonError(
  message: string,
  status = 400,
  details?: string,
): Response {
  if (details) {
    return Response.json({ error: message, details }, { status });
  }
  return Response.json({ error: message }, { status });
}

/**
 * Return a JSON success response (HTTP 200).
 */
export function jsonOk(data: unknown): Response {
  return Response.json(data);
}

/**
 * Parse a JSON request body, returning the parsed object or an error Response.
 * Handles malformed JSON (returns 400) and non-object bodies (returns 400).
 */
export async function parseJsonBody(
  request: Request,
): Promise<Record<string, unknown> | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON in request body");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonError("Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}
