/* eslint-env node */
/* global console */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Request, Response } from "express";
import { LargestFirstInputSelector, MeshTxBuilder } from "@meshsdk/core";
import { C } from "lucid-cardano";
import { Buffer } from "buffer";
import { prepareSldMintArtifacts, createReferenceTokenTN } from "../services/sldBuilder.js";
import { buildSldMintPlan } from "../services/sldMintPlanner.js";
import { buildSldMintTx } from "../services/sldMintBuilder.js";
import { createProvider } from "../services/providerFactory.js";

type Amount = { unit: string; quantity: string };

function normalizeUnit(assetId: string) {
  return assetId.includes(".") ? assetId.replace(".", "") : assetId;
}

function isValidTxHash(hash: string) {
  return /^[0-9a-fA-F]{64}$/.test(hash);
}

function isValidTxIndex(idx: unknown) {
  return Number.isInteger(idx) && (idx as number) >= 0;
}

function toBech32Address(address: string) {
  const trimmed = address.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("addr") || trimmed.startsWith("stake")) return trimmed;
  if (/^[0-9a-fA-F]+$/.test(trimmed)) {
    try {
      return (C.Address.from_bytes(Buffer.from(trimmed, "hex")) as any).to_bech32();
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function isValidBech32Address(address: string) {
  try {
    C.Address.from_bech32(address);
    return true;
  } catch {
    return false;
  }
}

function toAmount(unit: string, quantity: bigint | number) {
  return { unit, quantity: BigInt(quantity).toString() };
}

export async function createTransaction(req: Request, res: Response) {
  try {
    const { recipientAddress, amount, address, assetId } = req.body || {};

    if (!recipientAddress || !amount || !address || !assetId) {
      return res
        .status(400)
        .json({ error: "recipientAddress, amount, address, and assetId are required" });
    }

    const normalizedRecipient = toBech32Address(String(recipientAddress));
    const normalizedSender = toBech32Address(String(address));
    if (!isValidBech32Address(normalizedRecipient) || !isValidBech32Address(normalizedSender)) {
      return res.status(400).json({
        error: "recipientAddress/address must be valid bech32 or hex-encoded address bytes",
      });
    }

    const provider: any = createProvider();
    const utxos = await provider.getUnspentOutputs(normalizedSender);

    const txBuilder = new MeshTxBuilder({
      fetcher: provider as never,
      selector: new LargestFirstInputSelector(),
      verbose: false,
    });

    const targetAssets: Amount[] =
      assetId === "lovelace"
        ? [toAmount("lovelace", BigInt(Math.trunc(Number(amount) * 1_000_000)))]
        : [toAmount(normalizeUnit(assetId), amount)];

    txBuilder
      .txOut(normalizedRecipient, targetAssets)
      .changeAddress(normalizedSender)
      .selectUtxosFrom(utxos);

    const unsignedTx = await txBuilder.complete();

    return res.json({ unsignedTx });
  } catch (error: any) {
    console.error("Error creating transaction:", error);
    return res.status(500).json({ error: "Failed to create transaction", details: error?.message });
  }
}

export async function submitTransaction(req: Request, res: Response) {
  try {
    const { signedTx } = req.body || {};

    if (!signedTx) {
      return res.status(400).json({ error: "signedTx is required" });
    }

    const provider: any = createProvider();
    const txId = await provider.postTransactionToChain(signedTx);

    return res.json({ txId });
  } catch (error: any) {
    console.error("Error submitting transaction:", error);
    return res.status(500).json({ error: "Failed to submit transaction", details: error?.message });
  }
}

export async function decodeUtxos(req: Request, res: Response) {
  try {
    const { utxos } = req.body || {};

    if (!Array.isArray(utxos)) {
      return res.status(400).json({ error: "utxos must be an array of hex strings" });
    }

    const decodedUtxos = utxos.map((hexString: string) => {
      const utxo = C.TransactionUnspentOutput.from_bytes(Buffer.from(hexString, "hex"));

      const output = utxo.output();
      const input = utxo.input();

      const decoded: any = {
        txHash: input.transaction_id().to_hex(),
        outputIndex: Number(input.index().to_str()),
        amount: {
          coins: output.amount().coin().to_str(),
          assets: output.amount().multiasset()
            ? parseMultiAssets(output.amount().multiasset())
            : undefined,
        },
        address: (output.address() as any).to_bech32(),
        assetDetails: [] as Array<{
          id: string;
          policyId: string;
          assetName: string;
          amount: string;
        }>,
      };

      if (decoded.amount.assets) {
        decoded.assetDetails = Object.entries(decoded.amount.assets).map(([assetId, assetAmount]) => {
          const [policyId, assetNameHex] = assetId.split(".");
          return {
            id: `${policyId}.${assetNameHex}`,
            policyId,
            assetName: hexToString(assetNameHex),
            amount: assetAmount as string,
          };
        });
      }

      return decoded;
    });

    return res.json(decodedUtxos);
  } catch (error: any) {
    console.error("Error decoding UTXOs:", error);
    return res.status(500).json({ error: "Failed to decode UTXOs", details: error?.message });
  }
}

export async function fetchAddressUtxos(req: Request, res: Response) {
  try {
    const { address } = req.body || {};
    if (!address) {
      return res.status(400).json({ error: "address is required" });
    }

    const normalizedAddress = toBech32Address(String(address));
    if (!isValidBech32Address(normalizedAddress)) {
      return res.status(400).json({
        error: "address must be valid bech32 or hex-encoded address bytes",
      });
    }

    const provider: any = createProvider();
    const utxos = await provider.getUnspentOutputs(normalizedAddress);

    return res.json({ address: normalizedAddress, utxos });
  } catch (error: any) {
    console.error("Error fetching address UTxOs:", error);
    return res.status(500).json({ error: "Failed to fetch address UTxOs", details: error?.message });
  }
}

export async function fetchReferenceRefs(req: Request, res: Response) {
  try {
    const {
      tldRefAddress,
      sldRefAddress,
      tldName,
      sldName,
      csTld,
      csSld,
    } = req.body || {};

    if (!tldRefAddress || !sldRefAddress || !tldName || !sldName || !csTld || !csSld) {
      return res.status(400).json({
        error: "tldRefAddress, sldRefAddress, tldName, sldName, csTld, csSld are required",
      });
    }

    const normalizedTldRefAddress = toBech32Address(String(tldRefAddress));
    const normalizedSldRefAddress = toBech32Address(String(sldRefAddress));
    if (!isValidBech32Address(normalizedTldRefAddress) || !isValidBech32Address(normalizedSldRefAddress)) {
      return res.status(400).json({
        error: "tldRefAddress/sldRefAddress must be valid bech32 or hex-encoded address bytes",
      });
    }

    const provider: any = createProvider();

    const normalizeUnit = (unit: string) => (unit.includes(".") ? unit.replace(".", "") : unit);
    const findUtxoWithAsset = (utxos: any[], assetId: string) => {
      const target = normalizeUnit(assetId);
      for (const utxo of utxos) {
        for (const amt of utxo.output.amount ?? []) {
          if (normalizeUnit(amt.unit) === target) {
            return utxo;
          }
        }
      }
      return null;
    };

    const tldRefUnit = `${csTld}.${createReferenceTokenTN(tldName)}`;
    const sldRefUnit = `${csSld}.${createReferenceTokenTN(sldName)}`;

    const [tldUtxos, sldUtxos] = await Promise.all([
      provider.getUnspentOutputs(normalizedTldRefAddress),
      provider.getUnspentOutputs(normalizedSldRefAddress),
    ]);

    const tldRefUtxo = findUtxoWithAsset(tldUtxos, tldRefUnit);
    const sldRefUtxo = findUtxoWithAsset(sldUtxos, sldRefUnit);

    if (!tldRefUtxo) {
      return res.status(404).json({ error: "TLD reference UTxO not found at tldRefAddress" });
    }
    if (!sldRefUtxo) {
      return res.status(404).json({ error: "SLD reference UTxO not found at sldRefAddress" });
    }

    return res.json({
      tldReferenceRef: {
        txHash: tldRefUtxo.input.txHash,
        txIndex: tldRefUtxo.input.outputIndex,
      },
      sldReferenceRef: {
        txHash: sldRefUtxo.input.txHash,
        txIndex: sldRefUtxo.input.outputIndex,
      },
    });
  } catch (error: any) {
    console.error("Error fetching reference refs:", error);
    return res.status(500).json({ error: "Failed to fetch reference refs", details: error?.message });
  }
}

export async function planSldMint(req: Request, res: Response) {
  try {
    const {
      tldName,
      sldName,
      csTld,
      csSld,
      currentSldHexList = [],
    } = req.body || {};

    if (!tldName || !sldName || !csTld || !csSld) {
      return res.status(400).json({
        error: "tldName, sldName, csTld, csSld are required",
      });
    }

    if (!Array.isArray(currentSldHexList)) {
      return res.status(400).json({
        error: "currentSldHexList must be an array of hex strings (sorted preferred)",
      });
    }

    const artifacts = prepareSldMintArtifacts({
      tldName,
      sldName,
      csTld,
      csSld,
      currentSldHexList,
    });

    return res.json({
      message: "Prepared SLD mint artifacts (datums/redeemers/token names)",
      artifacts,
    });
  } catch (error: any) {
    console.error("Error preparing SLD mint artifacts:", error);
    return res.status(500).json({
      error: "Failed to prepare SLD mint artifacts",
      details: error?.message,
    });
  }
}

export async function planSldMintFull(req: Request, res: Response) {
  try {
    const {
      userAddress,
      ownerAddress,
      tldRefAddress,
      sldRefAddress,
      tldName,
      sldName,
      csTld,
      csSld,
      currentSldHexList = [],
      tldReferenceRef,
      sldReferenceRef,
      minLovelaceTldRef,
      minLovelaceOwner,
      minLovelaceSldRef,
    } = req.body || {};

    if (
      !userAddress ||
      !ownerAddress ||
      !tldRefAddress ||
      !sldRefAddress ||
      !tldName ||
      !sldName ||
      !csTld ||
      !csSld ||
      !tldReferenceRef ||
      !sldReferenceRef
    ) {
      return res.status(400).json({
        error:
          "userAddress, ownerAddress, tldRefAddress, sldRefAddress, tldName, sldName, csTld, csSld, tldReferenceRef, sldReferenceRef are required",
      });
    }

    const normalizedUserAddress = toBech32Address(String(userAddress));
    const normalizedOwnerAddress = toBech32Address(String(ownerAddress));
    const normalizedTldRefAddress = toBech32Address(String(tldRefAddress));
    const normalizedSldRefAddress = toBech32Address(String(sldRefAddress));
    if (
      !isValidBech32Address(normalizedUserAddress) ||
      !isValidBech32Address(normalizedOwnerAddress) ||
      !isValidBech32Address(normalizedTldRefAddress) ||
      !isValidBech32Address(normalizedSldRefAddress)
    ) {
      return res.status(400).json({
        error: "user/owner/tldRef/sldRef addresses must be valid bech32 or hex-encoded address bytes",
      });
    }

    if (
      !isValidTxHash(String(tldReferenceRef?.txHash)) ||
      !isValidTxHash(String(sldReferenceRef?.txHash)) ||
      !isValidTxIndex(Number(tldReferenceRef?.txIndex)) ||
      !isValidTxIndex(Number(sldReferenceRef?.txIndex))
    ) {
      return res.status(400).json({
        error: "tldReferenceRef/sldReferenceRef must include a 64-char hex txHash and non-negative txIndex",
      });
    }

    console.log("SLD mint plan refs:", {
      tldReferenceRef,
      sldReferenceRef,
    });

    const provider = createProvider();
    const plan = await buildSldMintPlan({
      provider: provider as any,
      userAddress: normalizedUserAddress,
      ownerAddress: normalizedOwnerAddress,
      tldRefAddress: normalizedTldRefAddress,
      sldRefAddress: normalizedSldRefAddress,
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
    });

    return res.json({
      message: "Prepared SLD mint plan (UTxOs, datums, redeemers, outputs, mint bundle)",
      plan,
    });
  } catch (error: any) {
    console.error("Error building SLD mint plan:", error);
    return res.status(500).json({
      error: "Failed to build SLD mint plan",
      details: error?.message,
    });
  }
}

export async function buildSldMint(req: Request, res: Response) {
  try {
    const {
      userAddress,
      ownerAddress,
      tldRefAddress,
      sldRefAddress,
      tldName,
      sldName,
      csTld,
      csSld,
      currentSldHexList = [],
      tldReferenceRef,
      sldReferenceRef,
      minLovelaceTldRef,
      minLovelaceOwner,
      minLovelaceSldRef,
    } = req.body || {};

    if (
      !userAddress ||
      !ownerAddress ||
      !tldRefAddress ||
      !sldRefAddress ||
      !tldName ||
      !sldName ||
      !csTld ||
      !csSld ||
      !tldReferenceRef ||
      !sldReferenceRef
    ) {
      return res.status(400).json({
        error:
          "userAddress, ownerAddress, tldRefAddress, sldRefAddress, tldName, sldName, csTld, csSld, tldReferenceRef, sldReferenceRef are required",
      });
    }

    const normalizedUserAddress = toBech32Address(String(userAddress));
    const normalizedOwnerAddress = toBech32Address(String(ownerAddress));
    const normalizedTldRefAddress = toBech32Address(String(tldRefAddress));
    const normalizedSldRefAddress = toBech32Address(String(sldRefAddress));
    if (
      !isValidBech32Address(normalizedUserAddress) ||
      !isValidBech32Address(normalizedOwnerAddress) ||
      !isValidBech32Address(normalizedTldRefAddress) ||
      !isValidBech32Address(normalizedSldRefAddress)
    ) {
      return res.status(400).json({
        error: "user/owner/tldRef/sldRef addresses must be valid bech32 or hex-encoded address bytes",
      });
    }

    if (
      !isValidTxHash(String(tldReferenceRef?.txHash)) ||
      !isValidTxHash(String(sldReferenceRef?.txHash)) ||
      !isValidTxIndex(Number(tldReferenceRef?.txIndex)) ||
      !isValidTxIndex(Number(sldReferenceRef?.txIndex))
    ) {
      return res.status(400).json({
        error: "tldReferenceRef/sldReferenceRef must include a 64-char hex txHash and non-negative txIndex",
      });
    }

    console.log("SLD mint build refs:", {
      tldReferenceRef,
      sldReferenceRef,
    });

    const provider = createProvider();
    const result = await buildSldMintTx({
      provider: provider as any,
      userAddress: normalizedUserAddress,
      ownerAddress: normalizedOwnerAddress,
      tldRefAddress: normalizedTldRefAddress,
      sldRefAddress: normalizedSldRefAddress,
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
    });

    return res.json({
      message: "Built unsigned SLD mint transaction",
      unsignedTx: result.unsignedTx,
      plan: result.plan,
    });
  } catch (error: any) {
    console.error("Error building SLD mint tx:", error);
    return res.status(500).json({
      error: "Failed to build SLD mint transaction",
      details: error?.message,
    });
  }
}

function hexToString(hex: string) {
  let str = "";
  for (let i = 0; i < hex.length; i += 2) {
    str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
  }
  return str;
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
      const assetId = `${policy.to_hex()}.${Buffer.from(assetName.name()).toString("hex")}`;
      assets[assetId] = amount.to_str();
    }
  }

  return assets;
}
