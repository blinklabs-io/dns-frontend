import type { Env } from "../../lib/types";
import { createProvider } from "../../lib/providerFactory";
import { jsonError, jsonOk, parseJsonBody, sanitizeForLog } from "../../lib/json";
import { toBech32Address, isSpendableBech32Address } from "../../lib/cardano";

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const body = await parseJsonBody(context.request);
    if (body instanceof Response) return body;
    const { address } = body;

    if (!address) {
      return jsonError("address is required");
    }

    const normalizedAddress = toBech32Address(String(address));
    if (!isSpendableBech32Address(normalizedAddress)) {
      return jsonError(
        "address must be a valid spendable bech32 payment address",
      );
    }

    const provider = createProvider(context.env);
    const utxos = await provider.getUnspentOutputs(normalizedAddress);

    return jsonOk({ address: normalizedAddress, utxos });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error fetching address UTxOs:", sanitizeForLog(message));
    return jsonError("Failed to fetch address UTxOs", 500);
  }
};
