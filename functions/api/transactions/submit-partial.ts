/**
 * Assemble an unsigned transaction with wallet-provided witnesses, then submit.
 *
 * Uses the pure-JS `@stricahq/cbors` library for CBOR encode/decode so the
 * endpoint runs in Cloudflare Workers without WASM dependencies.
 *
 * IMPORTANT: The transaction body bytes must be preserved exactly as-is.
 * Re-encoding them through CBOR would change the byte representation
 * (e.g. map key ordering, integer encoding width), which would change the
 * transaction hash and invalidate signatures.  We use getByteSpan() from
 * the decoded CBOR objects to extract raw byte ranges from the original
 * buffer and only re-encode the merged witness set.
 */

import { Decoder, Encoder } from "@stricahq/cbors";
import type { Env } from "../../lib/types";
import { createProvider } from "../../lib/providerFactory";
import {
  jsonError,
  jsonOk,
  parseJsonBody,
  sanitizeForLog,
} from "../../lib/json";
import { isValidNonEmptyHex, bytesToHex } from "../../lib/cardano";

const MAX_TX_HEX_LENGTH = 65536; // 32 KB binary

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

/** Extract CBOR byte span from a decoded object (CborMap, CborArray, CborTag, Buffer, BigNumber). */
function getCborByteSpan(value: unknown): [number, number] | null {
  if (
    value !== null &&
    typeof value === "object" &&
    "getByteSpan" in value &&
    typeof (value as { getByteSpan?: unknown }).getByteSpan === "function"
  ) {
    return (value as { getByteSpan: () => [number, number] }).getByteSpan();
  }
  return null;
}

/**
 * Normalize witness map keys to JS numbers.
 * CBOR decoders can represent integer keys as number-like objects.
 */
function normalizeWitnessMapKeys(input: Map<unknown, unknown>): Map<number, unknown> {
  const normalized = new Map<number, unknown>();
  for (const [rawKey, value] of input.entries()) {
    let key: number;
    if (typeof rawKey === "number") {
      key = rawKey;
    } else if (
      rawKey !== null &&
      typeof rawKey === "object" &&
      "toNumber" in rawKey &&
      typeof (rawKey as { toNumber?: unknown }).toNumber === "function"
    ) {
      key = (rawKey as { toNumber: () => number }).toNumber();
    } else {
      throw new Error(`Invalid witness map key type: ${typeof rawKey}`);
    }
    if (!Number.isInteger(key) || key < 0) {
      throw new Error(`Invalid witness map key value: ${String(rawKey)}`);
    }
    normalized.set(key, value);
  }
  return normalized;
}

