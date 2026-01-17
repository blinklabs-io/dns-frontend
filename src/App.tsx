import { useEffect, useRef, useState } from "react";
import CardanoWalletConnector from "./components/WalletConnector";
import type { WalletConnectorRef } from "./components/WalletConnector";
import { NetworkType } from "@cardano-foundation/cardano-connect-with-wallet-core";
import SldMintPanel from "./components/SldMintPanel";
import type { MintSldPlanFullRequest } from "./api/transactions";

export default function App() {
  const walletRef = useRef<WalletConnectorRef>(null);
  const [prefill, setPrefill] = useState<Partial<MintSldPlanFullRequest> | null>(null);
  const prefillKey = prefill ? JSON.stringify(prefill) : "no-prefill";
  const [isLoadingDefaults, setIsLoadingDefaults] = useState(false);

  const handleConnect = async (_walletName: string, walletApi: { getChangeAddress: () => Promise<string> }) => {
    try {
      const changeAddress = await walletApi.getChangeAddress();
      setPrefill((prev) => ({
        ...prev,
        userAddress: changeAddress,
        ownerAddress: changeAddress,
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

    const fetchDefaults = async () => {
      const staticDefaults: Partial<MintSldPlanFullRequest> = {
        // Preprod defaults (provided values so we do not depend on fetching) - switch to environment variables later
        tldName: "hello-handshake",
        sldName: "mysld",
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
        minLovelaceSldRef: 1_435_230,
      };

      const envDefaults: Partial<MintSldPlanFullRequest> = {
        ...staticDefaults,
        tldName: import.meta.env.VITE_DEFAULT_TLD_NAME ?? staticDefaults.tldName,
        sldName: import.meta.env.VITE_DEFAULT_SLD_NAME,
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
        const res = await fetch(remoteUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as Partial<MintSldPlanFullRequest>;
        setPrefill((prev) => ({
          ...staticDefaults,
          ...envDefaults,
          ...json,
          ...prev,
        }));
      } catch (error) {
        console.warn("Failed to load remote SLD defaults; falling back to env defaults", error);
        setPrefill((prev) => ({ ...staticDefaults, ...envDefaults, ...prev }));
      } finally {
        setIsLoadingDefaults(false);
      }
    };

    fetchDefaults();
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
        />
      </div>

      <SldMintPanel key={prefillKey} prefill={prefill ?? undefined} autoBuild />
      {isLoadingDefaults && <p className="text-white/60 text-xs mt-2">Loading defaults…</p>}
    </div>
  );
}
