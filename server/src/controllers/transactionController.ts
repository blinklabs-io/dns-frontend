/* global console */
/* eslint-disable @typescript-eslint/no-explicit-any -- CML WASM bindings and Mesh SDK interop lack TS types */
import type { Request, Response } from "express";
import { LargestFirstInputSelector, MeshTxBuilder } from "@meshsdk/core";
import * as CML from "@dcspark/cardano-multiplatform-lib-nodejs";
import { Buffer } from "buffer";
import { prepareSldMintArtifacts, createReferenceTokenTN, createUserTokenTN } from "../services/sldBuilder.js";
import { buildSldMintPlan } from "../services/sldMintPlanner.js";
import { buildSldMintTx } from "../services/sldMintBuilder.js";
import { createProvider } from "../services/providerFactory.js";
import {
  normalizeAssetId,
  isValidTxHash,
  isValidTxIndex,
  toBech32Address,
  isValidBech32Address,
  isValidNonEmptyHex,
} from "../utils/cardano.js";

type Amount = { unit: string; quantity: string };

/** Sanitize user-provided strings for safe logging (strips newlines and control characters). */
function sanitizeForLog(value: unknown): string {
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/[\r\n]+/g, " ").replace(/[\x00-\x1f\x7f]/g, "");
}

/** Validate optional minLovelace params: must be undefined or a positive safe integer. */
function isValidMinLovelace(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Recursively converts BigInt values to strings for JSON serialization.
 */
function serializeBigInts<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "bigint") return obj.toString() as unknown as T;
  if (Array.isArray(obj)) return obj.map(serializeBigInts) as unknown as T;
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = serializeBigInts(value);
    }
    return result as T;
  }
  return obj;
}

function toAmount(unit: string, quantity: bigint | number) {
  return { unit, quantity: BigInt(quantity).toString() };
}

function parseAdaToLovelace(ada: string | number): bigint {
  const str = String(ada).trim();
  if (str.startsWith("-")) throw new Error("ADA amount cannot be negative");
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(str)) throw new Error("Invalid ADA amount format (no leading zeros, max 6 decimal places)");
  const [whole, frac = ""] = str.split(".");
  const paddedFrac = frac.padEnd(6, "0");
  const lovelace = BigInt(whole + paddedFrac);
  if (lovelace === 0n) throw new Error("ADA amount must be greater than zero");
  return lovelace;
}

export async function createTransaction(req: Request, res: Response) {
  try {
    const { recipientAddress, amount, address, assetId } = req.body || {};

    if (!recipientAddress || !amount || !address || !assetId) {
      return res.status(400).json({ error: "recipientAddress, amount, address, and assetId are required" });
    }

    const normalizedRecipient = toBech32Address(String(recipientAddress));
    const normalizedSender = toBech32Address(String(address));
    if (!isValidBech32Address(normalizedRecipient) || !isValidBech32Address(normalizedSender)) {
      return res.status(400).json({ error: "recipientAddress/address must be valid bech32 or hex-encoded address bytes" });
    }

    const provider: any = createProvider();
    const utxos = await provider.getUnspentOutputs(normalizedSender);

    const txBuilder = new MeshTxBuilder({
      fetcher: provider,
      selector: new LargestFirstInputSelector(),
      verbose: false,
    });

    let targetAssets: Amount[];
    if (assetId === "lovelace") {
      targetAssets = [toAmount("lovelace", parseAdaToLovelace(amount))];
    } else {
      const amountStr = String(amount);
      if (!/^[1-9]\d*$/.test(amountStr)) {
        return res.status(400).json({ error: "Non-lovelace asset amount must be a positive whole number" });
      }
      targetAssets = [toAmount(normalizeAssetId(assetId), BigInt(amountStr))];
    }

    txBuilder.txOut(normalizedRecipient, targetAssets).changeAddress(normalizedSender).selectUtxosFrom(utxos);
    const unsignedTx = await txBuilder.complete();

    return res.json({ unsignedTx });
  } catch (error: any) {
    console.error("Error creating transaction:", sanitizeForLog(error?.message));
    return res.status(500).json({ error: "Failed to create transaction", details: sanitizeForLog(error?.message) });
  }
}

