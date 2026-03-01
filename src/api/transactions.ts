const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:3000";

async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Request failed ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

export interface CreateTxRequest {
  recipientAddress: string;
  amount: number;
  address: string;
  assetId: string; // "lovelace" or "policyId.assetNameHex"
}

export interface CreateTxResponse {
  unsignedTx: string;
}

export function createTransaction(payload: CreateTxRequest) {
  return postJSON<CreateTxResponse>("/api/transactions/create", payload);
}

export interface SubmitTxRequest {
  signedTx: string;
}

export interface SubmitTxResponse {
  txId: string;
}

export function submitTransaction(payload: SubmitTxRequest) {
  return postJSON<SubmitTxResponse>("/api/transactions/submit", payload);
}

export interface SubmitPartialTxRequest {
  unsignedTx: string;
  witnessSet: string;
}

export interface SubmitPartialTxResponse {
  txId: string;
  signedTx: string;
}

export function submitPartialTransaction(payload: SubmitPartialTxRequest) {
  return postJSON<SubmitPartialTxResponse>("/api/transactions/submit-partial", payload);
}

export interface DecodeUtxosRequest {
  utxos: string[];
}

export type DecodeUtxosResponse = Array<{
  txHash: string;
  outputIndex: number;
  amount: {
    coins: string;
    assets?: Record<string, string>;
  };
  address: string;
  assetDetails?: Array<{
    id: string;
    policyId: string;
    assetName: string;
    amount: string;
  }>;
}>;

export function decodeUtxos(payload: DecodeUtxosRequest) {
  return postJSON<DecodeUtxosResponse>("/api/transactions/decode-utxos", payload);
}

export interface AddressUtxosRequest {
  address: string;
}

export type AddressUtxosResponse = {
  address: string;
  utxos: unknown[];
};

export function fetchAddressUtxos(payload: AddressUtxosRequest) {
  return postJSON<AddressUtxosResponse>("/api/transactions/address-utxos", payload);
}

// ---- SLD Mint helpers ------------------------------------------------------

export interface MintSldPlanRequest {
  tldName: string;
  sldName: string;
  csTld: string;
  csSld: string;
  currentSldHexList?: string[];
}

export interface MintSldPlanResponse {
  artifacts: unknown;
}

export function planSldMint(payload: MintSldPlanRequest) {
  return postJSON<MintSldPlanResponse>("/api/transactions/mint-sld/plan", payload);
}

export interface MintSldPlanFullRequest extends MintSldPlanRequest {
  userAddress: string;
  ownerAddress?: string;
  tldRefAddress: string;
  sldRefAddress: string;
  tldReferenceRef: { txHash: string; txIndex: number };
  sldReferenceRef: { txHash: string; txIndex: number };
  minLovelaceTldRef?: number;
  minLovelaceOwner?: number;
  minLovelaceSldRef?: number;
  minLovelaceSldUser?: number;
}

export interface MintSldPlanFullResponse {
  plan: unknown;
}

export function planSldMintFull(payload: MintSldPlanFullRequest) {
  return postJSON<MintSldPlanFullResponse>("/api/transactions/mint-sld/plan/full", payload);
}

export interface MintSldBuildResponse {
  unsignedTx: string;
  plan: unknown;
}

export function buildSldMint(payload: MintSldPlanFullRequest) {
  return postJSON<MintSldBuildResponse>("/api/transactions/mint-sld/build", payload);
}

// ---- SLD availability check -------------------------------------------------

export interface CheckSldAvailabilityRequest {
  csTld: string;
  tldName: string;
  sldName: string;
  tldRefAddress: string;
}

export interface CheckSldAvailabilityResponse {
  available: boolean;
}

export function checkSldAvailability(payload: CheckSldAvailabilityRequest) {
  return postJSON<CheckSldAvailabilityResponse>("/api/transactions/mint-sld/check-availability", payload);
}

// ---- Reference refs helper --------------------------------------------------
export interface ReferenceRefsRequest {
  tldRefAddress: string;
  sldRefAddress: string;
  tldName: string;
  sldName: string;
  csTld: string;
  csSld: string;
}

export interface ReferenceRefsResponse {
  tldReferenceRef: { txHash: string; txIndex: number };
  sldReferenceRef: { txHash: string; txIndex: number };
}

export function fetchReferenceRefs(payload: ReferenceRefsRequest) {
  return postJSON<ReferenceRefsResponse>("/api/transactions/reference-refs", payload);
}

// ---- TLD owner lookup -------------------------------------------------------

export interface TldOwnerResponse {
  ownerAddress: string;
  asset: string;
}

export async function lookupTldOwner(csTld: string, tldName: string): Promise<TldOwnerResponse> {
  const res = await fetch(`${API_BASE_URL}/api/transactions/tld-owner/${encodeURIComponent(csTld)}/${encodeURIComponent(tldName)}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Request failed ${res.status}: ${text}`);
  }
  return res.json() as Promise<TldOwnerResponse>;
}
