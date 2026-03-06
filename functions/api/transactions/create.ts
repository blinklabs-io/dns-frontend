import type { Env } from "../../lib/types";
import { createProvider } from "../../lib/providerFactory";
import { jsonError, jsonOk, parseJsonBody, sanitizeForLog } from "../../lib/json";
import {
  toBech32Address,
  isSpendableBech32Address,
  normalizeAssetId,
} from "../../lib/cardano";
import { parseAdaToLovelace } from "../../lib/validation";

type Amount = { unit: string; quantity: string };

function toAmount(unit: string, quantity: bigint | number): Amount {
  return { unit, quantity: BigInt(quantity).toString() };
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const body = await parseJsonBody(context.request);
    if (body instanceof Response) return body;
    const { recipientAddress, amount, address, assetId } = body;

    if (!recipientAddress || !amount || !address || !assetId) {
      return jsonError(
        "recipientAddress, amount, address, and assetId are required",
      );
    }
    if (typeof assetId !== "string") {
      return jsonError("assetId must be a string");
    }

    const normalizedRecipient = toBech32Address(String(recipientAddress));
    const normalizedSender = toBech32Address(String(address));
    if (
      !isSpendableBech32Address(normalizedRecipient) ||
      !isSpendableBech32Address(normalizedSender)
    ) {
      return jsonError(
        "recipientAddress/address must be valid spendable bech32 payment addresses",
      );
    }

    const provider = createProvider(context.env);
    const utxos = await provider.getUnspentOutputs(normalizedSender);

    const { MeshTxBuilder, LargestFirstInputSelector } = await import("@meshsdk/core");
    const txBuilder = new MeshTxBuilder({
      fetcher: provider,
      selector: new LargestFirstInputSelector(),
      verbose: false,
    });

    let targetAssets: Amount[];
    try {
      if (assetId === "lovelace") {
        targetAssets = [toAmount("lovelace", parseAdaToLovelace(amount as string | number))];
      } else {
        const amountStr = String(amount);
        if (!/^[1-9]\d*$/.test(amountStr)) {
          return jsonError(
            "Non-lovelace asset amount must be a positive whole number",
          );
        }
        targetAssets = [
          toAmount(normalizeAssetId(assetId as string), BigInt(amountStr)),
        ];
      }
    } catch (validationError: unknown) {
      const msg = validationError instanceof Error ? validationError.message : String(validationError);
      return jsonError(msg);
    }

    txBuilder
      .txOut(normalizedRecipient, targetAssets)
      .changeAddress(normalizedSender)
      .selectUtxosFrom(utxos);
    const unsignedTx = await txBuilder.complete();

    return jsonOk({ unsignedTx });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error creating transaction:", sanitizeForLog(message));
    return jsonError("Failed to create transaction", 500, sanitizeForLog(message));
  }
};