export async function submitTransaction(req: Request, res: Response) {
  try {
    const { signedTx } = req.body || {};
    if (!signedTx || typeof signedTx !== "string") return res.status(400).json({ error: "signedTx is required and must be a string" });
    if (signedTx.length > 65536) return res.status(400).json({ error: "signedTx payload too large" });
    if (!/^[0-9a-fA-F]+$/.test(signedTx) || signedTx.length % 2 !== 0) {
      return res.status(400).json({ error: "signedTx must be a valid even-length hex string" });
    }

    const provider: any = createProvider();
    const txId = await provider.postTransactionToChain(signedTx);
    return res.json({ txId });
  } catch (error: any) {
    console.error("Error submitting transaction:", sanitizeForLog(error?.message));
    return res.status(500).json({ error: "Failed to submit transaction", details: sanitizeForLog(error?.message) });
  }
}

// --- Simplified partial transaction submission ---

/** Normalize a hex string: trim whitespace, strip optional 0x prefix, validate. */
function normalizeHex(payload: string): string {
  const trimmed = payload.trim().replace(/^0x/i, "").replace(/\s+/g, "");
  if (!trimmed) throw new Error("Payload is empty after trimming");
  if (!/^[0-9a-fA-F]+$/.test(trimmed)) throw new Error("Payload is not valid hex");
  if (trimmed.length % 2 !== 0) throw new Error("Hex string has odd length");
  return trimmed;
}

export async function submitPartialTransaction(req: Request, res: Response) {
  try {
    const { unsignedTx, witnessSet } = req.body || {};

    if (!unsignedTx || !witnessSet) {
      return res.status(400).json({ error: "unsignedTx and witnessSet are required" });
    }
    if (typeof unsignedTx !== "string" || typeof witnessSet !== "string") {
      return res.status(400).json({ error: "unsignedTx and witnessSet must be strings" });
    }
    // Limit payload size to prevent excessive memory use during CBOR deserialization
    const MAX_TX_HEX_LENGTH = 65536; // 65536 hex chars = 32KB binary, generous for a transaction
    if (unsignedTx.length > MAX_TX_HEX_LENGTH || witnessSet.length > MAX_TX_HEX_LENGTH) {
      return res.status(400).json({ error: "Payload too large" });
    }

    const txHex = normalizeHex(unsignedTx);
    const witnessHex = normalizeHex(witnessSet);

    // Parse unsigned transaction
    let tx: CML.Transaction;
    try {
      tx = CML.Transaction.from_cbor_hex(txHex);
    } catch (err: any) {
      return res.status(400).json({
        error: "Failed to parse unsigned transaction",
        details: sanitizeForLog(err?.message ?? String(err)),
      });
    }

    // Parse wallet's witness set (contains vkey signatures)
    let walletWitness: CML.TransactionWitnessSet;
    try {
      walletWitness = CML.TransactionWitnessSet.from_cbor_hex(witnessHex);
    } catch {
      // Try parsing as full transaction and extract witness set
      try {
        const witnessTx = CML.Transaction.from_cbor_hex(witnessHex);
        walletWitness = witnessTx.witness_set();
      } catch (err: any) {
        return res.status(400).json({
          error: "Failed to parse witness set",
          details: sanitizeForLog(err?.message ?? String(err)),
        });
      }
    }

    // Merge witness sets: add_all_witnesses merges vkeys, scripts, datums, redeemers
    const mergedWitness = tx.witness_set();
    mergedWitness.add_all_witnesses(walletWitness);

    // Rebuild transaction with merged witness set
    const signedTx = CML.Transaction.new(tx.body(), mergedWitness, tx.is_valid(), tx.auxiliary_data());
    const signedTxHex = signedTx.to_cbor_hex();

    // Submit to chain
    const provider: any = createProvider();
    try {
      const txId = await provider.postTransactionToChain(signedTxHex);
      return res.json({ txId, signedTx: signedTxHex });
    } catch (submitError: any) {
      // Blockfrost and other providers bury the actual error in various places
      const detail =
        submitError?.data?.message ||
        submitError?.response?.data?.message ||
        submitError?.message ||
        (typeof submitError === "string" ? submitError : JSON.stringify(submitError));
      console.error("Transaction submission failed:", sanitizeForLog(detail));
      return res.status(500).json({
        error: "Transaction submission failed",
        details: sanitizeForLog(detail),
      });
    }
  } catch (error: any) {
    console.error("Error submitting partial transaction:", sanitizeForLog(error?.message));
    return res.status(500).json({ error: "Failed to submit partial transaction", details: sanitizeForLog(error?.message) });
  }
}

