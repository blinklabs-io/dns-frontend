import type { Env } from "../../../lib/types";
import { createProvider } from "../../../lib/providerFactory";
import { jsonError, jsonOk, parseJsonBody, sanitizeForLog } from "../../../lib/json";
import { toBech32Address, isSpendableBech32Address } from "../../../lib/cardano";
import { checkSldAvailability as checkSldAvailabilityService } from "../../../lib/sldMintPlanner";

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const body = await parseJsonBody(context.request);
    if (body instanceof Response) return body;
    const { csTld, tldName, sldName, tldRefAddress } = body;

    if (!csTld || !tldName || !sldName || !tldRefAddress) {
      return jsonError(
        "csTld, tldName, sldName, tldRefAddress are required",
      );
    }
    if (
      typeof tldName !== "string" ||
      typeof sldName !== "string" ||
      typeof csTld !== "string"
    ) {
      return jsonError("tldName, sldName, csTld must be strings");
    }
    if (tldName.length > 64 || sldName.length > 64) {
      return jsonError(
        "tldName and sldName must not exceed 64 characters",
      );
    }
    if (
      !/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(tldName) ||
      !/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(sldName)
    ) {
      return jsonError(
        "tldName and sldName must be alphanumeric with optional hyphens",
      );
    }
    if (!/^[0-9a-fA-F]{56}$/.test(csTld)) {
      return jsonError(
        "csTld must be a valid 56-character hex policy ID",
      );
    }

    const normalizedTldRefAddress = toBech32Address(String(tldRefAddress));
    if (!isSpendableBech32Address(normalizedTldRefAddress)) {
      return jsonError(
        "tldRefAddress must be a valid spendable bech32 payment address",
      );
    }

    const provider = createProvider(context.env);
    const result = await checkSldAvailabilityService({
      provider,
      csTld,
      tldName,
      sldName,
      tldRefAddress: normalizedTldRefAddress,
    });

    return jsonOk(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      "Error checking SLD availability:",
      sanitizeForLog(message),
    );
    return jsonError("Failed to check SLD availability", 500);
  }
};
