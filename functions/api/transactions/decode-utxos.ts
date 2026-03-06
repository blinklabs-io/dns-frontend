/**
 * Decode CBOR-encoded UTxOs without WASM dependencies.
 *
 * This is the Pages Functions port of the Express `decodeUtxos` handler.
 * The original used CML (cardano-multiplatform-lib-nodejs) which relies on
 * WASM and cannot run in Cloudflare Workers.  We replace it with the pure-JS
 * `@stricahq/cbors` library that decodes the raw CBOR directly.
 */

import { Decoder } from "@stricahq/cbors";
import { bech32 } from "bech32";
import type { Env } from "../../lib/types";
import { jsonError, jsonOk, parseJsonBody, sanitizeForLog } from "../../lib/json";
import { isValidNonEmptyHex, bytesToHex } from "../../lib/cardano";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a hex string to a Buffer for the CBOR decoder. */
function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex, "hex");
}

/** Ensure a value is a Uint8Array regardless of whether cbors returned Buffer. */
function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  // Buffer extends Uint8Array, but be defensive
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  throw new Error("Expected bytes (Uint8Array or Buffer)");
}

/**
 * Decode raw address bytes into a bech32 Cardano address.
 *
 * Shelley address header (CIP-19):
 *   - Upper nibble: address type (0-15)
 *   - Lower nibble: network id (0 = testnet, 1 = mainnet)
 *
 * Stake / reward addresses (type >= 0x0e) use the "stake" / "stake_test" prefix.
 * All other Shelley types use "addr" / "addr_test".
 * Byron-era or otherwise unrecognisable addresses fall back to hex.
 */
function decodeAddress(addressBytes: Uint8Array): string {
  try {
    const header = addressBytes[0];
    const addrType = (header >> 4) & 0x0f;
    const networkId = header & 0x0f;

    // Byron/bootstrap addresses (upper nibble 0x8) cannot be bech32-encoded.
    // bech32.encode() would succeed on arbitrary bytes but produce a
    // semantically invalid address, so we must check explicitly.
    if (addrType === 0x08) {
      return bytesToHex(addressBytes);
    }

    let prefix: string;
    if (addrType >= 0x0e) {
      prefix = networkId === 1 ? "stake" : "stake_test";
    } else {
      prefix = networkId === 1 ? "addr" : "addr_test";
    }

    const words = bech32.toWords(addressBytes);
    return bech32.encode(prefix, words, 1023);
  } catch {
    return bytesToHex(addressBytes);
  }
}

/**
 * Parse a CBOR multiasset map into a flat `{ "policyHex.assetHex": "quantity" }` record.
 *
 * The multiasset structure from CBOR is:
 *   Map<Buffer(policyId), Map<Buffer(assetName), uint | bigint>>
 */
function parseMultiAssets(
  multiasset: Map<Buffer, Map<Buffer, bigint | number>>,
): Record<string, string> {
  const assets: Record<string, string> = {};
  for (const [policyId, assetMap] of multiasset.entries()) {
    const policyHex = bytesToHex(toUint8Array(policyId));
    for (const [assetName, quantity] of assetMap.entries()) {
      const assetHex = bytesToHex(toUint8Array(assetName));
      assets[`${policyHex}.${assetHex}`] = quantity.toString();
    }
  }
  return assets;
}

/**
 * Extract coins and optional multiasset from a CBOR-decoded value field.
 *
 * The value is either:
 *   - A uint / bigint (lovelace only)
 *   - A 2-element array [lovelace, multiasset map]
 */
function parseValue(value: unknown): {
  coins: bigint | number;
  multiasset?: Map<Buffer, Map<Buffer, bigint | number>>;
} {
  if (typeof value === "bigint" || typeof value === "number") {
    return { coins: value };
  }
  if (Array.isArray(value)) {
    if (value.length !== 2) {
      throw new Error("Invalid value tuple length in UTxO CBOR");
    }
    const [coins, multiasset] = value;
    if (typeof coins !== "bigint" && typeof coins !== "number") {
      throw new Error("Invalid coins type in UTxO CBOR");
    }
    if (!(multiasset instanceof Map)) {
      throw new Error("Invalid multiasset type in UTxO CBOR");
    }
    return { coins, multiasset };
  }
  throw new Error("Unsupported value type in UTxO CBOR");
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const body = await parseJsonBody(context.request);
    if (body instanceof Response) return body;
    const { utxos } = body;

    // -- Input validation --------------------------------------------------

    if (!Array.isArray(utxos)) {
      return jsonError("utxos must be an array of hex strings");
    }
    if (utxos.length > 100) {
      return jsonError("utxos array too large (max 100)");
    }
    for (const elem of utxos) {
      if (typeof elem !== "string") {
        return jsonError("utxos must contain only valid hex strings");
      }
      if (elem.length > 65536) {
        return jsonError("Individual UTxO hex string too large");
      }
      if (!isValidNonEmptyHex(elem)) {
        return jsonError("utxos must contain only valid hex strings");
      }
    }

    // -- Decode each UTxO --------------------------------------------------

    const decodedUtxos = utxos.map((hexString: string) => {
      const cborBytes = hexToBuffer(hexString);
      const { value: decoded } = Decoder.decode(cborBytes);

      // A Cardano TransactionUnspentOutput is a 2-element CBOR array: [input, output]
      if (!Array.isArray(decoded) || decoded.length !== 2) {
        throw new Error("Invalid UTXO structure: expected [input, output]");
      }
      const [input, output] = decoded as [unknown, unknown];

      if (!Array.isArray(input) || input.length !== 2) {
        throw new Error("Invalid UTXO input format");
      }

      // input = [txHash (32 bytes), outputIndex (uint)]
      const txHashBytes = toUint8Array(input[0]);
      if (txHashBytes.length !== 32) {
        throw new Error("Invalid txHash length: expected 32 bytes");
      }
      const txHash = bytesToHex(txHashBytes);
      const outputIndex = Number(input[1]);
      if (!Number.isFinite(outputIndex) || outputIndex < 0 || !Number.isInteger(outputIndex)) {
        throw new Error("Invalid UTXO output index");
      }

      // output can be:
      //   - Post-Babbage Map: { 0: address, 1: value, 2?: datum, 3?: scriptRef }
      //   - Legacy array:     [address, value]
      let addressBytes: Uint8Array;
      let coins: bigint | number;
      let multiasset: Map<Buffer, Map<Buffer, bigint | number>> | undefined;

      if (output instanceof Map) {
        // Post-Babbage map format
        addressBytes = toUint8Array(output.get(0));
        const parsed = parseValue(output.get(1));
        coins = parsed.coins;
        multiasset = parsed.multiasset;
      } else if (Array.isArray(output)) {
        // Legacy array format
        addressBytes = toUint8Array(output[0]);
        const parsed = parseValue(output[1]);
        coins = parsed.coins;
        multiasset = parsed.multiasset;
      } else {
        throw new Error("Unexpected UTXO output format");
      }

      return {
        txHash,
        outputIndex,
        amount: {
          coins: coins.toString(),
          assets: multiasset ? parseMultiAssets(multiasset) : undefined,
        },
        address: decodeAddress(addressBytes),
      };
    });

    return jsonOk(decodedUtxos);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error decoding UTXOs:", sanitizeForLog(message));
    const isClientError =
      error instanceof SyntaxError ||
      /decode|invalid|parse|expected|unexpected|CBOR/i.test(message);
    return jsonError(
      "Failed to decode UTXOs",
      isClientError ? 400 : 500,
      sanitizeForLog(message),
    );
  }
};
