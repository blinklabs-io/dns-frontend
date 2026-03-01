/* global Buffer */

import { blake2b } from "@noble/hashes/blake2.js";

export type PlutusJsonConstr = { constructor: number; fields: Array<PlutusJsonField> };
export type PlutusJsonList = { list: Array<PlutusJsonField> };
export type PlutusJsonBytes = { bytes: string };
export type PlutusJsonField = PlutusJsonConstr | PlutusJsonList | PlutusJsonBytes;

export type PreparedArtifacts = {
  tokenNames: {
    tldReferenceTN: string;
    tldUserTN: string;
    sldReferenceTN: string;
    sldUserTN: string;
  };
  assetIds: {
    tldReferenceAssetId: string;
    tldUserAssetId: string;
    sldReferenceAssetId: string;
    sldUserAssetId: string;
  };
  datums: {
    tldDatum: PlutusJsonConstr;
    sldDatum: PlutusJsonConstr;
  };
  redeemers: {
    tldRedeemer: PlutusJsonConstr;
    sldRedeemer: PlutusJsonConstr;
  };
  updatedSlds: string[];
};

// ---- Token name helpers ----------------------------------------------------

function blake2b256Hex(str: string) {
  const bytes = Buffer.from(str, "utf8");
  return Buffer.from(blake2b(bytes, { dkLen: 32 })).toString("hex");
}

export function createReferenceTokenTN(self: string) {
  return blake2b256Hex(`r${self}`);
}

export function createUserTokenTN(self: string) {
  return blake2b256Hex(`u${self}`);
}

// ---- Datum builders --------------------------------------------------------

export function buildTldReferenceDatum({ tldHex, csSld, sldHexListSorted }: { tldHex: string; csSld: string; sldHexListSorted: string[] }): PlutusJsonConstr {
  return {
    constructor: 0,
    fields: [
      { bytes: tldHex },
      { list: sldHexListSorted.map((hex) => ({ bytes: hex })) },
      { bytes: csSld },
      { bytes: "" }, // link to next (empty)
      { list: [] }, // records
    ],
  };
}

export function buildSldReferenceDatum({ tldHex, sldHex }: { tldHex: string; sldHex: string }): PlutusJsonConstr {
  return {
    constructor: 0,
    fields: [
      { bytes: tldHex },
      { bytes: sldHex },
      { list: [] },
    ],
  };
}

// ---- Redeemer builders -----------------------------------------------------

export function buildTldReferenceRedeemerAdd(): PlutusJsonConstr {
  return {
    constructor: 2,
    fields: [],
  };
}

export function buildSldReferenceRedeemerAdd({ tldHex, sldHex }: { tldHex: string; sldHex: string }): PlutusJsonConstr {
  return {
    constructor: 0,
    fields: [
      { bytes: tldHex },
      { list: [{ bytes: sldHex }] }, // mint list
      { list: [] }, // burn list
    ],
  };
}

// ---- SLD list updater ------------------------------------------------------

function compareHexByBytes(a: string, b: string): number {
  const bytesA = Buffer.from(a, "hex");
  const bytesB = Buffer.from(b, "hex");
  const minLen = Math.min(bytesA.length, bytesB.length);
  for (let i = 0; i < minLen; i++) {
    const diff = bytesA[i] - bytesB[i];
    if (diff !== 0) return diff;
  }
  return bytesA.length - bytesB.length;
}

export function updateSldList(currentList: string[], newSldHex: string) {
  const normalizedNew = newSldHex.toLowerCase();
  const normalized = currentList.map((h) => h.toLowerCase());
  if (normalized.includes(normalizedNew)) {
    normalized.sort(compareHexByBytes);
    return normalized;
  }
  const next = [...normalized, normalizedNew];
  next.sort(compareHexByBytes);
  return next;
}

// ---- Asset id helpers ------------------------------------------------------

export function assetId(policyId: string, tnHex: string) {
  // Keep dot delimiter for compatibility with existing callers; builder will normalize.
  return `${policyId}.${tnHex}`;
}

// ---- High-level assembly (data only) --------------------------------------

export function prepareSldMintArtifacts({
  tldName,
  sldName,
  csTld,
  csSld,
  currentSldHexList,
}: {
  tldName: string;
  sldName: string;
  csTld: string;
  csSld: string;
  currentSldHexList: string[];
}): PreparedArtifacts {
  const tldHex = Buffer.from(tldName, "utf8").toString("hex");
  const sldHex = Buffer.from(sldName, "utf8").toString("hex");

  const tldReferenceTN = createReferenceTokenTN(tldName);
  const tldUserTN = createUserTokenTN(tldName);
  const sldReferenceTN = createReferenceTokenTN(sldName);
  const sldUserTN = createUserTokenTN(sldName);

  const updatedSlds = updateSldList(currentSldHexList, sldHex);

  const tldDatum = buildTldReferenceDatum({
    tldHex,
    csSld,
    sldHexListSorted: updatedSlds,
  });

  const sldDatum = buildSldReferenceDatum({
    tldHex,
    sldHex,
  });

  const tldRedeemer = buildTldReferenceRedeemerAdd();
  const sldRedeemer = buildSldReferenceRedeemerAdd({ tldHex, sldHex });

  return {
    tokenNames: {
      tldReferenceTN,
      tldUserTN,
      sldReferenceTN,
      sldUserTN,
    },
    assetIds: {
      tldReferenceAssetId: assetId(csTld, tldReferenceTN),
      tldUserAssetId: assetId(csTld, tldUserTN),
      sldReferenceAssetId: assetId(csSld, sldReferenceTN),
      sldUserAssetId: assetId(csSld, sldUserTN),
    },
    datums: {
      tldDatum,
      sldDatum,
    },
    redeemers: {
      tldRedeemer,
      sldRedeemer,
    },
    updatedSlds,
  };
}

// NOTE: Transaction assembly/submission happens in sldMintPlanner.ts and sldMintBuilder.ts using Mesh.
