import type { Env } from "../../lib/types";
import { createProvider } from "../../lib/providerFactory";
import { jsonError, jsonOk, parseJsonBody, sanitizeForLog } from "../../lib/json";
import { isValidNonEmptyHex } from "../../lib/cardano";

function extractSubmitErrorDetail(error: unknown): string {
  if (error === null || error === undefined) return "Unknown submission error";
  if (typeof error === "string") return sanitizeForLog(error);
  if (error instanceof Error && error.message) return sanitizeForLog(error.message);
  if (typeof error === "object") {
    const obj = error as {
      data?: { message?: unknown };
      response?: { data?: { message?: unknown } };
      message?: unknown;
      error?: unknown;
    };
    const nested =
      obj.data?.message ??
      obj.response?.data?.message ??
      obj.message ??
      obj.error;
    if (nested !== undefined) return sanitizeForLog(String(nested));
    try {
      return sanitizeForLog(JSON.stringify(obj));
    } catch {
      return sanitizeForLog(String(obj));
    }
  }
  return sanitizeForLog(String(error));
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const body = await parseJsonBody(context.request);
    if (body instanceof Response) return body;
    const { signedTx } = body;

    if (!signedTx || typeof signedTx !== "string") {
      return jsonError("signedTx is required and must be a string");
    }
    if (signedTx.length > 65536) {
      return jsonError("signedTx payload too large");
    }
    if (!isValidNonEmptyHex(signedTx)) {
      return jsonError("signedTx must be a valid even-length hex string");
    }

    const provider = createProvider(context.env);
    console.log("[submit] submit start", {
      provider: context.env.MESH_PROVIDER ?? "blockfrost",
      signedTxHexLen: signedTx.length,
    });
    const txId = await provider.postTransactionToChain(signedTx);
    console.log("[submit] submit success", { txId });

    return jsonOk({ txId });
  } catch (error: unknown) {
    const message = extractSubmitErrorDetail(error);
    console.log("[submit] submit error", sanitizeForLog(message));
    console.error("Error submitting transaction:", sanitizeForLog(message));
    return jsonError("Failed to submit transaction", 500, message);
  }
};