// --- UTxO utilities ---

export async function decodeUtxos(req: Request, res: Response) {
  try {
    const { utxos } = req.body || {};
    if (!Array.isArray(utxos)) {
      return res.status(400).json({ error: "utxos must be an array of hex strings" });
    }
    if (utxos.length > 100) {
      return res.status(400).json({ error: "utxos array too large (max 100)" });
    }
    for (const elem of utxos) {
      if (typeof elem !== "string" || !isValidNonEmptyHex(elem)) {
        return res.status(400).json({ error: "utxos must contain only valid hex strings" });
      }
      if (elem.length > 65536) {
        return res.status(400).json({ error: "Individual UTxO hex string too large" });
      }
    }

    const decodedUtxos = utxos.map((hexString: string) => {
      const utxo = CML.TransactionUnspentOutput.from_cbor_hex(hexString);
      const output = utxo.output();
      const input = utxo.input();
      const multiasset = output.amount().has_multiassets() ? output.amount().multi_asset() : undefined;

      let address: string;
      try {
        address = output.address().to_bech32();
      } catch {
        // Byron-era addresses don't support bech32 encoding; fall back to hex
        address = output.address().to_hex();
      }

      return {
        txHash: input.transaction_id().to_hex(),
        outputIndex: Number(input.index()),
        amount: {
          coins: output.amount().coin().toString(),
          assets: multiasset ? parseMultiAssets(multiasset) : undefined,
        },
        address,
      };
    });

    return res.json(decodedUtxos);
  } catch (error: any) {
    console.error("Error decoding UTXOs:", sanitizeForLog(error?.message));
    return res.status(500).json({ error: "Failed to decode UTXOs", details: sanitizeForLog(error?.message) });
  }
}

export async function fetchAddressUtxos(req: Request, res: Response) {
  try {
    const { address } = req.body || {};
    if (!address) return res.status(400).json({ error: "address is required" });

    const normalizedAddress = toBech32Address(String(address));
    if (!isValidBech32Address(normalizedAddress)) {
      return res.status(400).json({ error: "address must be valid bech32 or hex-encoded address bytes" });
    }

    const provider: any = createProvider();
    const utxos = await provider.getUnspentOutputs(normalizedAddress);
    return res.json({ address: normalizedAddress, utxos });
  } catch (error: any) {
    console.error("Error fetching address UTxOs:", sanitizeForLog(error?.message));
    return res.status(500).json({ error: "Failed to fetch address UTxOs", details: sanitizeForLog(error?.message) });
  }
}

export async function fetchReferenceRefs(req: Request, res: Response) {
  try {
    const { tldRefAddress, sldRefAddress, tldName, sldName, csTld, csSld } = req.body || {};

    if (!tldRefAddress || !sldRefAddress || !tldName || !sldName || !csTld || !csSld) {
      return res.status(400).json({
        error: "tldRefAddress, sldRefAddress, tldName, sldName, csTld, csSld are required",
      });
    }
    if (typeof tldName !== "string" || typeof sldName !== "string" ||
        typeof csTld !== "string" || typeof csSld !== "string") {
      return res.status(400).json({ error: "tldName, sldName, csTld, csSld must be strings" });
    }
    if (tldName.length > 64 || sldName.length > 64) {
      return res.status(400).json({ error: "tldName and sldName must not exceed 64 characters" });
    }
    if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(tldName) ||
        !/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(sldName)) {
      return res.status(400).json({ error: "tldName and sldName must contain only alphanumeric characters and hyphens, and must not start or end with a hyphen" });
    }
    if (!/^[0-9a-fA-F]{56}$/.test(csTld) || !/^[0-9a-fA-F]{56}$/.test(csSld)) {
      return res.status(400).json({ error: "csTld and csSld must be valid 56-character hex policy IDs" });
    }

    const normalizedTldRefAddress = toBech32Address(String(tldRefAddress));
    const normalizedSldRefAddress = toBech32Address(String(sldRefAddress));
    if (!isValidBech32Address(normalizedTldRefAddress) || !isValidBech32Address(normalizedSldRefAddress)) {
      return res.status(400).json({
        error: "tldRefAddress/sldRefAddress must be valid bech32 or hex-encoded address bytes",
      });
    }

    const provider: any = createProvider();
    const tldRefUnit = `${csTld}.${createReferenceTokenTN(tldName)}`;
    const sldRefUnit = `${csSld}.${createReferenceTokenTN(sldName)}`;

    const [tldUtxos, sldUtxos] = await Promise.all([
      provider.getUnspentOutputs(normalizedTldRefAddress),
      provider.getUnspentOutputs(normalizedSldRefAddress),
    ]);

    const findUtxoWithAsset = (utxos: any[], assetId: string) => {
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

    if (!tldRefUtxo) return res.status(404).json({ error: "TLD reference UTxO not found at tldRefAddress" });
    if (!sldRefUtxo) return res.status(404).json({ error: "SLD reference UTxO not found at sldRefAddress" });

    return res.json({
      tldReferenceRef: { txHash: tldRefUtxo.input.txHash, txIndex: tldRefUtxo.input.outputIndex },
      sldReferenceRef: { txHash: sldRefUtxo.input.txHash, txIndex: sldRefUtxo.input.outputIndex },
    });
  } catch (error: any) {
    console.error("Error fetching reference refs:", sanitizeForLog(error?.message));
    return res.status(500).json({ error: "Failed to fetch reference refs", details: sanitizeForLog(error?.message) });
  }
}