function cborEncodeUnsignedInt(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid unsigned integer for CBOR encoding: ${value}`);
  }
  if (value < 24) return Buffer.from([value]);
  if (value <= 0xff) return Buffer.from([0x18, value]);
  if (value <= 0xffff) return Buffer.from([0x19, (value >> 8) & 0xff, value & 0xff]);
  if (value <= 0xffffffff) {
    return Buffer.from([
      0x1a,
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    ]);
  }
  throw new Error(`CBOR uint too large: ${value}`);
}

function cborEncodeMapHeader(size: number): Buffer {
  if (!Number.isInteger(size) || size < 0) {
    throw new Error(`Invalid CBOR map size: ${size}`);
  }
  if (size < 24) return Buffer.from([0xa0 + size]);
  if (size <= 0xff) return Buffer.from([0xb8, size]);
  if (size <= 0xffff) return Buffer.from([0xb9, (size >> 8) & 0xff, size & 0xff]);
  if (size <= 0xffffffff) {
    return Buffer.from([
      0xba,
      (size >>> 24) & 0xff,
      (size >>> 16) & 0xff,
      (size >>> 8) & 0xff,
      size & 0xff,
    ]);
  }
  throw new Error(`CBOR map too large: ${size}`);
}

function cborValueBytesFromSource(
  value: unknown,
  source: Buffer,
): Buffer | null {
  const span = getCborByteSpan(value);
  if (!span) return null;
  return source.subarray(span[0], span[1]);
}

/**
 * Merge vkey witnesses (key 0) by vkey bytes.
 *
 * Each witness entry is expected to be `[vkeyBytes, signatureBytes]`.
 */
function mergeVkeyWitnesses(existing: unknown, wallet: unknown): unknown[] {
  const existingArr = Array.isArray(existing) ? existing : [];
  const walletArr = Array.isArray(wallet) ? wallet : [];
  const merged = [...existingArr];
  const seen = new Set<string>();

  for (const w of existingArr) {
    if (Array.isArray(w) && w.length > 0) {
      seen.add(bytesToHex(w[0]));
    }
  }
  for (const w of walletArr) {
    if (!Array.isArray(w) || w.length === 0) continue;
    const vkeyHex = bytesToHex(w[0]);
    if (!seen.has(vkeyHex)) {
      merged.push(w);
      seen.add(vkeyHex);
    }
  }
  return merged;
}

/**
 * Build witness set bytes while preserving existing script witness bytes exactly.
 *
 * Only key 0 (vkeys) and key 2 (bootstrap witnesses) are encoded from decoded
 * objects. For all other keys, raw bytes from the original unsigned tx witness
 * set are reused byte-for-byte to avoid script-integrity hash mismatch.
 */
function buildMergedWitnessBytes(params: {
  existingWitness: Map<number, unknown>;
  walletWitness: Map<number, unknown>;
  txBuffer: Buffer;
  walletBuffer: Buffer;
}): Buffer {
  const { existingWitness, walletWitness, txBuffer, walletBuffer } = params;

  const allKeys = new Set<number>(existingWitness.keys());
  if (walletWitness.has(0)) allKeys.add(0);
  if (walletWitness.has(2)) allKeys.add(2);
  const sortedKeys = [...allKeys].sort((a, b) => a - b);

  const encodedEntries: Buffer[] = [];
  for (const key of sortedKeys) {
    encodedEntries.push(cborEncodeUnsignedInt(key));

    if (key === 0) {
      const mergedVkeys = mergeVkeyWitnesses(
        existingWitness.get(0),
        walletWitness.get(0),
      );
      encodedEntries.push(Buffer.from(Encoder.encode(mergedVkeys) as Buffer));
      continue;
    }

    if (key === 2) {
      const existingBootstrap = existingWitness.get(2);
      const walletBootstrap = walletWitness.get(2);
      if (Array.isArray(existingBootstrap) && Array.isArray(walletBootstrap)) {
        encodedEntries.push(
          Buffer.from(
            Encoder.encode([...existingBootstrap, ...walletBootstrap]) as Buffer,
          ),
        );
        continue;
      }
      if (Array.isArray(walletBootstrap) && !existingWitness.has(2)) {
        encodedEntries.push(Buffer.from(Encoder.encode(walletBootstrap) as Buffer));
        continue;
      }
      // Fall through to raw existing bytes when no wallet bootstrap merge is needed.
    }

    const existingValue = existingWitness.get(key);
    const walletValue = walletWitness.get(key);

    // Prefer existing bytes for script-related keys so script-data bytes stay exact.
    const existingRaw =
      existingValue !== undefined
        ? cborValueBytesFromSource(existingValue, txBuffer)
        : null;
    if (existingRaw) {
      encodedEntries.push(existingRaw);
      continue;
    }

    // Fallback: use wallet value bytes if key was absent in existing witness set.
    const walletRaw =
      walletValue !== undefined
        ? cborValueBytesFromSource(walletValue, walletBuffer)
        : null;
    if (walletRaw) {
      encodedEntries.push(walletRaw);
      continue;
    }

    // Last resort: encode available object (should be rare).
    const fallbackValue = walletValue ?? existingValue;
    if (fallbackValue === undefined) {
      throw new Error(`Missing witness value for key ${key}`);
    }
    encodedEntries.push(Buffer.from(Encoder.encode(fallbackValue) as Buffer));
  }

  return Buffer.concat([cborEncodeMapHeader(sortedKeys.length), ...encodedEntries]);
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const body = await parseJsonBody(context.request);
    if (body instanceof Response) return body;

    const { unsignedTx, witnessSet } = body;

    if (!unsignedTx || !witnessSet) {
      return jsonError("unsignedTx and witnessSet are required");
    }
    if (typeof unsignedTx !== "string" || typeof witnessSet !== "string") {
      return jsonError("unsignedTx and witnessSet must be strings");
    }
    if (unsignedTx.length > MAX_TX_HEX_LENGTH || witnessSet.length > MAX_TX_HEX_LENGTH) {
      return jsonError("Payload too large");
    }
    if (!isValidNonEmptyHex(unsignedTx) || !isValidNonEmptyHex(witnessSet)) {
      return jsonError("unsignedTx and witnessSet must be valid hex strings");
    }

    // Decode the unsigned transaction (4-element CBOR array: [body, witnesses, is_valid, aux_data])
    const txBuffer = Buffer.from(unsignedTx, "hex");
    let txArray: unknown[];
    try {
      const { value } = Decoder.decode(txBuffer);
      if (!Array.isArray(value) || value.length !== 4) {
        return jsonError("Invalid transaction format: expected 4-element CBOR array");
      }
      txArray = value;
    } catch {
      return jsonError("Failed to parse unsigned transaction CBOR");
    }

    // Extract byte spans so we can preserve original body/tail bytes exactly
    const bodySpan = getCborByteSpan(txArray[0]);
    const witnessSpan = getCborByteSpan(txArray[1]);
    if (!bodySpan || !witnessSpan) {
      return jsonError("Failed to extract byte positions from transaction CBOR");
    }

    // Decode the wallet's witness set
    const witnessBuffer = Buffer.from(witnessSet, "hex");
    let walletWitness: unknown;
    try {
      const { value } = Decoder.decode(witnessBuffer);
      // CIP-30 signTx(partialSign=true) returns a witness set (Map).
      // Some wallets return the full signed transaction instead; extract element [1].
      if (Array.isArray(value) && value.length === 4) {
        walletWitness = value[1];
      } else {
        walletWitness = value;
      }
    } catch {
      return jsonError("Failed to parse witness set CBOR");
    }

    if (!(walletWitness instanceof Map)) {
      return jsonError("Invalid witness set format: expected CBOR map");
    }

    const existingWitnessRaw = txArray[1] instanceof Map ? txArray[1] : new Map();
    const existingWitness = normalizeWitnessMapKeys(existingWitnessRaw as Map<unknown, unknown>);
    const walletWitnessNormalized = normalizeWitnessMapKeys(walletWitness as Map<unknown, unknown>);

    // Build merged witness bytes while preserving script witness bytes exactly.
    const mergedWitnessBytes = buildMergedWitnessBytes({
      existingWitness,
      walletWitness: walletWitnessNormalized,
      txBuffer,
      walletBuffer: witnessBuffer,
    });

    // Reassemble the transaction from raw byte segments:
    //   [array header] [body — preserved] [witness — re-encoded] [is_valid + aux_data — preserved]
    const rawPrefix = txBuffer.subarray(0, bodySpan[0]);
    const rawBody = txBuffer.subarray(bodySpan[0], bodySpan[1]);
    const rawTail = txBuffer.subarray(witnessSpan[1]);
    const signedTxBytes = Buffer.concat([
      rawPrefix,
      rawBody,
      mergedWitnessBytes as Buffer,
      rawTail,
    ]);
    const signedTxHex = signedTxBytes.toString("hex");

    // Submit to chain
    const provider = createProvider(context.env);
    console.log("[submit-partial] submit start", {
      provider: context.env.MESH_PROVIDER ?? "blockfrost",
      unsignedTxHexLen: unsignedTx.length,
      witnessSetHexLen: witnessSet.length,
      signedTxHexLen: signedTxHex.length,
      unsignedWitnessKeys: [...existingWitness.keys()],
      walletWitnessKeys: [...walletWitnessNormalized.keys()],
      mergedWitnessKeys: [...new Set([...existingWitness.keys(), ...walletWitnessNormalized.keys()])].sort((a, b) => a - b),
    });
    try {
      const txId = await provider.postTransactionToChain(signedTxHex);
      console.log("[submit-partial] submit success", { txId });
      return jsonOk({ txId, signedTx: signedTxHex });
    } catch (submitError: unknown) {
      const detail = extractSubmitErrorDetail(submitError);
      console.log("[submit-partial] submit error detail", sanitizeForLog(detail));
      console.error("Transaction submission failed:", sanitizeForLog(detail));
      return jsonError("Transaction submission failed", 500, detail);
    }
  } catch (error: unknown) {
    const message = extractSubmitErrorDetail(error);
    console.log("[submit-partial] handler error", sanitizeForLog(message));
    console.error("Error in submit-partial:", sanitizeForLog(message));
    return jsonError("Failed to submit partial transaction", 500, message);
  }
};
