import { useCallback, useRef, useState } from "react";
import {
  planSldMintFull,
  buildSldMint,
  fetchReferenceRefs,
  fetchAddressUtxos,
  submitPartialTransaction,
  checkSldAvailability,
} from "../api/transactions";
import type { MintSldPlanFullRequest, AddressUtxosResponse } from "../api/transactions";


type Status = { kind: "idle" } | { kind: "loading"; message: string } | { kind: "error"; message: string } | { kind: "success"; message: string };

type Props = {
  prefill?: Partial<MintSldPlanFullRequest>;
  walletApi?: { signTx: (tx: string, partialSign?: boolean) => Promise<string> };
};

const fieldClass =
  "w-full rounded-xl border border-white/15 bg-white/[0.08] px-3 py-2 text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#9400FF]/40";

const isValidDomainName = (name: string) => /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(name);

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

export default function SldMintPanel({ prefill, walletApi }: Props) {
  const [form, setForm] = useState<MintSldPlanFullRequest>(() => {
    const defaults: MintSldPlanFullRequest = {
      tldName: "hello-handshake",
      sldName: "",
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
      minLovelaceSldRef: 2_000_000,
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
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [ownerEdited, setOwnerEdited] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const [availability, setAvailability] = useState<{ kind: "idle" } | { kind: "checking" } | { kind: "available" } | { kind: "taken" } | { kind: "error"; message: string }>({ kind: "idle" });
  const availabilityTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const availabilityAbortRef = useRef<AbortController | null>(null);

  const scheduleAvailabilityCheck = useCallback((sldName: string, csTld: string, tldName: string, tldRefAddress: string) => {
    // Cancel pending
    if (availabilityTimerRef.current) clearTimeout(availabilityTimerRef.current);
    availabilityAbortRef.current?.abort();

    const trimmed = sldName.trim();
    if (!trimmed || !isValidDomainName(trimmed) || !csTld || !tldName || !tldRefAddress) {
      setAvailability({ kind: "idle" });
      return;
    }

    setAvailability({ kind: "checking" });

    availabilityTimerRef.current = setTimeout(() => {
      const controller = new AbortController();
      availabilityAbortRef.current = controller;

      checkSldAvailability({ csTld, tldName, sldName: trimmed, tldRefAddress })
        .then((res) => {
          if (controller.signal.aborted) return;
          setAvailability(res.available ? { kind: "available" } : { kind: "taken" });
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          setAvailability({ kind: "error", message: err instanceof Error ? err.message : "Check failed" });
        });
    }, 500);
  }, []);

  const copyWithFeedback = (text: string, key: string) => {
    copyToClipboard(text);
    setCopiedKey(key);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopiedKey(null), 1500);
  };

  const update = (key: keyof MintSldPlanFullRequest, value: unknown) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  /** Build and validate the API payload from current form state. Returns null on validation failure. */
  const buildPayload = useCallback((): MintSldPlanFullRequest | null => {
    const trimmedSld = form.sldName.trim();
    if (!trimmedSld) {
      setStatus({ kind: "error", message: "Please enter a domain name" });
      return null;
    }
    if (!isValidDomainName(trimmedSld)) {
      setStatus({ kind: "error", message: "Domain name must be alphanumeric with optional hyphens, and cannot start or end with a hyphen" });
      return null;
    }
    const tldHash = form.tldReferenceRef.txHash.trim();
    const sldHash = form.sldReferenceRef.txHash.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(tldHash) || !/^[0-9a-fA-F]{64}$/.test(sldHash)) {
      setStatus({ kind: "error", message: "Reference tx hashes must be 64 hex chars. Check Advanced settings." });
      return null;
    }
    const tldTxIndex = Number(form.tldReferenceRef.txIndex);
    const sldTxIndex = Number(form.sldReferenceRef.txIndex);
    if (!Number.isInteger(tldTxIndex) || tldTxIndex < 0 || !Number.isInteger(sldTxIndex) || sldTxIndex < 0) {
      setStatus({ kind: "error", message: "Reference tx indexes must be non-negative integers. Check Advanced settings." });
      return null;
    }
    const { currentSldHexList, ...formWithoutSldList } = form;
    return {
      ...formWithoutSldList,
      sldName: trimmedSld,
      // Use prefill ownerAddress as fallback unless the user has explicitly edited the field
      ownerAddress: ownerEdited ? form.ownerAddress : (form.ownerAddress || prefill?.ownerAddress || ""),
      ...(currentSldHexList && currentSldHexList.length > 0 ? { currentSldHexList } : {}),
      tldReferenceRef: { txHash: tldHash, txIndex: tldTxIndex },
      sldReferenceRef: { txHash: sldHash, txIndex: sldTxIndex },
    };
  }, [form, prefill?.ownerAddress, ownerEdited]);

  const submit = useCallback(async (builder: "plan" | "build") => {
    setStatus({ kind: "loading", message: builder === "build" ? "Building unsigned transaction..." : "Planning..." });
    setResult(null);
    setWitnessSetHex(null);
    setSubmittedTxId(null);
    try {
      const payload = buildPayload();
      if (!payload) return;

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
  }, [buildPayload]);

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
  const signTransaction = useCallback(async (txCbor: string): Promise<string> => {
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
  }, [walletApi]);

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

  const buyDomain = useCallback(async () => {
    if (!walletApi?.signTx) {
      setStatus({ kind: "error", message: "Please connect your wallet first" });
      return;
    }

    setResult(null);
    setWitnessSetHex(null);
    setSubmittedTxId(null);
    setSubmitStatus({ kind: "idle" });

    const payload = buildPayload();
    if (!payload) return;

    setStatus({ kind: "loading", message: "Building transaction..." });

    try {
      const buildRes = await buildSldMint(payload);
      setResult({ plan: buildRes.plan, unsignedTx: buildRes.unsignedTx });

      setStatus({ kind: "loading", message: "Requesting wallet signature..." });
      const signed = await signTransaction(buildRes.unsignedTx);
      setWitnessSetHex(signed);

      setStatus({ kind: "loading", message: "Submitting transaction..." });
      const submitRes = await submitPartialTransaction({
        unsignedTx: buildRes.unsignedTx,
        witnessSet: signed,
      });
      setSubmittedTxId(submitRes.txId);
      setStatus({ kind: "success", message: "Domain purchased!" });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Unknown error" });
    }
  }, [buildPayload, walletApi, signTransaction]);

  const isLoading = status.kind === "loading";
  const trimmedSld = form.sldName.trim();
  const fullDomain = trimmedSld ? `${trimmedSld}.${form.tldName}` : "";
  const canPurchase = !isLoading && !!walletApi?.signTx && availability.kind === "available" && !!trimmedSld;

  return (
    <div className="w-full max-w-xl mx-auto rounded-2xl bg-white/[0.04] border border-white/10 backdrop-blur-sm px-8 py-10 space-y-6">
      {/* ---- Main purchase UI ---- */}
      <h2 className="text-white text-2xl font-bold tracking-tight">Register a domain</h2>

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label htmlFor="sld-name" className="block text-sm font-ibm-plex text-white/50 mb-2">Domain name</label>
          <input
            id="sld-name"
            aria-label="Domain name"
            className={`${fieldClass} h-12 text-lg`}
            placeholder="yourname"
            value={form.sldName || ""}
            onChange={(e) => {
              update("sldName", e.target.value);
              scheduleAvailabilityCheck(e.target.value, form.csTld, form.tldName, form.tldRefAddress);
            }}
          />
        </div>
        <span className="h-12 flex items-center text-white/50 text-lg select-none">.</span>
        <div className="w-48">
          <label htmlFor="tld-select" className="block text-sm font-ibm-plex text-white/50 mb-2">Top-level domain</label>
          <select
            id="tld-select"
            aria-label="TLD"
            value={form.tldName}
            className={`${fieldClass} h-12`}
            disabled
          >
            <option value="hello-handshake">hello-handshake</option>
            <option value="ada" disabled>ada (coming soon)</option>
            <option value="cardano" disabled>cardano (coming soon)</option>
          </select>
        </div>
      </div>

      <button
        onClick={() => void buyDomain()}
        disabled={!canPurchase}
        className={`w-full h-12 rounded-xl text-sm font-bold font-ibm-plex transition-colors ${
          availability.kind === "taken"
            ? "bg-red-500/20 text-red-400 border border-red-500/30 cursor-not-allowed"
            : availability.kind === "error"
              ? "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 cursor-not-allowed"
              : !canPurchase
                ? "bg-white text-black opacity-60 cursor-not-allowed"
                : "bg-white text-black hover:bg-gray-100 cursor-pointer"
        }`}
      >
        {isLoading
          ? "Processing..."
          : availability.kind === "checking"
            ? "Checking availability..."
            : availability.kind === "taken"
              ? `${fullDomain || "Domain"} is not available`
              : availability.kind === "error"
                ? "Could not verify availability"
                : fullDomain
                  ? `Purchase ${fullDomain}`
                  : "Purchase domain"}
      </button>

      {/* ---- Status area ---- */}
      {status.kind === "loading" && (
        <p className="text-white/80 text-sm font-ibm-plex animate-pulse">{status.message}</p>
      )}
      {status.kind === "error" && (
        <p className="text-red-400 text-sm font-ibm-plex">Error: {status.message}</p>
      )}
      {status.kind === "success" && (
        <p className="text-emerald-400 text-sm font-ibm-plex">{status.message}</p>
      )}
      {submittedTxId && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-white/70 break-all">Tx ID: {submittedTxId}</span>
          <button
            onClick={() => copyWithFeedback(submittedTxId, "txId")}
            className="shrink-0 rounded border border-white/30 px-2 py-1 text-white/70 hover:bg-white/10"
          >
            {copiedKey === "txId" ? "Copied!" : "Copy"}
          </button>
        </div>
      )}

      {/* ---- Advanced toggle ---- */}
      <div className="flex justify-end">
        <button
          onClick={() => setShowAdvanced((v) => !v)}
          className="text-xs font-ibm-plex text-white/30 hover:text-white/60 transition-colors"
        >
          {showAdvanced ? "Hide advanced" : "Advanced options"}
        </button>
      </div>

      {/* ---- Advanced collapsible section ---- */}
      {showAdvanced && (
        <div className="space-y-4 border-t border-white/10 pt-4">
          {/* Header row with action buttons */}
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold text-white">Advanced</span>
            <div className="flex gap-2">
              <button onClick={() => void submit("plan")} className="rounded-xl border border-white/20 px-3 py-2 text-white text-sm font-ibm-plex hover:bg-white/5 transition-colors">
                Plan
              </button>
              <button onClick={() => void fetchRefs()} className="rounded-xl border border-white/20 px-3 py-2 text-white text-sm font-ibm-plex hover:bg-white/5 transition-colors">
                Auto-fetch refs
              </button>
              <button onClick={() => void fetchUtxos()} className="rounded-xl border border-white/20 px-3 py-2 text-white text-sm font-ibm-plex hover:bg-white/5 transition-colors">
                Check wallet UTxOs
              </button>
            </div>
          </div>

          {/* Ref / UTxO status messages */}
          {refStatus.kind === "loading" && <span className="text-xs text-white/70">Fetching refs...</span>}
          {refStatus.kind === "error" && <span className="text-xs text-red-400/90">{refStatus.message}</span>}
          {utxoStatus.kind === "loading" && <span className="text-xs text-white/70">Loading UTxOs...</span>}
          {utxoStatus.kind === "error" && <span className="text-xs text-red-400/90">{utxoStatus.message}</span>}

          {/* Read-only form fields grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-white/50 mb-1">TLD name</label>
              <input aria-label="TLD name" readOnly className={fieldClass} value={form.tldName || ""} />
            </div>
            <div>
              <label className="block text-xs text-white/50 mb-1">SLD name</label>
              <input aria-label="SLD name" readOnly className={fieldClass} value={form.sldName || ""} />
            </div>
            <div>
              <label className="block text-xs text-white/50 mb-1">Policy ID (TLD)</label>
              <input aria-label="TLD policy ID" readOnly className={fieldClass} value={form.csTld || ""} />
            </div>
            <div>
              <label className="block text-xs text-white/50 mb-1">Policy ID (SLD)</label>
              <input aria-label="SLD policy ID" readOnly className={fieldClass} value={form.csSld || ""} />
            </div>
            <div>
              <label className="block text-xs text-white/50 mb-1">User address</label>
              <input aria-label="User address" readOnly className={fieldClass} value={form.userAddress || ""} />
            </div>
            <div>
              <label className="block text-xs text-white/50 mb-1">Owner address</label>
              <input aria-label="Owner address" className={fieldClass} value={ownerEdited ? form.ownerAddress : (form.ownerAddress || prefill?.ownerAddress || "")} onChange={(e) => { setOwnerEdited(true); update("ownerAddress", e.target.value); }} placeholder="Auto-detected from on-chain lookup" />
            </div>
            <div>
              <label className="block text-xs text-white/50 mb-1">TLD ref address</label>
              <input aria-label="TLD reference address" readOnly className={fieldClass} value={form.tldRefAddress || ""} />
            </div>
            <div>
              <label className="block text-xs text-white/50 mb-1">SLD ref address</label>
              <input aria-label="SLD reference address" readOnly className={fieldClass} value={form.sldRefAddress || ""} />
            </div>
            <div>
              <label className="block text-xs text-white/50 mb-1">TLD ref tx hash</label>
              <input aria-label="TLD reference transaction hash" readOnly className={fieldClass} value={form.tldReferenceRef.txHash || ""} />
            </div>
            <div>
              <label className="block text-xs text-white/50 mb-1">TLD ref tx index</label>
              <input aria-label="TLD reference transaction index" readOnly className={fieldClass} value={form.tldReferenceRef.txIndex ?? ""} />
            </div>
            <div>
              <label className="block text-xs text-white/50 mb-1">SLD ref tx hash</label>
              <input aria-label="SLD reference transaction hash" readOnly className={fieldClass} value={form.sldReferenceRef.txHash || ""} />
            </div>
            <div>
              <label className="block text-xs text-white/50 mb-1">SLD ref tx index</label>
              <input aria-label="SLD reference transaction index" readOnly className={fieldClass} value={form.sldReferenceRef.txIndex ?? ""} />
            </div>
            <div>
              <label className="block text-xs text-white/50 mb-1">Min ADA TLD ref</label>
              <input aria-label="Minimum ADA for TLD reference" readOnly className={fieldClass} value={form.minLovelaceTldRef} />
            </div>
            <div>
              <label className="block text-xs text-white/50 mb-1">Min ADA Owner</label>
              <input aria-label="Minimum ADA for owner" readOnly className={fieldClass} value={form.minLovelaceOwner} />
            </div>
            <div>
              <label className="block text-xs text-white/50 mb-1">Min ADA SLD ref</label>
              <input aria-label="Minimum ADA for SLD reference" readOnly className={fieldClass} value={form.minLovelaceSldRef} />
            </div>
          </div>

          {/* Plan JSON output */}
          {result?.plan != null && (
            <details className="rounded-md border border-white/15 bg-black/30 p-3 text-white/80">
              <summary className="cursor-pointer text-sm font-semibold text-white">Plan</summary>
              <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-white/70">{JSON.stringify(result.plan, null, 2)}</pre>
            </details>
          )}

          {/* Wallet UTxOs output */}
          {addressUtxos && (
            <details className="rounded-md border border-white/15 bg-black/30 p-3 text-white/80">
              <summary className="cursor-pointer text-sm font-semibold text-white">Wallet UTxOs</summary>
              <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-white/70">{JSON.stringify(addressUtxos, null, 2)}</pre>
            </details>
          )}

          {/* Unsigned Tx CBOR section */}
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
                {submitStatus.kind === "error" && <span className="text-xs text-red-400/90">{submitStatus.message}</span>}
                {submitStatus.kind === "success" && <span className="text-xs text-emerald-400/90">{submitStatus.message}</span>}
              </div>

              {/* Witness set display */}
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
      )}
    </div>
  );
}
