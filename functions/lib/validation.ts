/**
 * Shared validation helpers for SLD mint request endpoints.
 *
 * Ported from server/src/controllers/transactionController.ts
 * (validateSldMintRequest, resolveTldOwner, isValidMinLovelace,
 * parseAdaToLovelace).
 */

import {
  toBech32Address,
  isSpendableBech32Address,
  isValidTxHash,
  isValidTxIndex,
  isValidNonEmptyHex,
} from "./cardano";
import { createUserTokenTN } from "./sldBuilder";
import { createProvider, type MeshProviderAdapter } from "./providerFactory";
import { jsonError, parseJsonBody } from "./json";
import type { Env } from "./types";

// ---------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------

/** Validate optional minLovelace params: must be undefined or a positive safe integer. */
export function isValidMinLovelace(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Convert an ADA string/number to lovelace (bigint). */
export function parseAdaToLovelace(ada: string | number): bigint {
  const str = String(ada).trim();
  if (str.startsWith("-")) throw new Error("ADA amount cannot be negative");
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(str))
    throw new Error(
      "Invalid ADA amount format (no leading zeros, max 6 decimal places)",
    );
  const [whole, frac = ""] = str.split(".");
  const paddedFrac = frac.padEnd(6, "0");
  const lovelace = BigInt(whole + paddedFrac);
  if (lovelace === 0n)
    throw new Error("ADA amount must be greater than zero");
  return lovelace;
}

// ---------------------------------------------------------------------------
// SLD Mint request validation
// ---------------------------------------------------------------------------

export type ValidatedSldMintRequest = {
  userAddress: string;
  ownerAddress?: string;
  tldRefAddress: string;
  sldRefAddress: string;
  tldName: string;
  sldName: string;
  csTld: string;
  csSld: string;
  currentSldHexList?: string[];
  tldReferenceRef: { txHash: string; txIndex: number };
  sldReferenceRef: { txHash: string; txIndex: number };
  minLovelaceTldRef?: bigint;
  minLovelaceOwner?: bigint;
  minLovelaceSldRef?: bigint;
  minLovelaceSldUser?: bigint;
};

/**
 * Shared validation and normalization for planSldMintFull / buildSldMint.
 * Returns either an object with a single `error` string key, or a fully
 * validated + normalized request payload.
 */
