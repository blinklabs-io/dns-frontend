/* eslint-env node */

import { prepareSldMintArtifacts, type PreparedArtifacts } from "./sldBuilder.js";

export type Amount = { unit: string; quantity: string };
export type MeshUtxo = {
  input: { txHash: string; outputIndex: number };
  output: { address: string; amount: Amount[]; datumHash?: string; inlineDatum?: unknown };
};

export type ReferenceInput = { txHash: string; txIndex: number };

export type SldMintPlan = {
  artifacts: PreparedArtifacts;
  inputs: {
    userLovelace: MeshUtxo;
    tldUserTokenUtxo: MeshUtxo;
    tldRefTokenUtxo: MeshUtxo;
    collateral: MeshUtxo;
  };
  userUtxos: MeshUtxo[];
  references: {
    tldReferenceRef: ReferenceInput;
    sldReferenceRef: ReferenceInput;
  };
  outputs: {
    tldRef: OutputSpec;
    owner: OutputSpec;
    sldRef: OutputSpec;
  };
  mint: {
    policyId: string;
    assets: { policyId: string; assetNameHex: string; quantity: string }[];
    redeemer: unknown;
  };
  redeemers: {
    tldReference: unknown;
  };
  changeAddress: string;
};

export type OutputSpec = {
  address: string;
  lovelace: bigint;
  assets: Amount[];
  inlineDatum?: unknown;
};

function normalizeAssetId(assetId: string) {
  return assetId.includes(".") ? assetId.replace(".", "") : assetId;
}

function splitAssetId(assetId: string) {
  if (assetId.includes(".")) {
    const [policyId, assetNameHex] = assetId.split(".");
    return { policyId, assetNameHex };
  }
  const policyId = assetId.slice(0, 56);
  const assetNameHex = assetId.slice(56);
  return { policyId, assetNameHex };
}

function getAmount(utxo: MeshUtxo, unit: string): bigint {
  const amt = utxo.output.amount.find((a) => a.unit === unit);
  return amt ? BigInt(amt.quantity) : 0n;
}

function selectLargestLovelace(utxos: MeshUtxo[]): MeshUtxo | null {
  let best: MeshUtxo | null = null;
  for (const utxo of utxos) {
    const coin = getAmount(utxo, "lovelace");
    if (!best || coin > getAmount(best, "lovelace")) {
      best = utxo;
    }
  }
  return best;
}

function isAdaOnly(utxo: MeshUtxo) {
  return utxo.output.amount.every((a) => a.unit === "lovelace");
}

function findUtxoWithAsset(utxos: MeshUtxo[], assetId: string): MeshUtxo | null {
  const normalized = normalizeAssetId(assetId);
  for (const utxo of utxos) {
    if (utxo.output.amount.some((a) => a.unit === normalized || a.unit === assetId)) {
      return utxo;
    }
  }
  return null;
}

export async function buildSldMintPlan({
  provider,
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
  minLovelaceTldRef = 2_000_000n,
  minLovelaceOwner = 1_262_830n,
  minLovelaceSldRef = 1_435_230n,
}: {
  provider: { getUnspentOutputs: (addr: unknown) => Promise<MeshUtxo[]> };
  userAddress: string;
  ownerAddress: string;
  tldRefAddress: string;
  sldRefAddress: string;
  tldName: string;
  sldName: string;
  csTld: string;
  csSld: string;
  currentSldHexList?: string[];
  tldReferenceRef: ReferenceInput;
  sldReferenceRef: ReferenceInput;
  minLovelaceTldRef?: bigint;
  minLovelaceOwner?: bigint;
  minLovelaceSldRef?: bigint;
}): Promise<SldMintPlan> {
  const userUtxos = await provider.getUnspentOutputs(userAddress);
  const ownerUtxos = await provider.getUnspentOutputs(ownerAddress);
  const tldRefUtxos = await provider.getUnspentOutputs(tldRefAddress);

  const adaOnlyUtxos = userUtxos.filter((u) => isAdaOnly(u));
  const collateralUtxo = selectLargestLovelace(adaOnlyUtxos);
  if (!collateralUtxo) {
    throw new Error("No ada-only collateral UTxO available for user. Create a separate ADA-only UTxO for collateral.");
  }
  console.log("SLD mint input collateral:", collateralUtxo.input);

  const spendableUtxos = userUtxos.filter((u) => u !== collateralUtxo);
  const userLovelace = selectLargestLovelace(spendableUtxos);
  if (!userLovelace) {
    throw new Error("No spendable UTxO available besides collateral. Split funds to create a second UTxO.");
  }
  console.log("SLD mint input userLovelace:", userLovelace.input);

  const artifacts: PreparedArtifacts = prepareSldMintArtifacts({
    tldName,
    sldName,
    csTld,
    csSld,
    currentSldHexList: currentSldHexList ?? [],
  });

  const tldUserTokenUtxo = findUtxoWithAsset(ownerUtxos, artifacts.assetIds.tldUserAssetId);
  if (!tldUserTokenUtxo) {
    throw new Error("TLD user token UTxO not found at owner address");
  }
  console.log("SLD mint input tldUserTokenUtxo:", tldUserTokenUtxo.input);

  const tldRefTokenUtxo = findUtxoWithAsset(tldRefUtxos, artifacts.assetIds.tldReferenceAssetId);
  if (!tldRefTokenUtxo) {
    throw new Error("TLD reference token UTxO not found at TLD reference address");
  }
  console.log("SLD mint input tldRefTokenUtxo:", tldRefTokenUtxo.input);

  const { policyId: sldPolicyId, assetNameHex: sldUserAssetNameHex } = splitAssetId(artifacts.assetIds.sldUserAssetId);
  const { assetNameHex: sldRefAssetNameHex } = splitAssetId(artifacts.assetIds.sldReferenceAssetId);
  const tldUserUnit = normalizeAssetId(artifacts.assetIds.tldUserAssetId);
  const tldRefUnit = normalizeAssetId(artifacts.assetIds.tldReferenceAssetId);
  const sldRefUnit = normalizeAssetId(artifacts.assetIds.sldReferenceAssetId);

  const outputs = {
    tldRef: {
      address: tldRefAddress,
      lovelace: minLovelaceTldRef,
      assets: [{ unit: tldRefUnit, quantity: "1" }],
      inlineDatum: artifacts.datums.tldDatum,
    },
    owner: {
      address: ownerAddress,
      lovelace: minLovelaceOwner,
      assets: [{ unit: tldUserUnit, quantity: "1" }],
    },
    sldRef: {
      address: sldRefAddress,
      lovelace: minLovelaceSldRef,
      assets: [{ unit: sldRefUnit, quantity: "1" }],
      inlineDatum: artifacts.datums.sldDatum,
    },
  };

  const mintAssets = [
    { policyId: csSld, assetNameHex: sldUserAssetNameHex, quantity: "1" },
    { policyId: csSld, assetNameHex: sldRefAssetNameHex, quantity: "1" },
  ];

  return {
    artifacts,
    inputs: {
      userLovelace,
      tldUserTokenUtxo,
      tldRefTokenUtxo,
      collateral: collateralUtxo,
    },
    userUtxos,
    references: {
      tldReferenceRef,
      sldReferenceRef,
    },
    outputs,
    mint: {
      policyId: sldPolicyId,
      assets: mintAssets,
      redeemer: artifacts.redeemers.sldRedeemer,
    },
    redeemers: {
      tldReference: artifacts.redeemers.tldRedeemer,
    },
    changeAddress: userAddress,
  };
}
