import { useCallback, useEffect, useRef, useState } from "react";
import { planSldMintFull, buildSldMint, fetchReferenceRefs, fetchAddressUtxos } from "../api/transactions";
import type { MintSldPlanFullRequest, AddressUtxosResponse } from "../api/transactions";

type Status = { kind: "idle" } | { kind: "loading"; message: string } | { kind: "error"; message: string } | { kind: "success"; message: string };
type RefStatus = { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string };
type UtxoStatus = { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string };

type Props = {
  prefill?: Partial<MintSldPlanFullRequest>;
  autoBuild?: boolean;
};

const fieldClass =
  "w-full rounded-md border border-white/20 bg-black/30 px-3 py-2 text-white placeholder-white/60 focus:outline-none focus:ring-2 focus:ring-white/30";

export default function SldMintPanel({ prefill, autoBuild }: Props) {
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
      tldReferenceRef: { txHash: "ef635b55fce6abc39cd4c843722d9d574cb719114e224f2cd1c8747d5abfc19e", txIndex: 1 },
      sldReferenceRef: { txHash: "ef635b55fce6abc39cd4c843722d9d574cb719114e224f2cd1c8747d5abfc19e", txIndex: 2 },
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
  const [refStatus, setRefStatus] = useState<RefStatus>({ kind: "idle" });
  const [utxoStatus, setUtxoStatus] = useState<UtxoStatus>({ kind: "idle" });
  const [result, setResult] = useState<{ plan?: unknown; unsignedTx?: string } | null>(null);
  const [addressUtxos, setAddressUtxos] = useState<AddressUtxosResponse | null>(null);
  const hasAutoBuiltRef = useRef(false);
  const hasUserEditedRef = useRef(false);

  const update = (key: keyof MintSldPlanFullRequest, value: unknown) => {
    hasUserEditedRef.current = true;
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const isValidTxHash = (hash: string) => /^[0-9a-fA-F]{64}$/.test(hash);

  const submit = useCallback(async (builder: "plan" | "build") => {
    setStatus({ kind: "loading", message: builder === "build" ? "Building unsigned transaction..." : "Planning..." });
    setResult(null);
    try {
      const tldHash = form.tldReferenceRef.txHash.trim();
      const sldHash = form.sldReferenceRef.txHash.trim();
      if (!isValidTxHash(tldHash) || !isValidTxHash(sldHash)) {
        setStatus({ kind: "error", message: "Reference tx hashes must be 64 hex chars" });
        return;
      }
      const payload: MintSldPlanFullRequest = {
        ...form,
        tldReferenceRef: {
          txHash: tldHash,
          txIndex: Number(form.tldReferenceRef.txIndex),
        },
        sldReferenceRef: {
          txHash: sldHash,
          txIndex: Number(form.sldReferenceRef.txIndex),
        },
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
      const message = err instanceof Error ? err.message : "Unknown error";
      setStatus({ kind: "error", message });
    }
  }, [form]);

  useEffect(() => {
    if (!autoBuild) return;
    if (hasAutoBuiltRef.current) return;
    if (hasUserEditedRef.current) return;

    const ready =
      form.userAddress &&
      form.ownerAddress &&
      form.tldName &&
      form.sldName &&
      form.csTld &&
      form.csSld &&
      form.tldRefAddress &&
      form.sldRefAddress &&
      form.tldReferenceRef.txHash &&
      form.sldReferenceRef.txHash;

    if (!ready) return;

    hasAutoBuiltRef.current = true;
    setTimeout(() => {
      void submit("build");
    }, 0);
  }, [autoBuild, form, submit]);

  const fetchRefs = useCallback(async () => {
    const canFetch =
      form.tldRefAddress &&
      form.sldRefAddress &&
      form.tldName &&
      form.sldName &&
      form.csTld &&
      form.csSld;
    if (!canFetch) {
      setRefStatus({ kind: "error", message: "Missing addresses or policy IDs" });
      return;
    }
    setRefStatus({ kind: "loading" });
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
      const message = error instanceof Error ? error.message : "Failed to fetch reference UTxOs";
      setRefStatus({ kind: "error", message });
      console.warn("Failed to fetch reference refs", error);
    }
  }, [form.tldRefAddress, form.sldRefAddress, form.tldName, form.sldName, form.csTld, form.csSld]);

  const fetchUtxos = useCallback(async () => {
    if (!form.userAddress) {
      setUtxoStatus({ kind: "error", message: "Missing user address" });
      return;
    }
    setUtxoStatus({ kind: "loading" });
    try {
      const data = await fetchAddressUtxos({ address: form.userAddress });
      setAddressUtxos(data);
      setUtxoStatus({ kind: "idle" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to fetch address UTxOs";
      setUtxoStatus({ kind: "error", message });
      console.warn("Failed to fetch address UTxOs", error);
    }
  }, [form.userAddress]);

  return (
    <div className="w-full max-w-4xl mx-auto mt-10 space-y-4 p-6 rounded-2xl border border-white/15 bg-white/5 backdrop-blur">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-white text-xl font-semibold">SLD Mint</h2>
          <p className="text-white/70 text-sm">Provide addresses, policy IDs, and reference script UTxOs.</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => submit("plan")}
            className="rounded-md border border-white/30 px-3 py-2 text-white text-sm hover:bg-white/10"
          >
            Plan
          </button>
          <button
            onClick={() => submit("build")}
            className="rounded-md bg-white text-black px-3 py-2 text-sm font-semibold hover:bg-gray-100"
          >
            Build Unsigned Tx
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <input className={fieldClass} placeholder="TLD name" value={form.tldName || ""} onChange={(e) => update("tldName", e.target.value)} />
        <input className={fieldClass} placeholder="SLD name" value={form.sldName || ""} onChange={(e) => update("sldName", e.target.value)} />
        <input className={fieldClass} placeholder="Policy ID (TLD) csTld" value={form.csTld || ""} onChange={(e) => update("csTld", e.target.value)} />
        <input className={fieldClass} placeholder="Policy ID (SLD) csSld" value={form.csSld || ""} onChange={(e) => update("csSld", e.target.value)} />
        <input className={fieldClass} placeholder="User address (bech32)" value={form.userAddress || ""} onChange={(e) => update("userAddress", e.target.value)} />
        <input className={fieldClass} placeholder="Owner address (holds TLD user token)" value={form.ownerAddress || ""} onChange={(e) => update("ownerAddress", e.target.value)} />
        <input className={fieldClass} placeholder="TLD reference address" value={form.tldRefAddress || ""} onChange={(e) => update("tldRefAddress", e.target.value)} />
        <input className={fieldClass} placeholder="SLD reference address" value={form.sldRefAddress || ""} onChange={(e) => update("sldRefAddress", e.target.value)} />
        <input className={fieldClass} placeholder="TLD reference tx hash" value={form.tldReferenceRef.txHash || ""} onChange={(e) => update("tldReferenceRef", { ...form.tldReferenceRef, txHash: e.target.value })} />
        <input className={fieldClass} type="number" placeholder="TLD reference tx index" value={form.tldReferenceRef.txIndex ?? ""} onChange={(e) => update("tldReferenceRef", { ...form.tldReferenceRef, txIndex: Number(e.target.value) })} />
        <input className={fieldClass} placeholder="SLD reference tx hash" value={form.sldReferenceRef.txHash || ""} onChange={(e) => update("sldReferenceRef", { ...form.sldReferenceRef, txHash: e.target.value })} />
        <input className={fieldClass} type="number" placeholder="SLD reference tx index" value={form.sldReferenceRef.txIndex ?? ""} onChange={(e) => update("sldReferenceRef", { ...form.sldReferenceRef, txIndex: Number(e.target.value) })} />
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => void fetchRefs()}
          className="rounded-md border border-white/30 px-3 py-2 text-white text-sm hover:bg-white/10"
        >
          Auto-fetch reference txs
        </button>
        <button
          onClick={() => void fetchUtxos()}
          className="rounded-md border border-white/30 px-3 py-2 text-white text-sm hover:bg-white/10"
        >
          Check wallet UTxOs
        </button>
        {refStatus.kind === "loading" && <span className="text-xs text-white/70">Fetching reference UTxOs…</span>}
        {refStatus.kind === "error" && <span className="text-xs text-red-300">Refs error: {refStatus.message}</span>}
        {utxoStatus.kind === "loading" && <span className="text-xs text-white/70">Loading UTxOs…</span>}
        {utxoStatus.kind === "error" && <span className="text-xs text-red-300">UTxO error: {utxoStatus.message}</span>}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <input className={fieldClass} type="number" placeholder="Min ADA TLD ref" value={form.minLovelaceTldRef} onChange={(e) => update("minLovelaceTldRef", Number(e.target.value))} />
        <input className={fieldClass} type="number" placeholder="Min ADA Owner" value={form.minLovelaceOwner} onChange={(e) => update("minLovelaceOwner", Number(e.target.value))} />
        <input className={fieldClass} type="number" placeholder="Min ADA SLD ref" value={form.minLovelaceSldRef} onChange={(e) => update("minLovelaceSldRef", Number(e.target.value))} />
      </div>

      {status.kind === "loading" && <p className="text-white/80 text-sm">{status.message}</p>}
      {status.kind === "error" && <p className="text-red-300 text-sm">Error: {status.message}</p>}
      {status.kind === "success" && <p className="text-green-300 text-sm">{status.message}</p>}

      {!!result?.plan && (
        <details className="rounded-md border border-white/15 bg-black/30 p-3 text-white/80">
          <summary className="cursor-pointer text-sm font-semibold text-white">Plan</summary>
          <pre className="mt-2 whitespace-pre-wrap wrap-break-word text-xs text-white/70">
            {JSON.stringify(result.plan, null, 2)}
          </pre>
        </details>
      )}

      {!!addressUtxos && (
        <details className="rounded-md border border-white/15 bg-black/30 p-3 text-white/80">
          <summary className="cursor-pointer text-sm font-semibold text-white">Wallet UTxOs</summary>
          <pre className="mt-2 whitespace-pre-wrap wrap-break-word text-xs text-white/70">
            {JSON.stringify(addressUtxos, null, 2)}
          </pre>
        </details>
      )}

      {result?.unsignedTx && (
        <div className="rounded-md border border-white/20 bg-black/40 p-3 text-white/80">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold text-white">Unsigned Tx (CBOR)</span>
            <button
              onClick={() => navigator.clipboard.writeText(result.unsignedTx || "")}
              className="text-xs rounded border border-white/30 px-2 py-1 hover:bg-white/10"
            >
              Copy
            </button>
          </div>
          <p className="mt-2 text-xs break-all text-white/70">{result.unsignedTx}</p>
          <p className="mt-2 text-xs text-white/60">Sign with user + owner keys, then POST to /api/transactions/submit</p>
        </div>
      )}
    </div>
  );
}
