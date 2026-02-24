import type { IFetcher, UTxO } from "@meshsdk/common";
import { deserializeDatum } from "@meshsdk/core";
import { assetId, createReferenceTokenTN, createUserTokenTN, prepareSldMintArtifacts, type PreparedArtifacts } from "./sldBuilder.js";
import { normalizeAssetId, splitAssetId, MIN_LOVELACE, isValidPolicyId } from "../utils/cardano.js";

export type Amount = { unit: string; quantity: string };
export type MeshUtxo = {
  input: { txHash: string; outputIndex: number };
  output: { address: string; amount: Amount[]; datumHash?: string; inlineDatum?: unknown };
};

/**
 * Converts Mesh SDK UTxO format to our internal MeshUtxo format.
 * Handles datum deserialization from CBOR (plutusData) to JSON (inlineDatum).
 */
function toMeshUtxo(utxo: UTxO): MeshUtxo {
  let inlineDatum: unknown = undefined;
  if (utxo.output.plutusData) {
    try {
      inlineDatum = deserializeDatum(utxo.output.plutusData);
    } catch (e) {
      // eslint-disable-next-line no-control-regex
      const safeTxHash = String(utxo.input.txHash).replace(/[\r\n\x00-\x1f\x7f]/g, "");
      console.warn(`Failed to deserialize datum for UTxO ${safeTxHash}#${utxo.input.outputIndex}:`, e);
    }
  }
  return {
    input: {
      txHash: utxo.input.txHash,
      outputIndex: utxo.input.outputIndex,
    },
    output: {
      address: utxo.output.address,
      amount: utxo.output.amount,
      datumHash: utxo.output.dataHash,
      inlineDatum,
    },
  };
}

export type ReferenceInput = { txHash: string; txIndex: number };

