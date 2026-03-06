import type { Env } from "../../lib/types";
import { createProvider } from "../../lib/providerFactory";
import { jsonError, jsonOk, parseJsonBody, sanitizeForLog } from "../../lib/json";
import {
  toBech32Address,
  isSpendableBech32Address,
  normalizeAssetId,
} from "../../lib/cardano";
import { createReferenceTokenTN } from "../../lib/sldBuilder";

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const body = await parseJsonBody(context.request);
    if (body instanceof Response) return body;
    const { tldRefAddress, sldRefAddress, tldName, sldName, csTld, csSld } =
      body;

    if (
      !tldRefAddress ||
      !sldRefAddress ||
      !tldName ||
      !sldName ||
      !csTld ||
      !csSld
    ) {
      return jsonError(
        "tldRefAddress, sldRefAddress, tldName, sldName, csTld, csSld are required",
      );
    }
    if (
      typeof tldName !== "string" ||
      typeof sldName !== "string" ||
      typeof csTld !== "string" ||
      typeof csSld !== "string"
    ) {
      return jsonError("tldName, sldName, csTld, csSld must be strings");
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
    if (
      !/^[0-9a-fA-F]{56}$/.test(csTld) ||
      !/^[0-9a-fA-F]{56}$/.test(csSld)
    ) {
      return jsonError(
        "csTld and csSld must be valid 56-character hex policy IDs",
      );
    }
    const canonicalCsTld = csTld.toLowerCase();
    const canonicalCsSld = csSld.toLowerCase();

    const normalizedTldRefAddress = toBech32Address(String(tldRefAddress));
    const normalizedSldRefAddress = toBech32Address(String(sldRefAddress));
    if (
      !isSpendableBech32Address(normalizedTldRefAddress) ||
      !isSpendableBech32Address(normalizedSldRefAddress)
    ) {
      return jsonError(
        "tldRefAddress/sldRefAddress must be valid spendable bech32 payment addresses",
      );
    }

    const provider = createProvider(context.env);
    const tldRefUnit = `${canonicalCsTld}.${createReferenceTokenTN(tldName)}`;
    const sldRefUnit = `${canonicalCsSld}.${createReferenceTokenTN(sldName)}`;

    const [tldUtxos, sldUtxos] = await Promise.all([
      provider.getUnspentOutputs(normalizedTldRefAddress),
      provider.getUnspentOutputs(normalizedSldRefAddress),
    ]);

    const findUtxoWithAsset = (
      utxos: Array<{
        input: { txHash: string; outputIndex: number };
        output: { amount?: Array<{ unit: string }> };
      }>,
      assetId: string,
    ) => {
      const target = normalizeAssetId(assetId);
      for (const utxo of utxos) {
        for (const amt of utxo.output.amount ?? []) {
          if (normalizeAssetId(amt.unit) === target) return utxo;
        }
      }
      return null;
    };

    const tldRefUtxo = findUtxoWithAsset(tldUtxos, tldRefUnit);
    const sldRefUtxo = findUtxoWithAsset(sldUtxos, sldRefUnit);

    if (!tldRefUtxo) {
      return jsonError(
        "TLD reference UTxO not found at tldRefAddress",
        404,
      );
    }
    if (!sldRefUtxo) {
      return jsonError(
        "SLD reference UTxO not found at sldRefAddress",
        404,
      );
    }

    return jsonOk({
      tldReferenceRef: {
        txHash: tldRefUtxo.input.txHash,
        txIndex: tldRefUtxo.input.outputIndex,
      },
      sldReferenceRef: {
        txHash: sldRefUtxo.input.txHash,
        txIndex: sldRefUtxo.input.outputIndex,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error fetching reference refs:", sanitizeForLog(message));
    return jsonError("Failed to fetch reference refs", 500, sanitizeForLog(message));
  }
};
