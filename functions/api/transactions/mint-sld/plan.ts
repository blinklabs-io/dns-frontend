import type { Env } from "../../../lib/types";
import { jsonError, jsonOk, parseJsonBody, sanitizeForLog } from "../../../lib/json";
import { isValidNonEmptyHex } from "../../../lib/cardano";
import { prepareSldMintArtifacts } from "../../../lib/sldBuilder";

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const body = await parseJsonBody(context.request);
    if (body instanceof Response) return body;
    const {
      tldName,
      sldName,
      csTld,
      csSld,
      currentSldHexList = [],
    } = body;

    if (!tldName || !sldName || !csTld || !csSld) {
      return jsonError("tldName, sldName, csTld, csSld are required");
    }
    if (
      typeof tldName !== "string" ||
      typeof sldName !== "string" ||
      typeof csTld !== "string" ||
      typeof csSld !== "string"
    ) {
      return jsonError("tldName, sldName, csTld, csSld must be strings");
    }
    if (
      !/^[0-9a-fA-F]{56}$/.test(csTld) ||
      !/^[0-9a-fA-F]{56}$/.test(csSld)
    ) {
      return jsonError(
        "csTld and csSld must be valid 56-character hex policy IDs",
      );
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
        "tldName and sldName must contain only alphanumeric characters and hyphens, and must not start or end with a hyphen",
      );
    }
    if (!Array.isArray(currentSldHexList)) {
      return jsonError("currentSldHexList must be an array");
    }
    if (currentSldHexList.length > 1000) {
      return jsonError("currentSldHexList too large (max 1000 entries)");
    }
    for (const sldHex of currentSldHexList as unknown[]) {
      if (typeof sldHex !== "string" || !isValidNonEmptyHex(sldHex)) {
        return jsonError(
          "currentSldHexList must contain only non-empty valid hex strings",
        );
      }
      if (sldHex.length > 128) {
        return jsonError(
          "Individual SLD hex entry too large (max 64 bytes)",
        );
      }
    }

    const artifacts = prepareSldMintArtifacts({
      tldName,
      sldName,
      csTld,
      csSld,
      currentSldHexList: currentSldHexList as string[],
    });

    return jsonOk({ message: "Prepared SLD mint artifacts", artifacts });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      "Error preparing SLD mint artifacts:",
      sanitizeForLog(message),
    );
    return jsonError("Failed to prepare SLD mint artifacts", 500, sanitizeForLog(message));
  }
};