export type SldMintPlan = {
  artifacts: PreparedArtifacts;
  inputs: {
    userLovelace: MeshUtxo;
    ownerLovelace: MeshUtxo;
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
    sldUser: OutputSpec;
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

function isAdaOnly(utxo: MeshUtxo): boolean {
  return utxo.output.amount.every((a) => a.unit === "lovelace");
}

function findUtxoWithAsset(utxos: MeshUtxo[], targetAssetId: string): MeshUtxo | null {
  const normalized = normalizeAssetId(targetAssetId);
  for (const utxo of utxos) {
    if (utxo.output.amount.some((a) => a.unit === normalized || a.unit === targetAssetId)) {
      return utxo;
    }
  }
  return null;
}

/**
 * TLD Reference Datum Structure (Plutus constructor 0):
 *
 * The TLD reference token UTxO contains an inline datum with the following structure:
 * - constructor: 0 (indicates TLD reference datum type)
 * - fields[0]: TLD metadata (varies)
 * - fields[1]: List of registered SLD name hashes
 *   - Each entry is { bytes: "<hex-encoded SLD name>" }
 *
 * Example datum:
 * {
 *   constructor: 0,
 *   fields: [
 *     { ... },  // TLD metadata
 *     { list: [{ bytes: "6d79736c64" }] }  // "mysld" in hex
 *   ]
 * }
 */
function extractSldListFromDatum(inlineDatum: unknown): string[] | null {
  if (!inlineDatum || typeof inlineDatum !== "object") return null;
  const datum = inlineDatum as Record<string, unknown>;

  // Use Object.hasOwn to avoid collision with Object.prototype.constructor
  if (!Object.hasOwn(datum, "constructor") || !Array.isArray(datum.fields)) return null;

  // Constructor can be a number, string, or BigInt depending on the deserializer
  let constructorValue: number;
  if (typeof datum.constructor === "bigint") {
    constructorValue = Number(datum.constructor);
  } else if (typeof datum.constructor === "string") {
    const parsed = parseInt(datum.constructor, 10);
    if (!Number.isFinite(parsed)) return null;
    constructorValue = parsed;
  } else if (typeof datum.constructor === "number") {
    constructorValue = datum.constructor;
  } else {
    return null;
  }

  const fields = datum.fields as unknown[];
  if (constructorValue !== 0 || fields.length < 2) {
    return null;
  }

  const sldListField = fields[1] as { list?: Array<{ bytes?: string }> } | undefined;
  if (!sldListField?.list || !Array.isArray(sldListField.list)) {
    return null;
  }

  return sldListField.list
    .filter((item): item is { bytes: string } => typeof item?.bytes === "string")
    .map((item) => item.bytes);
}

/**
 * Lightweight check: is the given SLD name already registered under this TLD?
 * Reads the TLD reference UTxO datum to get the list of existing SLDs.
 */
export async function checkSldAvailability({
  provider,
  csTld,
  tldName,
  sldName,
  tldRefAddress,
}: {
  provider: IFetcher;
  csTld: string;
  tldName: string;
  sldName: string;
  tldRefAddress: string;
}): Promise<{ available: boolean }> {
  if (!isValidPolicyId(csTld)) {
    throw new Error(`Invalid TLD policy ID: expected 56 hex characters`);
  }

  const rawTldRefUtxos = await provider.fetchAddressUTxOs(tldRefAddress);
  const tldRefUtxos = rawTldRefUtxos.map(toMeshUtxo);

  const tldReferenceAssetId = assetId(csTld, createReferenceTokenTN(tldName));
  const tldRefTokenUtxo = findUtxoWithAsset(tldRefUtxos, tldReferenceAssetId);
  if (!tldRefTokenUtxo) {
    throw new Error(`TLD reference token not found at TLD reference address`);
  }

  const sldList = extractSldListFromDatum(tldRefTokenUtxo.output.inlineDatum);
  if (!sldList) {
    throw new Error("Unable to extract SLD list from TLD reference datum");
  }

  const sldHex = Buffer.from(sldName, "utf8").toString("hex");
  return { available: !sldList.includes(sldHex) };
}

/**
 * Builds a transaction plan for minting a second-level domain (SLD).
 *
 * @param provider - IFetcher provider for querying blockchain data
 * @param userAddress - Address that will receive the SLD user token and pay fees
 * @param ownerAddress - Address that holds the TLD user token (proves ownership)
 * @param tldRefAddress - Script address holding the TLD reference token
 * @param sldRefAddress - Script address that will hold the SLD reference token
 * @param tldName - Name of the parent TLD (e.g., "hello-handshake")
 * @param sldName - Name of the SLD to mint (e.g., "mysld")
 * @param csTld - Policy ID for TLD tokens
 * @param csSld - Policy ID for SLD tokens
 * @param currentSldHexList - Optional: existing SLD names (hex-encoded). If empty, extracted from TLD datum.
 * @param tldReferenceRef - Reference to UTxO containing TLD Plutus script
 * @param sldReferenceRef - Reference to UTxO containing SLD Plutus script
 * @param minLovelaceTldRef - Minimum ADA for TLD reference output (default: 2 ADA)
 * @param minLovelaceOwner - Minimum ADA for owner output (default: ~1.26 ADA)
 * @param minLovelaceSldRef - Minimum ADA for SLD reference output (default: ~1.44 ADA)
 * @param minLovelaceSldUser - Minimum ADA for SLD user token output (default: ~1.26 ADA)
 */
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
  currentSldHexList,
  tldReferenceRef,
  sldReferenceRef,
  minLovelaceTldRef = MIN_LOVELACE.TLD_REF,
  minLovelaceOwner = MIN_LOVELACE.OWNER,
  minLovelaceSldRef = MIN_LOVELACE.SLD_REF,
  minLovelaceSldUser = MIN_LOVELACE.SLD_USER,
}: {
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
  tldReferenceRef: ReferenceInput;
  sldReferenceRef: ReferenceInput;
  minLovelaceTldRef?: bigint;
  minLovelaceOwner?: bigint;
  minLovelaceSldRef?: bigint;
  minLovelaceSldUser?: bigint;
}): Promise<SldMintPlan> {
  // Validate policy IDs early
  if (!isValidPolicyId(csTld)) {
    throw new Error(`Invalid TLD policy ID: expected 56 hex characters, got "${csTld}"`);
  }
  if (!isValidPolicyId(csSld)) {
    throw new Error(`Invalid SLD policy ID: expected 56 hex characters, got "${csSld}"`);
  }

  // Fetch UTxOs in parallel for better performance
  const [rawUserUtxos, rawOwnerUtxos, rawTldRefUtxos] = await Promise.all([
    provider.fetchAddressUTxOs(userAddress),
    provider.fetchAddressUTxOs(ownerAddress),
    provider.fetchAddressUTxOs(tldRefAddress),
  ]);

  // Convert to internal format with datum deserialization
  const userUtxos = rawUserUtxos.map(toMeshUtxo);
  const ownerUtxos = rawOwnerUtxos.map(toMeshUtxo);
  const tldRefUtxos = rawTldRefUtxos.map(toMeshUtxo);

  // Select collateral (must be ADA-only, minimum 5 ADA for Plutus script transactions).
  // Use the smallest qualifying UTxO so the largest UTxOs remain available for payment.
  const MIN_COLLATERAL = 5_000_000n;
  const adaOnlyUtxos = userUtxos.filter((u) => isAdaOnly(u));
  const qualifyingCollateral = adaOnlyUtxos.filter((u) => getAmount(u, "lovelace") >= MIN_COLLATERAL);
  const collateralUtxo = qualifyingCollateral.length > 0
    ? qualifyingCollateral.reduce((smallest, u) =>
        getAmount(u, "lovelace") < getAmount(smallest, "lovelace") ? u : smallest
      )
    : selectLargestLovelace(adaOnlyUtxos);
  if (!collateralUtxo) {
    throw new Error("No ADA-only UTxO available for collateral. Send some ADA to a separate UTxO without tokens.");
  }
  const collateralAmount = getAmount(collateralUtxo, "lovelace");
  if (collateralAmount < MIN_COLLATERAL) {
    throw new Error(
      `Collateral UTxO has insufficient funds: ${collateralAmount} lovelace. ` +
      `Minimum ${MIN_COLLATERAL} lovelace (${MIN_COLLATERAL / 1_000_000n} ADA) required.`
    );
  }

  // Find TLD user token first so we can exclude it from payment UTxO selection
  // (prevents overlap when userAddress === ownerAddress)
  const tldReferenceAssetId = assetId(csTld, createReferenceTokenTN(tldName));
  const tldUserAssetId = assetId(csTld, createUserTokenTN(tldName));

  const tldUserTokenUtxo = findUtxoWithAsset(ownerUtxos, tldUserAssetId);
  if (!tldUserTokenUtxo) {
    throw new Error(`TLD user token not found at owner address. Expected asset: ${tldUserAssetId}`);
  }

  // Select payment UTxO (excluding collateral and TLD user token UTxO to prevent
  // the same UTxO being selected for both userLovelace and tldUserTokenUtxo
  // when userAddress === ownerAddress)
  const spendableUtxos = userUtxos.filter(
    (u) => (u.input.txHash !== collateralUtxo.input.txHash || u.input.outputIndex !== collateralUtxo.input.outputIndex) &&
           (u.input.txHash !== tldUserTokenUtxo.input.txHash || u.input.outputIndex !== tldUserTokenUtxo.input.outputIndex)
  );
  const userLovelace = selectLargestLovelace(spendableUtxos);
  if (!userLovelace) {
    throw new Error("No spendable UTxO available besides collateral. Split funds to create a second UTxO.");
  }

  // Select an owner lovelace UTxO (distinct from the TLD user token UTxO and
  // any UTxOs already claimed as user inputs) so the owner's ADA can be
  // explicitly returned and not swept to the user's change.
  // When userAddress === ownerAddress, reuse the user payment UTxO — the
  // change output will return the owner's ADA automatically.
  const sameAddress = userAddress === ownerAddress;
  let ownerLovelace: MeshUtxo;
  if (sameAddress) {
    ownerLovelace = userLovelace;
  } else {
    const claimedInputs = [tldUserTokenUtxo, collateralUtxo, userLovelace];
    const ownerSpendable = ownerUtxos.filter(
      (u) => !claimedInputs.some((c) => c.input.txHash === u.input.txHash && c.input.outputIndex === u.input.outputIndex)
    );
    const selected = selectLargestLovelace(ownerSpendable);
    if (!selected) {
      throw new Error("No spendable lovelace UTxO available at owner address besides the TLD user token UTxO.");
    }
    ownerLovelace = selected;
  }

  const tldRefTokenUtxo = findUtxoWithAsset(tldRefUtxos, tldReferenceAssetId);
  if (!tldRefTokenUtxo) {
    throw new Error(`TLD reference token not found at TLD reference address. Expected asset: ${tldReferenceAssetId}`);
  }

  // Extract SLD list from TLD reference datum if not explicitly provided.
  // An explicit empty array (first SLD under this TLD) is valid and should not
  // trigger datum extraction.
  const callerProvidedList = currentSldHexList !== undefined;
  let effectiveSldHexList = currentSldHexList ?? [];

  if (!callerProvidedList) {
    const extracted = extractSldListFromDatum(tldRefTokenUtxo.output.inlineDatum);
    if (extracted) {
      effectiveSldHexList = extracted;
    } else {
      throw new Error(
        "Unable to extract current SLD list from TLD reference datum. " +
        "Either pass currentSldHexList explicitly or ensure the TLD reference UTxO has a valid inline datum."
      );
    }
  }

  // Check for duplicate SLD before proceeding
  const sldHex = Buffer.from(sldName, "utf8").toString("hex");
  if (effectiveSldHexList.includes(sldHex)) {
    // Sanitize SLD name to prevent log / message injection via newlines
    // eslint-disable-next-line no-control-regex
    const safeSldName = String(sldName).replace(/[\r\n\x00-\x1f\x7f]/g, "");
    throw new Error(`SLD '${safeSldName}' already exists under this TLD`);
  }

  // Prepare artifacts with the effective SLD list
  const artifacts: PreparedArtifacts = prepareSldMintArtifacts({
    tldName,
    sldName,
    csTld,
    csSld,
    currentSldHexList: effectiveSldHexList,
  });

  const { policyId: sldPolicyId, assetNameHex: sldUserAssetNameHex } = splitAssetId(artifacts.assetIds.sldUserAssetId);
  const { assetNameHex: sldRefAssetNameHex } = splitAssetId(artifacts.assetIds.sldReferenceAssetId);
  const tldUserUnit = normalizeAssetId(artifacts.assetIds.tldUserAssetId);
  const tldRefUnit = normalizeAssetId(artifacts.assetIds.tldReferenceAssetId);
  const sldRefUnit = normalizeAssetId(artifacts.assetIds.sldReferenceAssetId);
  const sldUserUnit = normalizeAssetId(artifacts.assetIds.sldUserAssetId);

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
    sldUser: {
      address: userAddress,
      lovelace: minLovelaceSldUser,
      assets: [{ unit: sldUserUnit, quantity: "1" }],
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
      ownerLovelace,
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