// --- SLD Mint endpoints ---

export async function planSldMint(req: Request, res: Response) {
  try {
    const { tldName, sldName, csTld, csSld, currentSldHexList = [] } = req.body || {};

    if (!tldName || !sldName || !csTld || !csSld) {
      return res.status(400).json({ error: "tldName, sldName, csTld, csSld are required" });
    }
    if (typeof tldName !== "string" || typeof sldName !== "string" ||
        typeof csTld !== "string" || typeof csSld !== "string") {
      return res.status(400).json({ error: "tldName, sldName, csTld, csSld must be strings" });
    }
    if (!/^[0-9a-fA-F]{56}$/.test(csTld) || !/^[0-9a-fA-F]{56}$/.test(csSld)) {
      return res.status(400).json({ error: "csTld and csSld must be valid 56-character hex policy IDs" });
    }
    if (tldName.length > 64 || sldName.length > 64) {
      return res.status(400).json({ error: "tldName and sldName must not exceed 64 characters" });
    }
    if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(tldName) ||
        !/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(sldName)) {
      return res.status(400).json({ error: "tldName and sldName must contain only alphanumeric characters and hyphens, and must not start or end with a hyphen" });
    }
    if (!Array.isArray(currentSldHexList)) {
      return res.status(400).json({ error: "currentSldHexList must be an array" });
    }
    for (const sldHex of currentSldHexList) {
      if (typeof sldHex !== "string" || !isValidNonEmptyHex(sldHex)) {
        return res.status(400).json({ error: "currentSldHexList must contain only non-empty valid hex strings" });
      }
      if (sldHex.length > 128) {
        return res.status(400).json({ error: "Individual SLD hex entry too large (max 64 bytes)" });
      }
    }

    const artifacts = prepareSldMintArtifacts({ tldName, sldName, csTld, csSld, currentSldHexList });
    return res.json({ message: "Prepared SLD mint artifacts", artifacts });
  } catch (error: any) {
    console.error("Error preparing SLD mint artifacts:", sanitizeForLog(error?.message));
    return res.status(500).json({ error: "Failed to prepare SLD mint artifacts", details: sanitizeForLog(error?.message) });
  }
}

