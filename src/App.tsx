import { useEffect, useRef, useState } from "react";
import CardanoWalletConnector from "./components/WalletConnector";
import type { WalletConnectorRef } from "./components/WalletConnector";
import { NetworkType } from "@cardano-foundation/cardano-connect-with-wallet-core";
import SldMintPanel from "./components/SldMintPanel";
import type { MintSldPlanFullRequest } from "./api/transactions";
import { lookupTldOwner } from "./api/transactions";
import { bech32 } from "bech32";

/**
 * Convert a hex-encoded address (from CIP-30 wallet API) to bech32 format.
 * The first nibble of the address determines the network (0=testnet, 1=mainnet).
 * @throws Error if hexAddress is invalid (empty, odd length, non-hex characters, or invalid bytes)
 */
function hexToBech32Address(hexAddress: string): string {
  // Strip optional 0x/0X prefix
  let normalized = hexAddress;
  if (normalized.startsWith("0x") || normalized.startsWith("0X")) {
    normalized = normalized.slice(2);
  }

  // Validate: non-empty, even length, and only hex characters
  if (normalized.length === 0) {
    throw new Error("Invalid hex address: empty string");
  }
  if (normalized.length % 2 !== 0) {
    throw new Error("Invalid hex address: odd number of characters");
  }
  if (!/^[0-9a-fA-F]+$/.test(normalized)) {
    throw new Error("Invalid hex address: contains non-hex characters");
  }

  const match = normalized.match(/.{1,2}/g);
  if (!match) {
    throw new Error("Invalid hex address: failed to parse bytes");
  }

  const bytes = new Uint8Array(
    match.map((byte) => {
      const value = parseInt(byte, 16);
      if (Number.isNaN(value)) {
        throw new Error(`Invalid hex address: invalid byte "${byte}"`);
      }
      return value;
    })
  );

  // First nibble: address type, second nibble: network ID (0=testnet, 1=mainnet)
  const networkId = bytes[0] & 0x0f;
  const prefix = networkId === 0 ? "addr_test" : "addr";
  const words = bech32.toWords(bytes);
  return bech32.encode(prefix, words, 1000);
}

type WalletApi = {
  getChangeAddress: () => Promise<string>;
  getUsedAddresses?: () => Promise<string[]>;
  signTx: (tx: string, partialSign?: boolean) => Promise<string>;
};

const NETWORK = (import.meta.env.VITE_NETWORK ?? "preprod") as string;
const NETWORK_LABEL = (import.meta.env.VITE_NETWORK_LABEL ?? "Pre-Production Testnet") as string;
const IS_TESTNET = NETWORK !== "mainnet";

