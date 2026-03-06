import type { Env } from "../../../lib/types";
import {
  jsonError,
  jsonOk,
  sanitizeForLog,
  serializeBigInts,
} from "../../../lib/json";
import { prepareSldMintPreflight } from "../../../lib/validation";
import { buildSldMintTx } from "../../../lib/sldMintBuilder";

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const preflight = await prepareSldMintPreflight(context.request, context.env);
    if (preflight instanceof Response) return preflight;
    const { validated, provider, ownerAddress } = preflight;

    const txResult = await buildSldMintTx({
      provider,
      ...validated,
      ownerAddress,
    });

    return jsonOk({
      message: "Built unsigned SLD mint transaction",
      unsignedTx: txResult.unsignedTx,
      plan: serializeBigInts(txResult.plan),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error building SLD mint tx:", sanitizeForLog(message));
    return jsonError("Failed to build SLD mint transaction", 500, sanitizeForLog(message));
  }
};
