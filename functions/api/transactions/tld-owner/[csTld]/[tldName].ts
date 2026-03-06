import type { Env } from "../../../../lib/types";
import { createProvider } from "../../../../lib/providerFactory";
import { jsonError, jsonOk, sanitizeForLog } from "../../../../lib/json";
import { resolveTldOwner } from "../../../../lib/validation";

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const csTld = context.params.csTld as string;
    const tldName = context.params.tldName as string;

    if (!csTld || !/^[0-9a-fA-F]{56}$/.test(csTld)) {
      return jsonError("csTld must be a 56-char hex policy ID");
    }
    const canonicalCsTld = csTld.toLowerCase();
    if (
      !tldName ||
      !/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(tldName) ||
      tldName.length > 64
    ) {
      return jsonError(
        "tldName must be alphanumeric with hyphens, max 64 chars",
      );
    }

    const provider = createProvider(context.env);
    const result = await resolveTldOwner(provider, canonicalCsTld, tldName);
    if ("status" in result) {
      return Response.json(result.body, { status: result.status });
    }

    const asset = `${canonicalCsTld}${result.userTokenHex}`;
    return jsonOk({ ownerAddress: result.address, asset });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error looking up TLD owner:", sanitizeForLog(message));
    return jsonError("Failed to look up TLD owner", 500, sanitizeForLog(message));
  }
};
