/**
 * Shared Cardano utilities for address and asset handling.
 *
 * This is the Pages Functions port of server/src/utils/cardano.ts.
 * The WASM-based `lucid-cardano` dependency has been replaced with the
 * pure-JS `bech32` package so the code runs in Cloudflare Workers.
 */

import { bech32 } from "bech32";

// ---------------------------------------------------------------------------
// Hex helpers
// ---------------------------------------------------------------------------

/** Convert a hex string to a Uint8Array. Throws on odd-length or invalid hex input. */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("hexToBytes: odd-length hex string");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const pair = hex.substring(i, i + 2);
    if (!/^[0-9a-fA-F]{2}$/.test(pair)) {
      throw new Error(`hexToBytes: invalid hex byte "${pair}" at offset ${i}`);
    }
    const value = Number("0x" + pair);
    bytes[i / 2] = value;
  }
  return bytes;
}

/** Convert a Uint8Array to a lowercase hex string. */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cardano policy IDs are 56 hex characters (28 bytes) */
export const POLICY_ID_LENGTH = 56;

/** Minimum lovelace values from reference implementation */
export const MIN_LOVELACE = {
  /** Minimum for TLD reference token UTxO */
  TLD_REF: 2_000_000n,
  /** Minimum for owner UTxO with TLD user token */
  OWNER: 1_262_830n,
  /** Minimum for SLD reference token UTxO (includes inline datum with domain name; 2 ADA covers all name lengths) */
  SLD_REF: 2_000_000n,
  /** Minimum for SLD user token UTxO */
  SLD_USER: 1_262_830n,
} as const;

// ---------------------------------------------------------------------------
// Asset ID helpers
// ---------------------------------------------------------------------------

/**
 * Normalize an asset ID by removing the dot separator.
 * Handles both "policyId.assetNameHex" and "policyIdassetNameHex" formats.
 * @throws Error if asset ID contains more than one dot
 */
export function normalizeAssetId(assetId: string): string {
  if (!assetId.includes(".")) return assetId.toLowerCase();
  const dotCount = assetId.split(".").length - 1;
  if (dotCount > 1) {
    throw new Error(`Invalid asset ID: expected at most one dot separator, got ${dotCount}`);
  }
  return assetId.replace(".", "").toLowerCase();
}

/**
 * Validate that a string is a valid hex-encoded Cardano policy ID.
 */
export function isValidPolicyId(policyId: string): boolean {
  return /^[0-9a-fA-F]{56}$/.test(policyId);
}

/**
 * Validate that a string is a valid hex string (even length, hex chars only).
 * Note: empty strings are considered valid (e.g., ADA has no asset name).
 * Use `isValidNonEmptyHex` when empty strings should be rejected.
 */
export function isValidHex(hex: string): boolean {
  return hex.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(hex);
}

/**
 * Validate that a string is a non-empty valid hex string.
 */
export function isValidNonEmptyHex(hex: string): boolean {
  return hex.length > 0 && isValidHex(hex);
}

/**
 * Split an asset ID into policy ID and asset name hex.
 * Accepts both "policyId.assetNameHex" and concatenated "policyIdassetNameHex" formats.
 * @throws Error if the asset ID format is invalid
 */
export function splitAssetId(assetId: string): { policyId: string; assetNameHex: string } {
  if (assetId.includes(".")) {
    const parts = assetId.split(".");
    if (parts.length !== 2) {
      throw new Error(`Invalid asset ID: expected exactly one dot separator, got ${parts.length - 1}`);
    }
    const [policyId, assetNameHex] = parts;
    if (!isValidPolicyId(policyId)) {
      throw new Error(`Invalid policy ID in asset ID: expected 56 hex chars, got "${policyId}"`);
    }
    if (!isValidHex(assetNameHex)) {
      throw new Error(`Invalid asset name hex in asset ID: "${assetNameHex}"`);
    }
    return { policyId, assetNameHex };
  }

  if (assetId.length < POLICY_ID_LENGTH) {
    throw new Error(`Invalid asset ID: expected at least ${POLICY_ID_LENGTH} characters, got ${assetId.length}`);
  }

  const policyId = assetId.slice(0, POLICY_ID_LENGTH);
  const assetNameHex = assetId.slice(POLICY_ID_LENGTH);

  if (!isValidPolicyId(policyId)) {
    throw new Error(`Invalid policy ID in asset ID: expected 56 hex chars`);
  }
  if (!isValidHex(assetNameHex)) {
    throw new Error(`Invalid asset name hex in asset ID: "${assetNameHex}"`);
  }

  return { policyId, assetNameHex };
}