export function validateSldMintRequest(
  body: Record<string, unknown>,
): { error: string } | ValidatedSldMintRequest {
  const {
    userAddress,
    ownerAddress,
    tldRefAddress,
    sldRefAddress,
    tldName,
    sldName,
    csTld,
    csSld,
    currentSldHexList,
    tldReferenceRef,
    sldReferenceRef,
    minLovelaceTldRef,
    minLovelaceOwner,
    minLovelaceSldRef,
    minLovelaceSldUser,
  } = body;

  if (
    !userAddress ||
    !tldRefAddress ||
    !sldRefAddress ||
    !tldName ||
    !sldName ||
    !csTld ||
    !csSld ||
    !tldReferenceRef ||
    !sldReferenceRef
  ) {
    return {
      error:
        "userAddress, tldRefAddress, sldRefAddress, tldName, sldName, csTld, csSld, tldReferenceRef, sldReferenceRef are required",
    };
  }
  if (
    typeof tldName !== "string" ||
    typeof sldName !== "string" ||
    typeof csTld !== "string" ||
    typeof csSld !== "string"
  ) {
    return { error: "tldName, sldName, csTld, csSld must be strings" };
  }
  if (tldName.length > 64 || sldName.length > 64) {
    return { error: "tldName and sldName must not exceed 64 characters" };
  }
  if (
    !/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(tldName) ||
    !/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(sldName)
  ) {
    return {
      error:
        "tldName and sldName must contain only alphanumeric characters and hyphens, and must not start or end with a hyphen",
    };
  }
  if (!/^[0-9a-fA-F]{56}$/.test(csTld) || !/^[0-9a-fA-F]{56}$/.test(csSld)) {
    return {
      error: "csTld and csSld must be valid 56-character hex policy IDs",
    };
  }
  const canonicalCsTld = csTld.toLowerCase();
  const canonicalCsSld = csSld.toLowerCase();

  const normalizedUserAddress = toBech32Address(String(userAddress));
  const normalizedOwnerAddress = ownerAddress
    ? toBech32Address(String(ownerAddress))
    : undefined;
  const normalizedTldRefAddress = toBech32Address(String(tldRefAddress));
  const normalizedSldRefAddress = toBech32Address(String(sldRefAddress));

  if (
    !isSpendableBech32Address(normalizedUserAddress) ||
    (normalizedOwnerAddress &&
      !isSpendableBech32Address(normalizedOwnerAddress)) ||
    !isSpendableBech32Address(normalizedTldRefAddress) ||
    !isSpendableBech32Address(normalizedSldRefAddress)
  ) {
    return {
      error: "addresses must be valid spendable bech32 payment addresses",
    };
  }

  const tldRef = tldReferenceRef as Record<string, unknown>;
  const sldRef = sldReferenceRef as Record<string, unknown>;
  if (
    typeof tldRef?.txHash !== "string" ||
    typeof sldRef?.txHash !== "string" ||
    typeof tldRef?.txIndex !== "number" ||
    typeof sldRef?.txIndex !== "number"
  ) {
    return {
      error:
        "tldReferenceRef/sldReferenceRef must include string txHash and number txIndex",
    };
  }
  if (
    !isValidTxHash(tldRef.txHash) ||
    !isValidTxHash(sldRef.txHash) ||
    !isValidTxIndex(tldRef.txIndex) ||
    !isValidTxIndex(sldRef.txIndex)
  ) {
    return {
      error:
        "tldReferenceRef/sldReferenceRef must include 64-char hex txHash and non-negative integer txIndex",
    };
  }

  if (currentSldHexList !== undefined) {
    if (!Array.isArray(currentSldHexList)) {
      return { error: "currentSldHexList must be an array when provided" };
    }
    if (currentSldHexList.length > 1000) {
      return { error: "currentSldHexList too large (max 1000 entries)" };
    }
    for (const sldHex of currentSldHexList) {
      if (typeof sldHex !== "string" || !isValidNonEmptyHex(sldHex)) {
        return {
          error:
            "currentSldHexList must contain only non-empty valid hex strings",
        };
      }
      if (sldHex.length > 128) {
        return {
          error: "Individual SLD hex entry too large (max 64 bytes)",
        };
      }
    }
  }

  if (
    !isValidMinLovelace(minLovelaceTldRef) ||
    !isValidMinLovelace(minLovelaceOwner) ||
    !isValidMinLovelace(minLovelaceSldRef) ||
    !isValidMinLovelace(minLovelaceSldUser)
  ) {
    return {
      error:
        "minLovelace values must be positive integers (lovelace) when provided",
    };
  }

  return {
    userAddress: normalizedUserAddress,
    ownerAddress: normalizedOwnerAddress,
    tldRefAddress: normalizedTldRefAddress,
    sldRefAddress: normalizedSldRefAddress,
    tldName,
    sldName,
    csTld: canonicalCsTld,
    csSld: canonicalCsSld,
    currentSldHexList: currentSldHexList as string[] | undefined,
    tldReferenceRef: {
      txHash: tldRef.txHash,
      txIndex: tldRef.txIndex as number,
    },
    sldReferenceRef: {
      txHash: sldRef.txHash,
      txIndex: sldRef.txIndex as number,
    },
    minLovelaceTldRef:
      minLovelaceTldRef != null
        ? BigInt(minLovelaceTldRef as number)
        : undefined,
    minLovelaceOwner:
      minLovelaceOwner != null
        ? BigInt(minLovelaceOwner as number)
        : undefined,
    minLovelaceSldRef:
      minLovelaceSldRef != null
        ? BigInt(minLovelaceSldRef as number)
        : undefined,
    minLovelaceSldUser:
      minLovelaceSldUser != null
        ? BigInt(minLovelaceSldUser as number)
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// TLD owner resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the TLD owner address on-chain by looking up the unique NFT holder.
 * Returns the owner address, or an error object with HTTP status and body.
 */
export async function resolveTldOwner(
  provider: MeshProviderAdapter,
  csTld: string,
  tldName: string,
): Promise<
  | { address: string; userTokenHex: string }
  | { status: number; body: Record<string, unknown> }
> {
  const userTokenHex = createUserTokenTN(tldName);
  const asset = `${csTld}${userTokenHex}`;
  const addresses = await provider.fetchAssetAddresses(asset);
  if (!addresses || addresses.length === 0) {
    return {
      status: 404,
      body: {
        error:
          "TLD user token not found on-chain — cannot determine owner address",
      },
    };
  }
  const singleHolders = addresses.filter(
    (a: { quantity: string }) => a.quantity === "1",
  );
  if (singleHolders.length !== 1) {
    return {
      status: 409,
      body: {
        error: "Expected exactly one holder of TLD user token (NFT)",
        holderCount: addresses.length,
      },
    };
  }
  return { address: singleHolders[0].address, userTokenHex };
}

// ---------------------------------------------------------------------------
// SLD mint preflight (shared between build and plan/full handlers)
// ---------------------------------------------------------------------------

export type SldMintPreflightResult = {
  validated: ValidatedSldMintRequest;
  provider: MeshProviderAdapter;
  ownerAddress: string;
};

/**
 * Shared preflight for SLD mint endpoints: parse JSON body, validate the
 * request, create the provider, and resolve the TLD owner address.
 *
 * Returns either a ready-to-use `SldMintPreflightResult` or a `Response`
 * that the handler should return immediately (validation / resolution error).
 */
export async function prepareSldMintPreflight(
  request: Request,
  env: Env,
): Promise<SldMintPreflightResult | Response> {
  const body = await parseJsonBody(request);
  if (body instanceof Response) return body;

  const validated = validateSldMintRequest(body);
  if ("error" in validated) {
    return jsonError(validated.error);
  }

  const provider = createProvider(env);

  let { ownerAddress } = validated;
  if (!ownerAddress) {
    const result = await resolveTldOwner(
      provider,
      validated.csTld,
      validated.tldName,
    );
    if ("status" in result) {
      return Response.json(result.body, { status: result.status });
    }
    ownerAddress = result.address;
  }

  return { validated, provider, ownerAddress };
}
