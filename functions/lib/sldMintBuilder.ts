import { buildSldMintPlan, type Amount } from "./sldMintPlanner";
import type { SldMintPlan } from "./sldMintPlanner";
import type { PlutusJsonConstr } from "./sldBuilder";
import { normalizeAssetId } from "./cardano";
import type { MeshProviderAdapter } from "./providerFactory";

const TX_TTL_SECONDS = 3600; // 60 minutes (1 slot = 1 second on Cardano)

function outputAssets(spec: { lovelace: bigint; assets: Amount[] }): Amount[] {
  return [{ unit: "lovelace", quantity: spec.lovelace.toString() }, ...spec.assets];
}

function utxoRef(txHash: string, outputIndex: number): string {
  return `${txHash}#${outputIndex}`;
}

export async function buildSldMintTx(params: {
  provider: MeshProviderAdapter;
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

  const { MeshTxBuilder, LargestFirstInputSelector, resolvePaymentKeyHash } = await import("@meshsdk/core");
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
    const ref = utxoRef(utxo.input.txHash, utxo.input.outputIndex);
    if (addedInputs.has(ref)) return;
    addedInputs.add(ref);
    txBuilder.txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, utxo.output.address);
  };
  addInput(userLovelace);
  addInput(ownerLovelace);
  addInput(tldUserTokenUtxo);

  const collateralRef = utxoRef(
    collateral.input.txHash,
    collateral.input.outputIndex,
  );
  if (addedInputs.has(collateralRef)) {
    throw new Error(`Collateral UTxO collides with normal input: ${collateralRef}`);
  }

  const tldScriptInputRef = utxoRef(
    tldRefTokenUtxo.input.txHash,
    tldRefTokenUtxo.input.outputIndex,
  );
  if (addedInputs.has(tldScriptInputRef)) {
    throw new Error(
      `TLD script input collides with normal input: ${tldScriptInputRef}`,
    );
  }
  if (tldScriptInputRef === collateralRef) {
    throw new Error(
      `TLD script input collides with collateral input: ${tldScriptInputRef}`,
    );
  }

  const tldReferenceRefKey = utxoRef(
    tldReferenceRef.txHash,
    tldReferenceRef.txIndex,
  );
  if (tldReferenceRefKey === tldScriptInputRef) {
    throw new Error(
      `TLD reference script UTxO collides with TLD script input: ${tldReferenceRefKey}`,
    );
  }
  if (addedInputs.has(tldReferenceRefKey) || tldReferenceRefKey === collateralRef) {
    throw new Error(
      `TLD reference script UTxO collides with tx input/collateral: ${tldReferenceRefKey}`,
    );
  }

  const sldReferenceRefKey = utxoRef(
    sldReferenceRef.txHash,
    sldReferenceRef.txIndex,
  );
  if (addedInputs.has(sldReferenceRefKey) || sldReferenceRefKey === collateralRef) {
    throw new Error(
      `SLD reference script UTxO collides with tx input/collateral: ${sldReferenceRefKey}`,
    );
  }
  if (sldReferenceRefKey === tldScriptInputRef || sldReferenceRefKey === tldReferenceRefKey) {
    throw new Error(
      `SLD reference script UTxO collides with another script reference/input: ${sldReferenceRefKey}`,
    );
  }

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
  let ownerPubKeyHash: string;
  try {
    ownerPubKeyHash = resolvePaymentKeyHash(params.ownerAddress);
  } catch {
    throw new Error("Owner address must use a payment key hash (not a script) to sign the SLD mint transaction");
  }
  txBuilder.requiredSignerHash(ownerPubKeyHash);

  // Outputs
  txBuilder
    .txOut(plan.outputs.tldRef.address, outputAssets(plan.outputs.tldRef))
    .txOutInlineDatumValue(plan.outputs.tldRef.inlineDatum as PlutusJsonConstr, "JSON");
  // Return the TLD user token to the owner along with their original ADA and any native assets.
  // When userAddress === ownerAddress, change goes to the same address, so extra ADA and
  // non-plan assets arrive via change — use the plan output directly to avoid over-allocating
  // ADA to the owner output and leaving insufficient funds for other outputs + fees.
  // When userAddress !== ownerAddress, merge ownerLovelace and tldUserTokenUtxo values into
  // the owner output so the owner doesn't lose ADA/assets to the user's change address.
  if (plan.changeAddress === plan.outputs.owner.address) {
    txBuilder.txOut(plan.outputs.owner.address, outputAssets(plan.outputs.owner));
  } else {
    const sameOwnerUtxo =
      ownerLovelace.input.txHash === tldUserTokenUtxo.input.txHash &&
      ownerLovelace.input.outputIndex === tldUserTokenUtxo.input.outputIndex;
    const ownerInputUtxos = sameOwnerUtxo ? [ownerLovelace] : [ownerLovelace, tldUserTokenUtxo];
    const ownerInputLovelace = ownerInputUtxos
      .flatMap((u) => u.output.amount)
      .filter((a) => a.unit === "lovelace")
      .reduce((sum, a) => sum + BigInt(a.quantity), 0n);
    const ownerLovelaceTotal = ownerInputLovelace > plan.outputs.owner.lovelace
      ? ownerInputLovelace
      : plan.outputs.owner.lovelace;
    const planAssetUnits = new Set(plan.outputs.owner.assets.map((a) => normalizeAssetId(a.unit)));
    const ownerAssetMap = new Map<string, bigint>();
    for (const utxo of ownerInputUtxos) {
      for (const a of utxo.output.amount) {
        if (a.unit === "lovelace" || planAssetUnits.has(normalizeAssetId(a.unit))) continue;
        const normalizedUnit = normalizeAssetId(a.unit);
        ownerAssetMap.set(normalizedUnit, (ownerAssetMap.get(normalizedUnit) ?? 0n) + BigInt(a.quantity));
      }
    }
    const ownerNonLovelaceAssets: Amount[] = Array.from(ownerAssetMap.entries()).map(
      ([unit, quantity]) => ({ unit, quantity: quantity.toString() }),
    );
    txBuilder.txOut(plan.outputs.owner.address, [
      { unit: "lovelace", quantity: ownerLovelaceTotal.toString() },
      ...ownerNonLovelaceAssets,
      ...plan.outputs.owner.assets,
    ]);
  }
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

  // Balancing: provide unclaimed UTxOs for coin selection if the builder needs
  // additional inputs to cover fees or min-UTxO.  Already-added inputs are
  // excluded so the builder does not add them a second time.
  const claimedRefs = new Set([
    utxoRef(userLovelace.input.txHash, userLovelace.input.outputIndex),
    utxoRef(ownerLovelace.input.txHash, ownerLovelace.input.outputIndex),
    utxoRef(tldUserTokenUtxo.input.txHash, tldUserTokenUtxo.input.outputIndex),
    utxoRef(tldRefTokenUtxo.input.txHash, tldRefTokenUtxo.input.outputIndex),
    utxoRef(collateral.input.txHash, collateral.input.outputIndex),
  ]);
  const extraUtxos = plan.userUtxos.filter(
    (u) => !claimedRefs.has(utxoRef(u.input.txHash, u.input.outputIndex))
  );
  // When all user UTxOs are already manually added (e.g. userAddress === ownerAddress
  // with few UTxOs), provide the full user UTxO set so the builder can see
  // the value available.  The builder deduplicates against manually-added inputs,
  // but we must still exclude collateral to prevent it from being selected as a normal input.
  const availableUtxos = extraUtxos.length > 0
    ? extraUtxos
    : plan.userUtxos.filter((u) => utxoRef(u.input.txHash, u.input.outputIndex) !== collateralRef);
  txBuilder.selectUtxosFrom(availableUtxos).changeAddress(plan.changeAddress);

  // Set transaction TTL so it expires if not submitted within 60 minutes.
  // latestBlock.slot may be a bigint depending on the provider, so convert
  // explicitly and check it fits in a safe JavaScript number.
  const latestBlock = await provider.fetchLatestBlock();
  const rawSlot = (latestBlock as { slot?: unknown } | null)?.slot;
  let slotBigInt: bigint;
  try {
    slotBigInt = BigInt(rawSlot as bigint | number | string);
  } catch {
    throw new Error(`Failed to determine current slot from latest block (got: ${String(rawSlot)})`);
  }
  if (slotBigInt <= 0n) {
    throw new Error(`Failed to determine current slot from latest block (got: ${String(rawSlot)})`);
  }
  if (slotBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Slot number exceeds safe integer range: ${String(rawSlot)}`);
  }
  const currentSlot = Number(slotBigInt);
  txBuilder.invalidHereafter(currentSlot + TX_TTL_SECONDS);

  const unsignedTx = await txBuilder.complete();

  return { unsignedTx, plan };
}
