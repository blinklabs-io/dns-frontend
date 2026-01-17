/* eslint-env node */

import { LargestFirstInputSelector, MeshTxBuilder, serializeData } from "@meshsdk/core";
import { buildSldMintPlan, type MeshUtxo, type SldMintPlan, type Amount } from "./sldMintPlanner.js";
import type { PlutusJsonConstr } from "./sldBuilder.js";

type MeshFetcher = {
  getUnspentOutputs: (addr: unknown) => Promise<MeshUtxo[]>;
};

function outputAssets(spec: { lovelace: bigint; assets: Amount[] }): Amount[] {
  return [{ unit: "lovelace", quantity: spec.lovelace.toString() }, ...spec.assets];
}

export async function buildSldMintTx(params: {
  provider: MeshFetcher;
  userAddress: string;
  ownerAddress: string;
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
  requiredSigners?: string[];
}): Promise<{ unsignedTx: string; plan: SldMintPlan }> {
  const {
    provider,
    requiredSigners = [],
  } = params;

  const plan = await buildSldMintPlan(params);

  const txBuilder = new MeshTxBuilder({
    fetcher: provider as never,
    selector: new LargestFirstInputSelector(),
    verbose: false,
  });

  const { tldReferenceRef, sldReferenceRef } = plan.references;
  const { userLovelace, tldUserTokenUtxo, tldRefTokenUtxo, collateral } = plan.inputs;

  console.log("SLD mint tx hashes:", {
    tldReferenceRef,
    sldReferenceRef,
    userLovelace: userLovelace.input,
    tldUserTokenUtxo: tldUserTokenUtxo.input,
    tldRefTokenUtxo: tldRefTokenUtxo.input,
    collateral: collateral.input,
  });
  console.log("SLD mint datums (JSON):", {
    tldRef: plan.outputs.tldRef.inlineDatum,
    sldRef: plan.outputs.sldRef.inlineDatum,
  });
  console.log("SLD mint redeemers (JSON):", {
    tldReference: plan.redeemers.tldReference,
    sldMint: plan.mint.redeemer,
  });
  console.log("SLD mint datums (CBOR):", {
    tldRef: serializeData(plan.outputs.tldRef.inlineDatum as PlutusJsonConstr, "JSON"),
    sldRef: serializeData(plan.outputs.sldRef.inlineDatum as PlutusJsonConstr, "JSON"),
  });
  console.log("SLD mint redeemers (CBOR):", {
    tldReference: serializeData(plan.redeemers.tldReference as PlutusJsonConstr, "JSON"),
    sldMint: serializeData(plan.mint.redeemer as PlutusJsonConstr, "JSON"),
  });

  // Spend TLD reference UTxO with reference script + inline datum + redeemer
  txBuilder
    .spendingPlutusScriptV3()
    .txIn(
      tldRefTokenUtxo.input.txHash,
      tldRefTokenUtxo.input.outputIndex,
      tldRefTokenUtxo.output.amount,
      tldRefTokenUtxo.output.address
    )
    .txInInlineDatumPresent()
    .txInRedeemerValue(plan.redeemers.tldReference as PlutusJsonConstr, "JSON")
    .spendingTxInReference(tldReferenceRef.txHash, tldReferenceRef.txIndex);

  // Other inputs (no scripts)
  const addSimpleInput = (utxo: MeshUtxo) => {
    txBuilder.txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, utxo.output.address);
  };
  addSimpleInput(userLovelace);
  addSimpleInput(tldUserTokenUtxo);

  // Collateral
  txBuilder.txInCollateral(
    collateral.input.txHash,
    collateral.input.outputIndex,
    collateral.output.amount,
    collateral.output.address
  );

  // Outputs with inline datums
  txBuilder
    .txOut(plan.outputs.tldRef.address, outputAssets(plan.outputs.tldRef))
    .txOutInlineDatumValue(plan.outputs.tldRef.inlineDatum as PlutusJsonConstr, "JSON");

  txBuilder.txOut(plan.outputs.owner.address, outputAssets(plan.outputs.owner));

  txBuilder
    .txOut(plan.outputs.sldRef.address, outputAssets(plan.outputs.sldRef))
    .txOutInlineDatumValue(plan.outputs.sldRef.inlineDatum as PlutusJsonConstr, "JSON");

  // Mint bundle via reference script
  txBuilder.mintPlutusScriptV3();
  for (const asset of plan.mint.assets) {
    txBuilder.mint(asset.quantity, asset.policyId, asset.assetNameHex);
  }
  txBuilder
    .mintRedeemerValue(plan.mint.redeemer as PlutusJsonConstr, "JSON")
    .mintTxInReference(sldReferenceRef.txHash, sldReferenceRef.txIndex);

  // Balance with user UTxOs and set change/collateral change
  txBuilder
    .selectUtxosFrom(plan.userUtxos)
    .changeAddress(plan.changeAddress);

  // Required signers (if provided)
  for (const signer of requiredSigners) {
    txBuilder.requiredSignerHash(signer);
  }

  const unsignedTx = await txBuilder.complete();

  return { unsignedTx, plan };
}
