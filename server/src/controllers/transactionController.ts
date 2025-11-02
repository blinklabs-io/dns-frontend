/* global console */
/* eslint-disable @typescript-eslint/no-explicit-any -- Lucid WASM bindings and Mesh SDK interop lack TS types */
import type { Request, Response } from "express";
import { LargestFirstInputSelector, MeshTxBuilder } from "@meshsdk/core";
import { C } from "lucid-cardano";
import { Buffer } from "buffer";
import { prepareSldMintArtifacts, createReferenceTokenTN } from "../services/sldBuilder.js";
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

function decodeHexOrBase64(payload: string): Buffer {
  const trimmed = payload.trim().replace(/^0x/i, "").replace(/\s+/g, "");
  if (!trimmed) {
    throw new Error("Payload is empty after trimming");
  }
  if (/^[0-9a-fA-F]+$/.test(trimmed)) {
    if (trimmed.length % 2 !== 0) {
      throw new Error("Hex string has odd length — likely a truncated value");
    }
    return Buffer.from(trimmed, "hex");
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(trimmed)) {
    throw new Error("Payload is neither valid hex nor valid base64");
  }
  // Validate base64 length: padded length must be a multiple of 4
  if (trimmed.length % 4 !== 0) {
    throw new Error("Invalid base64: length must be a multiple of 4");
  }
  return Buffer.from(trimmed, "base64");
}

function mergeVkeyWitnesses(lib: any, base: any, extra: any) {
  if (!base) return extra;
  if (!extra) return base;

  const baseVkeys = typeof base.vkeys === "function" ? base.vkeys() : null;
  const extraVkeys = typeof extra.vkeys === "function" ? extra.vkeys() : null;

  if (extraVkeys && extraVkeys.len() > 0) {
    const merged = lib.Vkeywitnesses.new();
    const seen = new Set<string>();
    const addUnique = (vkeys: { len: () => number; get: (i: number) => { vkey: () => { to_bytes: () => Uint8Array }; to_bytes: () => Uint8Array } }) => {
      for (let i = 0; i < vkeys.len(); i++) {
        const vkw = vkeys.get(i);
        const key = Buffer.from(vkw.vkey().to_bytes()).toString("hex");
        if (!seen.has(key)) {
          seen.add(key);
          merged.add(vkw);
        }
      }
    };
    if (baseVkeys) addUnique(baseVkeys);
    addUnique(extraVkeys);
    base.set_vkeys(merged);
  }

  return base;
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

    const lib = C as any;
    const txBytes = decodeHexOrBase64(unsignedTx);
    const witnessBytes = decodeHexOrBase64(witnessSet);

    // Parse unsigned transaction
    let tx: any;
    try {
      tx = lib.Transaction.from_bytes(txBytes);
    } catch (err: any) {
      return res.status(400).json({
        error: "Failed to parse unsigned transaction",
        details: sanitizeForLog(err?.message),
      });
    }

    // Parse wallet's witness set (contains vkey signatures)
    let walletWitness: any;
    try {
      walletWitness = lib.TransactionWitnessSet.from_bytes(witnessBytes);
    } catch {
      // Try parsing as full transaction and extract witness set
      try {
        const witnessTx = lib.Transaction.from_bytes(witnessBytes);
        walletWitness = witnessTx.witness_set();
      } catch (err: any) {
        return res.status(400).json({
          error: "Failed to parse witness set",
          details: sanitizeForLog(err?.message),
        });
      }
    }

    // Merge witness sets: keep redeemers from original, add vkeys from wallet
    const baseWitness = tx.witness_set();
    const mergedWitness = mergeVkeyWitnesses(lib, baseWitness, walletWitness);

    // Rebuild transaction with merged witness set
    const signedTx = lib.Transaction.new(tx.body(), mergedWitness, tx.auxiliary_data());
    const signedTxHex = Buffer.from(signedTx.to_bytes()).toString("hex");

    // Submit to chain
    const provider: any = createProvider();
    try {
      const txId = await provider.postTransactionToChain(signedTxHex);
      return res.json({ txId, signedTx: signedTxHex });
    } catch (submitError: any) {
      return res.status(500).json({
        error: "Transaction submission failed",
        details: sanitizeForLog(submitError?.data?.message || submitError?.message),
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
      const utxo = C.TransactionUnspentOutput.from_bytes(Buffer.from(hexString, "hex"));
      const output = utxo.output();
      const input = utxo.input();
      const multiasset = output.amount().multiasset();

      return {
        txHash: input.transaction_id().to_hex(),
        outputIndex: Number(input.index().to_str()),
        amount: {
          coins: output.amount().coin().to_str(),
          assets: multiasset ? parseMultiAssets(multiasset) : undefined,
        },
        address: (output.address() as any).to_bech32(),
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
  userAddress: string; ownerAddress: string; tldRefAddress: string; sldRefAddress: string;
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

  if (!userAddress || !ownerAddress || !tldRefAddress || !sldRefAddress ||
      !tldName || !sldName || !csTld || !csSld || !tldReferenceRef || !sldReferenceRef) {
    return { error: "userAddress, ownerAddress, tldRefAddress, sldRefAddress, tldName, sldName, csTld, csSld, tldReferenceRef, sldReferenceRef are required" };
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
  const normalizedOwnerAddress = toBech32Address(String(ownerAddress));
  const normalizedTldRefAddress = toBech32Address(String(tldRefAddress));
  const normalizedSldRefAddress = toBech32Address(String(sldRefAddress));

  if (!isValidBech32Address(normalizedUserAddress) || !isValidBech32Address(normalizedOwnerAddress) ||
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

export async function planSldMintFull(req: Request, res: Response) {
  try {
    const validated = validateSldMintRequest(req.body);
    if ("error" in validated) return res.status(400).json({ error: validated.error });

    const provider = createProvider();
    const plan = await buildSldMintPlan({ provider: provider as any, ...validated });

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
    const result = await buildSldMintTx({ provider: provider as any, ...validated });

    return res.json({ message: "Built unsigned SLD mint transaction", unsignedTx: result.unsignedTx, plan: serializeBigInts(result.plan) });
  } catch (error: any) {
    console.error("Error building SLD mint tx:", sanitizeForLog(error?.message));
    return res.status(500).json({ error: "Failed to build SLD mint transaction", details: sanitizeForLog(error?.message) });
  }
}

function parseMultiAssets(multiAsset: any) {
  const assets: Record<string, string> = {};
  const policies = multiAsset.keys();
  for (let i = 0; i < policies.len(); i++) {
    const policy = policies.get(i);
    const policyAssets = multiAsset.get(policy);
    const assetNames = policyAssets.keys();
    for (let j = 0; j < assetNames.len(); j++) {
      const assetName = assetNames.get(j);
      const amount = policyAssets.get(assetName);
      assets[`${policy.to_hex()}.${Buffer.from(assetName.name()).toString("hex")}`] = amount.to_str();
    }
  }
  return assets;
}
