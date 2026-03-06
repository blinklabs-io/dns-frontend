import type { Env } from "../../../../lib/types";
import {
  jsonError,
  jsonOk,
  sanitizeForLog,
  serializeBigInts,
} from "../../../../lib/json";
import { prepareSldMintPreflight } from "../../../../lib/validation";
import { buildSldMintPlan } from "../../../../lib/sldMintPlanner";

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const preflight = await prepareSldMintPreflight(context.request, context.env);
    if (preflight instanceof Response) return preflight;
    const { validated, provider, ownerAddress } = preflight;

    const plan = await buildSldMintPlan({
      provider,
      ...validated,
      ownerAddress,
    });

    return jsonOk({
      message: "Prepared SLD mint plan",
      plan: serializeBigInts(plan),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      "Error building SLD mint plan:",
      sanitizeForLog(message),
    );
    return jsonError("Failed to build SLD mint plan", 500, sanitizeForLog(message));
  }
};