// ---------------------------------------------------------------------------
// Transaction validation
// ---------------------------------------------------------------------------

/**
 * Validate a transaction hash (64 hex characters).
 */
export function isValidTxHash(hash: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(hash);
}

/**
 * Validate a transaction output index (non-negative integer).
 */
export function isValidTxIndex(idx: unknown): idx is number {
  return Number.isInteger(idx) && (idx as number) >= 0;
}

// ---------------------------------------------------------------------------
// Address helpers  (bech32-based, replaces lucid-cardano WASM)
// ---------------------------------------------------------------------------

/** Maximum bech32 encoding length for Cardano addresses. */
const BECH32_LIMIT = 1023;

/**
 * Determine the bech32 human-readable prefix from the address header byte.
 *
 * Shelley address header layout (CIP-19):
 *   - Upper nibble: address type (0-15)
 *   - Lower nibble: network id (0 = testnet, 1 = mainnet)
 *
 * For stake addresses (type 14/15 = 0xe/0xf) the prefix is "stake" / "stake_test".
 */
function bech32Prefix(headerByte: number): string {
  const networkId = headerByte & 0x0f;
  const addressType = (headerByte >> 4) & 0x0f;

  if (addressType >= 0x0e) {
    // Stake / reward address
    return networkId === 0x01 ? "stake" : "stake_test";
  }
  return networkId === 0x01 ? "addr" : "addr_test";
}

/**
 * Convert an address to bech32 format.
 * Accepts bech32 addresses (returned as-is) or hex-encoded address bytes.
 */
export function toBech32Address(address: string): string {
  const trimmed = address.trim();
  if (!trimmed) return trimmed;

  // Already bech32
  if (trimmed.startsWith("addr") || trimmed.startsWith("stake")) {
    return trimmed;
  }

  // Try to decode from hex
  if (/^[0-9a-fA-F]+$/.test(trimmed)) {
    if (trimmed.length % 2 !== 0) return trimmed;
    try {
      const bytes = hexToBytes(trimmed);
      if (bytes.length === 0) return trimmed;
      const prefix = bech32Prefix(bytes[0]);
      const words = bech32.toWords(bytes);
      return bech32.encode(prefix, words, BECH32_LIMIT);
    } catch (err) {
      console.warn(`Failed to convert hex address to bech32 (returning hex as-is): ${err}`);
      return trimmed;
    }
  }

  return trimmed;
}

/** Allowed Cardano bech32 human-readable prefixes. */
const VALID_BECH32_PREFIXES = new Set(["addr", "addr_test", "stake", "stake_test"]);

/** Spendable (payment/script) Cardano bech32 prefixes — excludes stake addresses. */
const SPENDABLE_BECH32_PREFIXES = new Set(["addr", "addr_test"]);

/**
 * Validate that an address is valid bech32 format with a known Cardano prefix.
 */
export function isValidBech32Address(address: string): boolean {
  try {
    const decoded = bech32.decode(address, BECH32_LIMIT);
    return VALID_BECH32_PREFIXES.has(decoded.prefix);
  } catch {
    return false;
  }
}

/**
 * Validate that an address is a spendable bech32 payment address (not a stake address).
 */
export function isSpendableBech32Address(address: string): boolean {
  try {
    const decoded = bech32.decode(address, BECH32_LIMIT);
    return SPENDABLE_BECH32_PREFIXES.has(decoded.prefix);
  } catch {
    return false;
  }
}