/** Shared validation and normalization for planSldMintFull / buildSldMint. */
function validateSldMintRequest(body: any): { error: string } | {
  userAddress: string; ownerAddress?: string; tldRefAddress: string; sldRefAddress: string;
  tldName: string; sldName: string; csTld: string; csSld: string;
  currentSldHexList?: string[]; tldReferenceRef: any; sldReferenceRef: any;
  minLovelaceTldRef?: bigint; minLovelaceOwner?: bigint; minLovelaceSldRef?: bigint; minLovelaceSldUser?: bigint;
} {
  const {
    userAddress, ownerAddress, tldRefAddress, sldRefAddress,
    tldName, sldName, csTld, csSld,
    currentSldHexList, tldReferenceRef, sldReferenceRef,
    minLovelaceTldRef, minLovelaceOwner, minLovelaceSldRef, minLovelaceSldUser,
  } = body || {};

  if (!userAddress || !tldRefAddress || !sldRefAddress ||
      !tldName || !sldName || !csTld || !csSld || !tldReferenceRef || !sldReferenceRef) {
    return { error: "userAddress, tldRefAddress, sldRefAddress, tldName, sldName, csTld, csSld, tldReferenceRef, sldReferenceRef are required" };
  }
  if (typeof tldName !== "string" || typeof sldName !== "string" ||
      typeof csTld !== "string" || typeof csSld !== "string") {
    return { error: "tldName, sldName, csTld, csSld must be strings" };
  }
  if (tldName.length > 64 || sldName.length > 64) {
    return { error: "tldName and sldName must not exceed 64 characters" };
  }
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(tldName) ||
      !/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(sldName)) {
    return { error: "tldName and sldName must contain only alphanumeric characters and hyphens, and must not start or end with a hyphen" };
  }
  if (!/^[0-9a-fA-F]{56}$/.test(csTld) || !/^[0-9a-fA-F]{56}$/.test(csSld)) {
    return { error: "csTld and csSld must be valid 56-character hex policy IDs" };
  }

  const normalizedUserAddress = toBech32Address(String(userAddress));
  const normalizedOwnerAddress = ownerAddress ? toBech32Address(String(ownerAddress)) : undefined;
  const normalizedTldRefAddress = toBech32Address(String(tldRefAddress));
  const normalizedSldRefAddress = toBech32Address(String(sldRefAddress));

  if (!isValidBech32Address(normalizedUserAddress) ||
      (normalizedOwnerAddress && !isValidBech32Address(normalizedOwnerAddress)) ||
      !isValidBech32Address(normalizedTldRefAddress) || !isValidBech32Address(normalizedSldRefAddress)) {
    return { error: "addresses must be valid bech32 or hex-encoded address bytes" };
  }

  if (typeof tldReferenceRef?.txHash !== "string" || typeof sldReferenceRef?.txHash !== "string" ||
      typeof tldReferenceRef?.txIndex !== "number" || typeof sldReferenceRef?.txIndex !== "number") {
    return { error: "tldReferenceRef/sldReferenceRef must include string txHash and number txIndex" };
  }
  if (!isValidTxHash(tldReferenceRef.txHash) || !isValidTxHash(sldReferenceRef.txHash) ||
      !isValidTxIndex(tldReferenceRef.txIndex) || !isValidTxIndex(sldReferenceRef.txIndex)) {
    return { error: "tldReferenceRef/sldReferenceRef must include 64-char hex txHash and non-negative integer txIndex" };
  }

  if (currentSldHexList !== undefined) {
    if (!Array.isArray(currentSldHexList)) {
      return { error: "currentSldHexList must be an array when provided" };
    }
    for (const sldHex of currentSldHexList) {
      if (typeof sldHex !== "string" || !isValidNonEmptyHex(sldHex)) {
        return { error: "currentSldHexList must contain only non-empty valid hex strings" };
      }
      if (sldHex.length > 128) {
        return { error: "Individual SLD hex entry too large (max 64 bytes)" };
      }
    }
  }

  if (!isValidMinLovelace(minLovelaceTldRef) || !isValidMinLovelace(minLovelaceOwner) ||
      !isValidMinLovelace(minLovelaceSldRef) || !isValidMinLovelace(minLovelaceSldUser)) {
    return { error: "minLovelace values must be positive integers (lovelace) when provided" };
  }

  return {
    userAddress: normalizedUserAddress, ownerAddress: normalizedOwnerAddress,
    tldRefAddress: normalizedTldRefAddress, sldRefAddress: normalizedSldRefAddress,
    tldName, sldName, csTld, csSld, currentSldHexList, tldReferenceRef, sldReferenceRef,
    minLovelaceTldRef: minLovelaceTldRef != null ? BigInt(minLovelaceTldRef) : undefined,
    minLovelaceOwner: minLovelaceOwner != null ? BigInt(minLovelaceOwner) : undefined,
    minLovelaceSldRef: minLovelaceSldRef != null ? BigInt(minLovelaceSldRef) : undefined,
    minLovelaceSldUser: minLovelaceSldUser != null ? BigInt(minLovelaceSldUser) : undefined,
  };
}

/**
 * Resolve the TLD owner address on-chain by looking up the unique NFT holder.
 * Returns the owner address, or an error object with HTTP status and body.
 */
