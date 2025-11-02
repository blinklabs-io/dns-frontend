import { LargestFirstInputSelector, MeshTxBuilder, resolvePaymentKeyHash } from "@meshsdk/core";
import type { IFetcher } from "@meshsdk/common";
import { buildSldMintPlan, type Amount } from "./sldMintPlanner.js";
import type { SldMintPlan } from "./sldMintPlanner.js";
import type { PlutusJsonConstr } from "./sldBuilder.js";
import { normalizeAssetId } from "../utils/cardano.js";

function outputAssets(spec: { lovelace: bigint; assets: Amount[] }): Amount[] {
  return [{ unit: "lovelace", quantity: spec.lovelace.toString() }, ...spec.assets];
}

export async function buildSldMintTx(params: {
  provider: IFetcher;
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
  minLovelaceSldUser?: bigint;
}): Promise<{ unsignedTx: string; plan: SldMintPlan }> {
  const { provider } = params;

  const plan = await buildSldMintPlan(params);

  const txBuilder = new MeshTxBuilder({
    fetcher: provider,
    selector: new LargestFirstInputSelector(),
    verbose: false,
  });

  const { tldReferenceRef, sldReferenceRef } = plan.references;
  const { userLovelace, ownerLovelace, tldUserTokenUtxo, tldRefTokenUtxo, collateral } = plan.inputs;

  // Inputs: user payment, owner lovelace, TLD user token, collateral
  // Deduplicate: when ownerAddress === userAddress, UTxOs may overlap
  const addedInputs = new Set<string>();
  const addInput = (utxo: typeof userLovelace) => {
    const ref = `${utxo.input.txHash}#${utxo.input.outputIndex}`;
    if (addedInputs.has(ref)) return;
    addedInputs.add(ref);
    txBuilder.txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, utxo.output.address);
  };
  addInput(userLovelace);
  addInput(ownerLovelace);
  addInput(tldUserTokenUtxo);
  txBuilder.txInCollateral(
    collateral.input.txHash,
    collateral.input.outputIndex,
    collateral.output.amount,
    collateral.output.address
  );

  // TLD reference UTxO with Plutus script
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

  // Required signer: The owner must sign to authorize the SLD mint.
  // The Plutus script validates that the owner's pub key hash is in the required signers.
  const ownerPubKeyHash = resolvePaymentKeyHash(params.ownerAddress);
  txBuilder.requiredSignerHash(ownerPubKeyHash);

  // Outputs
  txBuilder
    .txOut(plan.outputs.tldRef.address, outputAssets(plan.outputs.tldRef))
    .txOutInlineDatumValue(plan.outputs.tldRef.inlineDatum as PlutusJsonConstr, "JSON");
  // Return the TLD user token to the owner along with their original ADA and any native assets.
  // Merge the ownerLovelace and tldUserTokenUtxo values with the plan outputs to produce
  // a single owner output. Including tldUserTokenUtxo ensures the owner doesn't lose ADA
  // from that UTxO when userAddress !== ownerAddress (otherwise it would go to change).
  const ownerInputUtxos = [ownerLovelace, tldUserTokenUtxo];
  const ownerInputLovelace = ownerInputUtxos
    .flatMap((u) => u.output.amount)
    .filter((a) => a.unit === "lovelace")
    .reduce((sum, a) => sum + BigInt(a.quantity), 0n);
  // Ensure we meet the min-UTxO requirement while returning all owner input ADA
  const ownerLovelaceTotal = ownerInputLovelace > plan.outputs.owner.lovelace
    ? ownerInputLovelace
    : plan.outputs.owner.lovelace;
  const planAssetUnits = new Set(plan.outputs.owner.assets.map((a) => normalizeAssetId(a.unit)));
  const ownerNonLovelaceAssets = ownerInputUtxos
    .flatMap((u) => u.output.amount)
    .filter((a) => a.unit !== "lovelace" && !planAssetUnits.has(normalizeAssetId(a.unit)));
  txBuilder.txOut(plan.outputs.owner.address, [
    { unit: "lovelace", quantity: ownerLovelaceTotal.toString() },
    ...ownerNonLovelaceAssets,
    ...plan.outputs.owner.assets,
  ]);
  txBuilder
    .txOut(plan.outputs.sldRef.address, outputAssets(plan.outputs.sldRef))
    .txOutInlineDatumValue(plan.outputs.sldRef.inlineDatum as PlutusJsonConstr, "JSON");
  txBuilder.txOut(plan.outputs.sldUser.address, outputAssets(plan.outputs.sldUser));

  // Mint SLD tokens using reference script
  // Each mint needs its own complete chain: mintPlutusScriptV3 -> mint -> mintTxInReference -> mintRedeemerValue
  // This is because calling .mint() a second time queues the previous mint, which fails if scriptSource isn't set yet
  for (const asset of plan.mint.assets) {
    txBuilder
      .mintPlutusScriptV3()
      .mint(asset.quantity, asset.policyId, asset.assetNameHex)
      .mintTxInReference(sldReferenceRef.txHash, sldReferenceRef.txIndex)
      .mintRedeemerValue(plan.mint.redeemer as PlutusJsonConstr, "JSON");
  }

  // Balancing: exclude already-claimed UTxOs from coin selection to prevent duplicates
  const claimedRefs = new Set([
    `${userLovelace.input.txHash}#${userLovelace.input.outputIndex}`,
    `${ownerLovelace.input.txHash}#${ownerLovelace.input.outputIndex}`,
    `${tldUserTokenUtxo.input.txHash}#${tldUserTokenUtxo.input.outputIndex}`,
    `${tldRefTokenUtxo.input.txHash}#${tldRefTokenUtxo.input.outputIndex}`,
    `${collateral.input.txHash}#${collateral.input.outputIndex}`,
  ]);
  const availableUtxos = plan.userUtxos.filter(
    (u) => !claimedRefs.has(`${u.input.txHash}#${u.input.outputIndex}`)
  );
  txBuilder.selectUtxosFrom(availableUtxos).changeAddress(plan.changeAddress);

  const unsignedTx = await txBuilder.complete();

  return { unsignedTx, plan };
}
