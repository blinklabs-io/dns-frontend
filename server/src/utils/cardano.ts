/**
 * Shared Cardano utilities for address and asset handling.
 */

import { C } from "lucid-cardano";
import { Buffer } from "buffer";

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

/**
 * Normalize an asset ID by removing the dot separator.
 * Handles both "policyId.assetNameHex" and "policyIdassetNameHex" formats.
 * @throws Error if asset ID contains more than one dot
 */
export function normalizeAssetId(assetId: string): string {
  if (!assetId.includes(".")) return assetId;
  const dotCount = assetId.split(".").length - 1;
  if (dotCount > 1) {
    throw new Error(`Invalid asset ID: expected at most one dot separator, got ${dotCount}`);
  }
  return assetId.replace(".", "");
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
    try {
      const addr = C.Address.from_bytes(Buffer.from(trimmed, "hex"));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (addr as any).to_bech32();
    } catch (err) {
      console.warn(`Failed to convert hex address to bech32 (returning hex as-is): ${err}`);
      return trimmed;
    }
  }

  return trimmed;
}

/**
 * Validate that an address is valid bech32 format.
 */
export function isValidBech32Address(address: string): boolean {
  try {
    C.Address.from_bech32(address);
    return true;
  } catch {
    return false;
  }
}
