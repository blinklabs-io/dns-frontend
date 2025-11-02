import { useCallback, useEffect, useRef, useState } from "react";
import {
  planSldMintFull,
  buildSldMint,
  fetchReferenceRefs,
  fetchAddressUtxos,
  submitPartialTransaction,
} from "../api/transactions";
import type { MintSldPlanFullRequest, AddressUtxosResponse } from "../api/transactions";

type Status = { kind: "idle" } | { kind: "loading"; message: string } | { kind: "error"; message: string } | { kind: "success"; message: string };

type Props = {
  prefill?: Partial<MintSldPlanFullRequest>;
  autoBuild?: boolean;
  walletApi?: { signTx: (tx: string, partialSign?: boolean) => Promise<string> };
};

const fieldClass =
  "w-full rounded-md border border-white/20 bg-black/30 px-3 py-2 text-white placeholder-white/60 focus:outline-none focus:ring-2 focus:ring-white/30";

/** Clipboard write with fallback for older browsers */
function copyToClipboard(text: string) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text: string) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  try {
    textarea.select();
    document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}

export default function SldMintPanel({ prefill, autoBuild, walletApi }: Props) {
  const [form, setForm] = useState<MintSldPlanFullRequest>(() => {
    const defaults: MintSldPlanFullRequest = {
      tldName: "hello-handshake",
      sldName: "mysld",
      csTld: "",
      csSld: "",
      userAddress: "",
      ownerAddress: "",
      tldRefAddress: "",
      sldRefAddress: "",
      tldReferenceRef: { txHash: "", txIndex: 0 },
      sldReferenceRef: { txHash: "", txIndex: 0 },
      currentSldHexList: [],
      minLovelaceTldRef: 2_000_000,
      minLovelaceOwner: 1_262_830,
      minLovelaceSldRef: 1_435_230,
    };
    return {
      ...defaults,
      ...prefill,
      tldReferenceRef: { ...defaults.tldReferenceRef, ...(prefill?.tldReferenceRef || {}) },
      sldReferenceRef: { ...defaults.sldReferenceRef, ...(prefill?.sldReferenceRef || {}) },
    };
  });

  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [refStatus, setRefStatus] = useState<Status>({ kind: "idle" });
  const [utxoStatus, setUtxoStatus] = useState<Status>({ kind: "idle" });
  const [submitStatus, setSubmitStatus] = useState<Status>({ kind: "idle" });
  const [result, setResult] = useState<{ plan?: unknown; unsignedTx?: string } | null>(null);
  const [addressUtxos, setAddressUtxos] = useState<AddressUtxosResponse | null>(null);
  const [submittedTxId, setSubmittedTxId] = useState<string | null>(null);
  const [witnessSetHex, setWitnessSetHex] = useState<string | null>(null);
  const hasAutoBuiltRef = useRef(false);

  const update = (key: keyof MintSldPlanFullRequest, value: unknown) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const isValidTxHash = (hash: string) => /^[0-9a-fA-F]{64}$/.test(hash);
  const isValidTxIndex = (idx: unknown) => Number.isInteger(idx) && (idx as number) >= 0;

  const submit = useCallback(async (builder: "plan" | "build") => {
    setStatus({ kind: "loading", message: builder === "build" ? "Building unsigned transaction..." : "Planning..." });
    setResult(null);
    setWitnessSetHex(null);
    setSubmittedTxId(null);
    try {
      const tldHash = form.tldReferenceRef.txHash.trim();
      const sldHash = form.sldReferenceRef.txHash.trim();
      if (!isValidTxHash(tldHash) || !isValidTxHash(sldHash)) {
        setStatus({ kind: "error", message: "Reference tx hashes must be 64 hex chars" });
        return;
      }
      const tldTxIndex = Number(form.tldReferenceRef.txIndex);
      const sldTxIndex = Number(form.sldReferenceRef.txIndex);
      if (!isValidTxIndex(tldTxIndex) || !isValidTxIndex(sldTxIndex)) {
        setStatus({ kind: "error", message: "Reference tx indexes must be non-negative integers" });
        return;
      }
      const { currentSldHexList, ...formWithoutSldList } = form;
      const payload: MintSldPlanFullRequest = {
        ...formWithoutSldList,
        // Only include currentSldHexList if non-empty; omitting lets the backend extract from datum
        ...(currentSldHexList && currentSldHexList.length > 0 ? { currentSldHexList } : {}),
        tldReferenceRef: { txHash: tldHash, txIndex: tldTxIndex },
        sldReferenceRef: { txHash: sldHash, txIndex: sldTxIndex },
      };

      if (builder === "plan") {
        const res = await planSldMintFull(payload);
        setResult({ plan: res.plan });
        setStatus({ kind: "success", message: "Plan created" });
      } else {
        const res = await buildSldMint(payload);
        setResult({ plan: res.plan, unsignedTx: res.unsignedTx });
        setStatus({ kind: "success", message: "Unsigned transaction built" });
      }
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Unknown error" });
    }
  }, [form]);

  useEffect(() => {
    if (!autoBuild || hasAutoBuiltRef.current) return;
    const ready = form.userAddress && form.ownerAddress && form.tldName && form.sldName &&
                  form.csTld && form.csSld && form.tldRefAddress && form.sldRefAddress &&
                  form.tldReferenceRef.txHash && form.sldReferenceRef.txHash;
    if (!ready) return;
    // Defer to avoid calling setState synchronously in effect
    const timer = setTimeout(() => {
      hasAutoBuiltRef.current = true;
      submit("build").catch(() => {
        hasAutoBuiltRef.current = false; // Allow retry on failure
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [autoBuild, form, submit]);

  const fetchRefs = useCallback(async () => {
    const canFetch = form.tldRefAddress && form.sldRefAddress && form.tldName && form.sldName && form.csTld && form.csSld;
    if (!canFetch) {
      setRefStatus({ kind: "error", message: "Missing addresses or policy IDs" });
      return;
    }
    setRefStatus({ kind: "loading", message: "Fetching..." });
    try {
      const refs = await fetchReferenceRefs({
        tldRefAddress: form.tldRefAddress,
        sldRefAddress: form.sldRefAddress,
        tldName: form.tldName,
        sldName: form.sldName,
        csTld: form.csTld,
        csSld: form.csSld,
      });
      setForm((prev) => ({
        ...prev,
        tldReferenceRef: refs.tldReferenceRef,
        sldReferenceRef: refs.sldReferenceRef,
      }));
      setRefStatus({ kind: "idle" });
    } catch (error) {
      setRefStatus({ kind: "error", message: error instanceof Error ? error.message : "Failed to fetch" });
    }
  }, [form.tldRefAddress, form.sldRefAddress, form.tldName, form.sldName, form.csTld, form.csSld]);

  const fetchUtxos = useCallback(async () => {
    if (!form.userAddress) {
      setUtxoStatus({ kind: "error", message: "Missing user address" });
      return;
    }
    setUtxoStatus({ kind: "loading", message: "Loading..." });
    try {
      const data = await fetchAddressUtxos({ address: form.userAddress });
      setAddressUtxos(data);
      setUtxoStatus({ kind: "idle" });
    } catch (error) {
      setAddressUtxos(null);
      setUtxoStatus({ kind: "error", message: error instanceof Error ? error.message : "Failed to fetch" });
    }
  }, [form.userAddress]);

  /** Always partial-sign: SLD minting involves Plutus scripts so the wallet
   *  can only provide VKey witnesses, never a fully assembled signed tx. */
  const signTransaction = async (txCbor: string): Promise<string> => {
    if (!walletApi?.signTx) throw new Error("Wallet signing not available");

    try {
      return await walletApi.signTx(txCbor, true);
    } catch (error) {
      // Some wallets (e.g. Eternl) expect { partialSign: true } object instead of a boolean.
      // Only retry with object format for errors that specifically indicate a signature/argument type mismatch.
      const msg = error instanceof Error ? error.message.toLowerCase() : "";
      if (msg.includes("partial") || msg.includes("invalid argument") || msg.includes("expected object")) {
        const signWithObject = walletApi.signTx as unknown as (tx: string, opts: { partialSign: boolean }) => Promise<string>;
        return await signWithObject(txCbor, { partialSign: true });
      }
      throw error;
    }
  };

  const handleSign = async (andSubmit: boolean) => {
    if (!walletApi?.signTx || !result?.unsignedTx) {
      setSubmitStatus({ kind: "error", message: "Build a transaction first" });
      return;
    }
    if (submitStatus.kind === "loading") return;

    setSubmitStatus({ kind: "loading", message: "Requesting wallet signature..." });
    setSubmittedTxId(null);
    setWitnessSetHex(null);

    try {
      const signed = await signTransaction(result.unsignedTx);
      setWitnessSetHex(signed);

      if (!andSubmit) {
        setSubmitStatus({ kind: "success", message: "Transaction signed" });
        return;
      }

      setSubmitStatus({ kind: "loading", message: "Submitting transaction..." });

      const res = await submitPartialTransaction({ unsignedTx: result.unsignedTx, witnessSet: signed });
      setSubmittedTxId(res.txId);
      setSubmitStatus({ kind: "success", message: "Transaction submitted" });
    } catch (error) {
      setSubmitStatus({ kind: "error", message: error instanceof Error ? error.message : "Failed" });
    }
  };

  const submitSignedTx = async () => {
    if (!witnessSetHex || submitStatus.kind === "loading") return;

    if (!result?.unsignedTx) {
      setSubmitStatus({ kind: "error", message: "Unsigned transaction required for partial submission. Rebuild the transaction first." });
      return;
    }

    setSubmitStatus({ kind: "loading", message: "Submitting..." });
    setSubmittedTxId(null);

    try {
      const res = await submitPartialTransaction({ unsignedTx: result.unsignedTx, witnessSet: witnessSetHex });
      setSubmittedTxId(res.txId);
      setSubmitStatus({ kind: "success", message: "Transaction submitted" });
    } catch (error) {
      setSubmitStatus({ kind: "error", message: error instanceof Error ? error.message : "Failed" });
    }
  };

  return (
    <div className="w-full max-w-4xl mx-auto mt-10 space-y-4 p-6 rounded-2xl border border-white/15 bg-white/5 backdrop-blur">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-white text-xl font-semibold">SLD Mint</h2>
          <p className="text-white/70 text-sm">Provide addresses, policy IDs, and reference script UTxOs.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => void submit("plan")} className="rounded-md border border-white/30 px-3 py-2 text-white text-sm hover:bg-white/10">
            Plan
          </button>
          <button onClick={() => void submit("build")} className="rounded-md bg-white text-black px-3 py-2 text-sm font-semibold hover:bg-gray-100">
            Build Unsigned Tx
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <input aria-label="TLD name" className={fieldClass} placeholder="TLD name" value={form.tldName || ""} onChange={(e) => update("tldName", e.target.value)} />
        <input aria-label="SLD name" className={fieldClass} placeholder="SLD name" value={form.sldName || ""} onChange={(e) => update("sldName", e.target.value)} />
        <input aria-label="TLD policy ID" className={fieldClass} placeholder="Policy ID (TLD) csTld" value={form.csTld || ""} onChange={(e) => update("csTld", e.target.value)} />
        <input aria-label="SLD policy ID" className={fieldClass} placeholder="Policy ID (SLD) csSld" value={form.csSld || ""} onChange={(e) => update("csSld", e.target.value)} />
        <input aria-label="User address" className={fieldClass} placeholder="User address (bech32)" value={form.userAddress || ""} onChange={(e) => update("userAddress", e.target.value)} />
        <input aria-label="Owner address" className={fieldClass} placeholder="Owner address" value={form.ownerAddress || ""} onChange={(e) => update("ownerAddress", e.target.value)} />
        <input aria-label="TLD reference address" className={fieldClass} placeholder="TLD reference address" value={form.tldRefAddress || ""} onChange={(e) => update("tldRefAddress", e.target.value)} />
        <input aria-label="SLD reference address" className={fieldClass} placeholder="SLD reference address" value={form.sldRefAddress || ""} onChange={(e) => update("sldRefAddress", e.target.value)} />
        <input aria-label="TLD reference transaction hash" className={fieldClass} placeholder="TLD reference tx hash" value={form.tldReferenceRef.txHash || ""} onChange={(e) => update("tldReferenceRef", { ...form.tldReferenceRef, txHash: e.target.value })} />
        <input aria-label="TLD reference transaction index" className={fieldClass} type="number" placeholder="TLD reference tx index" value={form.tldReferenceRef.txIndex ?? ""} onChange={(e) => update("tldReferenceRef", { ...form.tldReferenceRef, txIndex: Number(e.target.value) })} />
        <input aria-label="SLD reference transaction hash" className={fieldClass} placeholder="SLD reference tx hash" value={form.sldReferenceRef.txHash || ""} onChange={(e) => update("sldReferenceRef", { ...form.sldReferenceRef, txHash: e.target.value })} />
        <input aria-label="SLD reference transaction index" className={fieldClass} type="number" placeholder="SLD reference tx index" value={form.sldReferenceRef.txIndex ?? ""} onChange={(e) => update("sldReferenceRef", { ...form.sldReferenceRef, txIndex: Number(e.target.value) })} />
      </div>

      <div className="flex items-center gap-2">
        <button onClick={() => void fetchRefs()} className="rounded-md border border-white/30 px-3 py-2 text-white text-sm hover:bg-white/10">
          Auto-fetch reference txs
        </button>
        <button onClick={() => void fetchUtxos()} className="rounded-md border border-white/30 px-3 py-2 text-white text-sm hover:bg-white/10">
          Check wallet UTxOs
        </button>
        {refStatus.kind === "loading" && <span className="text-xs text-white/70">Fetching...</span>}
        {refStatus.kind === "error" && <span className="text-xs text-red-300">{refStatus.message}</span>}
        {utxoStatus.kind === "loading" && <span className="text-xs text-white/70">Loading...</span>}
        {utxoStatus.kind === "error" && <span className="text-xs text-red-300">{utxoStatus.message}</span>}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <input aria-label="Minimum ADA for TLD reference" className={fieldClass} type="number" placeholder="Min ADA TLD ref" min={1000000} value={form.minLovelaceTldRef} onChange={(e) => update("minLovelaceTldRef", Math.max(1000000, Number(e.target.value)))} />
        <input aria-label="Minimum ADA for owner" className={fieldClass} type="number" placeholder="Min ADA Owner" min={1000000} value={form.minLovelaceOwner} onChange={(e) => update("minLovelaceOwner", Math.max(1000000, Number(e.target.value)))} />
        <input aria-label="Minimum ADA for SLD reference" className={fieldClass} type="number" placeholder="Min ADA SLD ref" min={1000000} value={form.minLovelaceSldRef} onChange={(e) => update("minLovelaceSldRef", Math.max(1000000, Number(e.target.value)))} />
      </div>

      {status.kind === "loading" && <p className="text-white/80 text-sm">{status.message}</p>}
      {status.kind === "error" && <p className="text-red-300 text-sm">Error: {status.message}</p>}
      {status.kind === "success" && <p className="text-green-300 text-sm">{status.message}</p>}

      {result?.plan != null && (
        <details className="rounded-md border border-white/15 bg-black/30 p-3 text-white/80">
          <summary className="cursor-pointer text-sm font-semibold text-white">Plan</summary>
          <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-white/70">{JSON.stringify(result.plan, null, 2)}</pre>
        </details>
      )}

      {addressUtxos && (
        <details className="rounded-md border border-white/15 bg-black/30 p-3 text-white/80">
          <summary className="cursor-pointer text-sm font-semibold text-white">Wallet UTxOs</summary>
          <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-white/70">{JSON.stringify(addressUtxos, null, 2)}</pre>
        </details>
      )}

      {result?.unsignedTx && (
        <div className="rounded-md border border-white/20 bg-black/40 p-3 text-white/80">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold text-white">Unsigned Tx (CBOR)</span>
            <button onClick={() => copyToClipboard(result.unsignedTx || "")} className="text-xs rounded border border-white/30 px-2 py-1 hover:bg-white/10">
              Copy
            </button>
          </div>
          <p className="mt-2 text-xs break-all text-white/70">{result.unsignedTx}</p>

          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={() => void handleSign(true)}
              className={`rounded border border-white/30 px-3 py-2 text-xs text-white ${submitStatus.kind === "loading" ? "opacity-60 cursor-not-allowed" : "hover:bg-white/10"}`}
              disabled={!walletApi?.signTx || submitStatus.kind === "loading"}
            >
              Sign & Submit
            </button>
            <button
              onClick={() => void handleSign(false)}
              className={`rounded border border-white/30 px-3 py-2 text-xs text-white ${submitStatus.kind === "loading" ? "opacity-60 cursor-not-allowed" : "hover:bg-white/10"}`}
              disabled={!walletApi?.signTx || submitStatus.kind === "loading"}
            >
              Sign only
            </button>
            {witnessSetHex && (
              <button
                onClick={() => void submitSignedTx()}
                className={`rounded border border-white/30 px-3 py-2 text-xs text-white ${submitStatus.kind === "loading" ? "opacity-60 cursor-not-allowed" : "hover:bg-white/10"}`}
                disabled={submitStatus.kind === "loading"}
              >
                Submit witness set
              </button>
            )}
            {submitStatus.kind === "loading" && <span className="text-xs text-white/70">{submitStatus.message}</span>}
            {submitStatus.kind === "error" && <span className="text-xs text-red-300">{submitStatus.message}</span>}
            {submitStatus.kind === "success" && <span className="text-xs text-green-300">{submitStatus.message}</span>}
          </div>

          {witnessSetHex && (
            <div className="mt-2 flex items-center gap-2 text-xs text-white/60">
              <span>Witness set ready.</span>
              <button onClick={() => copyToClipboard(witnessSetHex)} className="rounded border border-white/30 px-2 py-1 text-[11px] hover:bg-white/10">
                Copy witness set
              </button>
            </div>
          )}
          {submittedTxId && <p className="mt-2 text-xs text-white/70">Tx ID: {submittedTxId}</p>}
        </div>
      )}
    </div>
  );
}