function NetworkBadge() {
  return (
    <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium font-ibm-plex border ${IS_TESTNET ? "bg-amber-500/15 text-amber-400 border-amber-500/20" : "bg-emerald-500/15 text-emerald-400 border-emerald-500/20"}`}>
      {NETWORK_LABEL}
    </span>
  );
}

export default function App() {
  const walletRef = useRef<WalletConnectorRef>(null);
  const [prefill, setPrefill] = useState<Partial<MintSldPlanFullRequest> | null>(null);
  // Exclude ownerAddress from the key so the async on-chain lookup doesn't
  // remount SldMintPanel and discard user input (e.g. sldName).
  const prefillKey = prefill
    ? JSON.stringify({ ...prefill, ownerAddress: undefined })
    : "no-prefill";
  const [isLoadingDefaults, setIsLoadingDefaults] = useState(false);
  const [walletApi, setWalletApi] = useState<WalletApi | null>(null);

  const handleConnect = async (_connectedWalletName: string, nextWalletApi: WalletApi) => {
    try {
      if (!nextWalletApi.signTx) {
        console.error("Connected wallet does not support signTx");
        return;
      }
      const usedAddresses = nextWalletApi.getUsedAddresses ? await nextWalletApi.getUsedAddresses() : [];
      const fallbackAddress = await nextWalletApi.getChangeAddress();
      const hexAddress = usedAddresses?.[0] || fallbackAddress;
      // Convert hex CBOR address from CIP-30 to bech32 format
      const bech32Address = hexToBech32Address(hexAddress);
      setWalletApi(nextWalletApi);
      setPrefill((prev) => ({
        ...prev,
        userAddress: bech32Address,
      }));
    } catch (error) {
      console.error("Failed to read address from wallet", error);
    }
  };

  const handleDisconnect = () => {
    setWalletApi(null);
    setShowWalletPicker(false);
    setPrefill((prev) => {
      if (!prev) return prev;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure to remove userAddress
      const { userAddress: _removed, ...rest } = prev;
      return rest;
    });
  };

  // Load static/env/remote defaults on mount (no chain queries)
  useEffect(() => {
    const parseNumber = (value: string | undefined, fallback: number | undefined) => {
      const next = Number(value);
      return Number.isFinite(next) ? next : fallback;
    };

    const fetchDefaults = async (signal: AbortSignal) => {
      const staticDefaults: Partial<MintSldPlanFullRequest> = {
        tldName: "hello-handshake",
        sldName: "",
        csTld: "694cb48da919e928b3e51c4648f051326ac150eaa9436792ec7a6e35",
        csSld: "96512d4c426d912ba453014e74a57d655dfb3980154c4de106f69320",
        tldRefAddress: "addr_test1zp55edyd4yv7j29nu5wyvj8s2yex4s2sa255xeuja3axudvxu36kavd5fjg7km4qk6umypqlvq9sa6ghyzhl9k8glg8q6prskn",
        sldRefAddress: "addr_test1zzt9zt2vgfkez2ay2vq5ua9904j4m7eesq25cn0pqmmfxgyxu36kavd5fjg7km4qk6umypqlvq9sa6ghyzhl9k8glg8qc9ljcz",
        tldReferenceRef: {
          txHash: "ef635b55fce6abc39cd4c843722d9d574cb719114e224f2cd1c8747d5abfc19e",
          txIndex: 1,
        },
        sldReferenceRef: {
          txHash: "ef635b55fce6abc39cd4c843722d9d574cb719114e224f2cd1c8747d5abfc19e",
          txIndex: 2,
        },
        minLovelaceTldRef: 2_000_000,
        minLovelaceOwner: 1_262_830,
        minLovelaceSldRef: 2_000_000,
      };

      const envDefaults: Partial<MintSldPlanFullRequest> = {
        ...staticDefaults,
        tldName: import.meta.env.VITE_DEFAULT_TLD_NAME ?? staticDefaults.tldName,
        sldName: import.meta.env.VITE_DEFAULT_SLD_NAME ?? staticDefaults.sldName,
        csTld: import.meta.env.VITE_DEFAULT_CS_TLD ?? staticDefaults.csTld,
        csSld: import.meta.env.VITE_DEFAULT_CS_SLD ?? staticDefaults.csSld,
        tldRefAddress: import.meta.env.VITE_DEFAULT_TLD_REF_ADDRESS ?? staticDefaults.tldRefAddress,
        sldRefAddress: import.meta.env.VITE_DEFAULT_SLD_REF_ADDRESS ?? staticDefaults.sldRefAddress,
        minLovelaceTldRef: parseNumber(import.meta.env.VITE_DEFAULT_MIN_TLD_REF, staticDefaults.minLovelaceTldRef),
        minLovelaceOwner: parseNumber(import.meta.env.VITE_DEFAULT_MIN_OWNER, staticDefaults.minLovelaceOwner),
        minLovelaceSldRef: parseNumber(import.meta.env.VITE_DEFAULT_MIN_SLD_REF, staticDefaults.minLovelaceSldRef),
      };

      const remoteUrl = import.meta.env.VITE_SLD_DEFAULTS_URL as string | undefined;

      if (!remoteUrl) {
        setPrefill((prev) => ({ ...staticDefaults, ...envDefaults, ...prev }));
      } else {
        try {
          setIsLoadingDefaults(true);
          const res = await fetch(remoteUrl, { signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          // eslint-disable-next-line @typescript-eslint/no-unused-vars -- strip ownerAddress; it only comes from on-chain lookup
          const { ownerAddress: _stripped, ...json } = (await res.json()) as Partial<MintSldPlanFullRequest>;
          if (signal.aborted) return;
          setPrefill((prev) => ({
            ...staticDefaults,
            ...envDefaults,
            ...json,
            ...prev,
          }));
        } catch (error) {
          if (signal.aborted) return;
          console.warn("Failed to load remote SLD defaults; falling back to env defaults", error);
          setPrefill((prev) => ({ ...staticDefaults, ...envDefaults, ...prev }));
        } finally {
          if (!signal.aborted) setIsLoadingDefaults(false);
        }
      }
    };

    const controller = new AbortController();
    fetchDefaults(controller.signal);
    return () => controller.abort();
  }, []);

  // Look up TLD owner on-chain when wallet connects (deferred from mount so the
  // server has time to be ready and we only hit the chain when actually needed)
  useEffect(() => {
    if (!walletApi) return;
    const csTld = prefill?.csTld;
    const tldName = prefill?.tldName;
    if (!csTld || !tldName) return;
    // Skip if we already have an owner address
    if (prefill?.ownerAddress) return;

    const controller = new AbortController();
    lookupTldOwner(csTld, tldName)
      .then(({ ownerAddress }) => {
        if (controller.signal.aborted) return;
        setPrefill((prev) => ({ ...prev, ownerAddress }));
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        console.warn("Failed to look up TLD owner on-chain:", error);
      });
    return () => controller.abort();
  }, [walletApi, prefill?.csTld, prefill?.tldName, prefill?.ownerAddress]);

  const isConnected = !!walletApi;
  const [showWalletPicker, setShowWalletPicker] = useState(false);

  const knownWallets = ["eternl", "yoroi", "gerowallet", "begin", "nufi", "lace", "vespr"];
  const detectedWallets = knownWallets.filter((w) => window.cardano?.[w]);

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center relative px-4"
      style={{
        backgroundColor: "#040617",
        backgroundImage: "linear-gradient(180deg, rgba(28, 36, 110, 0.45) 0%, rgba(4, 6, 23, 0.65) 35%)",
      }}
    >
      {!isConnected && !showWalletPicker ? (
        /* ---- Landing page ---- */
        <div className="w-full max-w-md rounded-2xl bg-white/[0.04] border border-white/10 backdrop-blur-sm px-8 py-10 space-y-6 text-center">
          <h1 className="text-white text-2xl font-bold tracking-tight">Decentralized Domains</h1>
          <p className="text-white/50 text-sm font-ibm-plex">
            Register decentralized domains powered by Cardano and Handshake blockchains.
          </p>
          <p><NetworkBadge /></p>
          <button
            onClick={() => setShowWalletPicker(true)}
            className="w-full h-12 rounded-xl bg-white text-black text-sm font-bold font-ibm-plex hover:bg-gray-100 transition-colors cursor-pointer"
          >
            Connect Wallet
          </button>
          {detectedWallets.length > 0 && (
            <p className="text-white/30 text-xs font-ibm-plex">
              Detected: {detectedWallets.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(", ")}
            </p>
          )}
        </div>
      ) : !isConnected && detectedWallets.length === 1 ? (
        /* ---- Single wallet — auto-connect ---- */
        <div className="w-full max-w-md rounded-2xl bg-white/[0.04] border border-white/10 backdrop-blur-sm px-8 py-10 space-y-6 text-center">
          <h1 className="text-white text-2xl font-bold tracking-tight">Decentralized Domains</h1>
          <p className="text-white/50 text-sm font-ibm-plex animate-pulse">
            Connecting to {detectedWallets[0].charAt(0).toUpperCase() + detectedWallets[0].slice(1)}...
          </p>
          {/* Hidden connector handles the actual connection */}
          <div className="hidden">
            <CardanoWalletConnector
              ref={walletRef}
              variant="white"
              listLayout="flex"
              networkType={NetworkType.TESTNET}
              onConnect={handleConnect}
              onDisconnect={handleDisconnect}
              autoConnectWallet={detectedWallets[0]}
            />
          </div>
        </div>
      ) : !isConnected ? (
        /* ---- Wallet picker ---- */
        <div className="w-full max-w-md rounded-2xl bg-white/[0.04] border border-white/10 backdrop-blur-sm px-8 py-10 space-y-6">
          <div className="text-center space-y-2">
            <h1 className="text-white text-2xl font-bold tracking-tight">Decentralized Domains</h1>
            <p className="text-white/50 text-sm font-ibm-plex">
              {detectedWallets.length > 0
                ? `${detectedWallets.length} wallets detected. Select one to continue.`
                : "No wallets detected. Install a Cardano wallet extension to continue."}
            </p>
            <p className="pt-1"><NetworkBadge /></p>
          </div>
          <CardanoWalletConnector
            ref={walletRef}
            variant="white"
            listLayout="flex"
            initiallyOpen
            networkType={NetworkType.TESTNET}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
          />
        </div>
      ) : (
        /* ---- Register domain view ---- */
        <div className="w-full max-w-xl space-y-3">
          <div className="flex justify-end">
            <button
              onClick={handleDisconnect}
              className="flex py-2 px-6 justify-center items-center gap-2.5 rounded-xl border border-white/15 text-white font-ibm-plex font-bold text-sm cursor-pointer hover:bg-white/5 hover:border-white/25 transition-all"
            >
              Disconnect
            </button>
          </div>

          {isLoadingDefaults
            ? <p className="text-white/60 text-xs text-center">Loading defaults…</p>
            : <SldMintPanel key={prefillKey} prefill={prefill ?? undefined} walletApi={walletApi ?? undefined} />
          }
        </div>
      )}
    </div>
  );
}
