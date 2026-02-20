import { useEffect, useRef, useState } from "react";
import CardanoWalletConnector from "./components/WalletConnector";
import type { WalletConnectorRef } from "./components/WalletConnector";
import { NetworkType } from "@cardano-foundation/cardano-connect-with-wallet-core";
import SldMintPanel from "./components/SldMintPanel";
import type { MintSldPlanFullRequest } from "./api/transactions";
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

export default function App() {
  const walletRef = useRef<WalletConnectorRef>(null);
  const [prefill, setPrefill] = useState<Partial<MintSldPlanFullRequest> | null>(null);
  const prefillKey = prefill ? JSON.stringify(prefill) : "no-prefill";
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
        ownerAddress: prev?.ownerAddress || bech32Address,
      }));
    } catch (error) {
      console.error("Failed to read address from wallet", error);
    }
  };

  useEffect(() => {
    const parseNumber = (value: string | undefined, fallback: number | undefined) => {
      const next = Number(value);
      return Number.isFinite(next) ? next : fallback;
    };

    const fetchDefaults = async (signal: AbortSignal) => {
      const staticDefaults: Partial<MintSldPlanFullRequest> = {
        // Preprod defaults (provided values so we do not depend on fetching) - switch to environment variables later
        tldName: "hello-handshake",
        sldName: "mysld",
        csTld: "694cb48da919e928b3e51c4648f051326ac150eaa9436792ec7a6e35",
        csSld: "96512d4c426d912ba453014e74a57d655dfb3980154c4de106f69320",
        ownerAddress:
          "addr_test1qzxgt625pyaz2mclwtz5ez0yvcanhz3p9lf0qe3knxryyda33aulwhgg303hnn6ygga0u8gr6avcy0qq45t6fvchen9qd2q83d",
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
        minLovelaceSldRef: 1_435_230,
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
        return;
      }

      try {
        setIsLoadingDefaults(true);
        const res = await fetch(remoteUrl, { signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as Partial<MintSldPlanFullRequest>;
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
    };

    const controller = new AbortController();
    fetchDefaults(controller.signal);
    return () => controller.abort();
  }, []);

  return (
    <div className="min-h-screen flex flex-col items-center justify-start bg-linear-to-br from-black to-gray-900">
      <div className="w-full max-w-md px-2 mt-10 ml-auto">
        <CardanoWalletConnector
          ref={walletRef}
          variant="default"
          listLayout="dropdown"
          networkType={NetworkType.TESTNET}
          onConnect={handleConnect}
          onDisconnect={() => {
            setWalletApi(null);
            setPrefill((prev) => {
              if (!prev) return prev;
              const next = { ...prev };
              // Only clear ownerAddress if it was set from the wallet
              // (i.e. it matches userAddress). Preserve default/config value.
              if (next.ownerAddress === next.userAddress) {
                delete next.ownerAddress;
              }
              delete next.userAddress;
              return next;
            });
          }}
        />
      </div>

      {isLoadingDefaults
        ? <p className="text-white/60 text-xs mt-10">Loading defaults…</p>
        : <SldMintPanel key={prefillKey} prefill={prefill ?? undefined} autoBuild walletApi={walletApi ?? undefined} />
      }
    </div>
  );
}