async function resolveTldOwner(
  provider: ReturnType<typeof createProvider>,
  csTld: string,
  tldName: string,
): Promise<{ address: string } | { status: number; body: Record<string, unknown> }> {
  const userTokenHex = createUserTokenTN(tldName);
  const asset = `${csTld}${userTokenHex}`;
  const addresses = await provider.fetchAssetAddresses(asset);
  if (!addresses || addresses.length === 0) {
    return { status: 404, body: { error: "TLD user token not found on-chain — cannot determine owner address" } };
  }
  const singleHolders = addresses.filter((a) => a.quantity === "1");
  if (singleHolders.length !== 1) {
    return { status: 409, body: { error: "Expected exactly one holder of TLD user token (NFT)", holders: addresses } };
  }
  return { address: singleHolders[0].address };
}

export async function planSldMintFull(req: Request, res: Response) {
  try {
    const validated = validateSldMintRequest(req.body);
    if ("error" in validated) return res.status(400).json({ error: validated.error });

    const provider = createProvider();

    let { ownerAddress } = validated;
    if (!ownerAddress) {
      const result = await resolveTldOwner(provider, validated.csTld, validated.tldName);
      if ("status" in result) return res.status(result.status).json(result.body);
      ownerAddress = result.address;
    }

    const plan = await buildSldMintPlan({ provider, ...validated, ownerAddress });

    return res.json({ message: "Prepared SLD mint plan", plan: serializeBigInts(plan) });
  } catch (error: any) {
    console.error("Error building SLD mint plan:", sanitizeForLog(error?.message));
    return res.status(500).json({ error: "Failed to build SLD mint plan", details: sanitizeForLog(error?.message) });
  }
}

export async function buildSldMint(req: Request, res: Response) {
  try {
    const validated = validateSldMintRequest(req.body);
    if ("error" in validated) return res.status(400).json({ error: validated.error });

    const provider = createProvider();

    let { ownerAddress } = validated;
    if (!ownerAddress) {
      const result = await resolveTldOwner(provider, validated.csTld, validated.tldName);
      if ("status" in result) return res.status(result.status).json(result.body);
      ownerAddress = result.address;
    }

    const txResult = await buildSldMintTx({ provider, ...validated, ownerAddress });

    return res.json({ message: "Built unsigned SLD mint transaction", unsignedTx: txResult.unsignedTx, plan: serializeBigInts(txResult.plan) });
  } catch (error: any) {
    console.error("Error building SLD mint tx:", sanitizeForLog(error?.message));
    return res.status(500).json({ error: "Failed to build SLD mint transaction", details: sanitizeForLog(error?.message) });
  }
}

function parseMultiAssets(multiAsset: CML.MultiAsset) {
  const assets: Record<string, string> = {};
  const policies = multiAsset.keys();
  for (let i = 0; i < policies.len(); i++) {
    const policy = policies.get(i);
    const policyAssets = multiAsset.get_assets(policy);
    if (!policyAssets) continue;
    const assetNames = policyAssets.keys();
    for (let j = 0; j < assetNames.len(); j++) {
      const assetName = assetNames.get(j);
      const amount = policyAssets.get(assetName);
      if (amount === undefined) continue;
      assets[`${policy.to_hex()}.${Buffer.from(assetName.to_raw_bytes()).toString("hex")}`] = amount.toString();
    }
  }
  return assets;
}

/**
 * Look up the owner address of a TLD by finding who holds its user token on-chain.
 * GET /api/transactions/tld-owner/:csTld/:tldName
 */
export async function lookupTldOwner(req: Request, res: Response) {
  try {
    const { csTld, tldName } = req.params;
    if (!csTld || !/^[0-9a-fA-F]{56}$/.test(csTld)) {
      return res.status(400).json({ error: "csTld must be a 56-char hex policy ID" });
    }
    if (!tldName || !/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(tldName) || tldName.length > 64) {
      return res.status(400).json({ error: "tldName must be alphanumeric with hyphens, max 64 chars" });
    }

    const provider = createProvider();
    const result = await resolveTldOwner(provider, csTld, tldName);
    if ("status" in result) return res.status(result.status).json(result.body);

    const asset = `${csTld}${createUserTokenTN(tldName)}`;
    return res.json({ ownerAddress: result.address, asset });
  } catch (error: any) {
    console.error("Error looking up TLD owner:", sanitizeForLog(error?.message));
    return res.status(500).json({ error: "Failed to look up TLD owner", details: sanitizeForLog(error?.message) });
  }
}
