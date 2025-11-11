import { ConnectWalletList } from "@cardano-foundation/cardano-connect-with-wallet";
import { NetworkType } from "@cardano-foundation/cardano-connect-with-wallet-core";
import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from "react";

interface CardanoWalletApi {
  getNetworkId: () => Promise<number>;
  getRewardAddresses: () => Promise<string[]>;
  getChangeAddress: () => Promise<string>;
  getUsedAddresses: () => Promise<string[]>;
  getUnusedAddresses: () => Promise<string[]>;
  getUtxos: () => Promise<string[] | null>;
  getBalance: () => Promise<string>;
  signTx: (tx: string, partialSign?: boolean) => Promise<string>;
  signData: (address: string, payload: string) => Promise<{ signature: string; key: string }>;
  submitTx: (tx: string) => Promise<string>;
}

interface CardanoWalletConnectorProps {
  variant?: "default" | "white";
  showTitle?: boolean;
  showDescription?: boolean;
  listLayout?: "dropdown" | "flex";
  initiallyOpen?: boolean;
  networkType?: NetworkType;
  supportedWallets?: string[];
  onConnect?: (walletName: string, walletApi: CardanoWalletApi, stakeAddress: string | null) => void;
  onDisconnect?: () => void;
  showError?: (message: string) => void;
  navigateOnConnect?: (path: string) => void;
}

interface WalletState {
  isConnected: boolean;
  walletName: string | null;
  walletApi: CardanoWalletApi | null;
  stakeAddress: string | null;
}

export interface WalletConnectorRef {
  disconnect: () => void;
  getWalletState: () => WalletState;
  isConnected: () => boolean;
}

const DEFAULT_SUPPORTED_WALLETS = [
  "eternl",
  "yoroi",
  "gerowallet",
  "begin",
  "nufi",
  "lace",
  "vespr",
];

const DROPDOWN_WALLET_LIST_CSS = `
  font-family: Helvetica Light, sans-serif;
  font-size: 0.875rem;
  font-weight: 700;
  width: 100%;
  & > span {
    padding: 10px 12px;
    color: #ffffff;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 6px;
    margin-bottom: 10px;
    display: flex;
    align-items: center;
    justify-content: start;
    gap: 8px;
    background: transparent;
    backdrop-filter: blur(10px);
    transition: all 0.2s ease;
    cursor: pointer;
    opacity: 0;
    transform: translateY(-10px);
    animation: cascadeIn 0.4s ease-out forwards;
  }
  & > span:nth-child(1) { animation-delay: 0.02s; }
  & > span:nth-child(2) { animation-delay: 0.08s; }
  & > span:nth-child(3) { animation-delay: 0.12s; }
  & > span:nth-child(4) { animation-delay: 0.17s; }
  & > span:nth-child(5) { animation-delay: 0.22s; }
  & > span:nth-child(6) { animation-delay: 0.27s; }
  & > span:hover {
    background: rgba(255, 255, 255, 0.1);
    border-color: rgba(255, 255, 255, 0.3);
    transform: translateY(-2px);
  }
  @keyframes cascadeIn {
    from {
      opacity: 0;
      transform: translateY(-10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
`;

const FLEX_WALLET_LIST_CSS = `
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
  width: 100%;
  max-width: 540px;
  font-family: Helvetica Light, sans-serif;
  font-size: 0.8rem;
  font-weight: 700;
  justify-items: stretch;
  align-content: start;
  & > span {
    width: 100%;
    padding: 8px 12px;
    color: #ffffff;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: start;
    gap: 10px;
    background: transparent;
    backdrop-filter: blur(10px);
    transition: all 0.2s ease;
    cursor: pointer;
    margin: 0;
    opacity: 0;
    transform: translateY(-10px);
    animation: cascadeIn 0.4s ease-out forwards;
  }
  & > span:nth-child(1) { animation-delay: 0.05s; }
  & > span:nth-child(2) { animation-delay: 0.1s; }
  & > span:nth-child(3) { animation-delay: 0.15s; }
  & > span:nth-child(4) { animation-delay: 0.2s; }
  & > span:nth-child(5) { animation-delay: 0.25s; }
  & > span:nth-child(6) { animation-delay: 0.3s; }
  & > span:nth-child(7) { animation-delay: 0.35s; }
  & > span:hover {
    background: rgba(255, 255, 255, 0.1);
    border-color: rgba(255, 255, 255, 0.3);
  }
  @keyframes cascadeIn {
    from {
      opacity: 0;
      transform: translateY(-10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  @media (max-width: 1024px) {
    max-width: 480px;
  }
  @media (max-width: 640px) {
    max-width: none;
  }
`;

const CardanoWalletConnector = forwardRef<WalletConnectorRef, CardanoWalletConnectorProps>(({
  variant = "default",
  showTitle = false,
  showDescription = false,
  listLayout = "dropdown",
  initiallyOpen = false,
  networkType = NetworkType.TESTNET,
  supportedWallets = DEFAULT_SUPPORTED_WALLETS,
  onConnect,
  onDisconnect,
  showError = (msg) => console.error(msg),
  navigateOnConnect,
}, ref) => {
  const [walletState, setWalletState] = useState<WalletState>({
    isConnected: false,
    walletName: null,
    walletApi: null,
    stakeAddress: null,
  });
  const [showWalletList, setShowWalletList] = useState(initiallyOpen);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [pendingWallet, setPendingWallet] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const lastErrorRef = useRef<{ message: string; timestamp: number } | null>(null);
  const isDropdownLayout = listLayout === "dropdown";
  const flexContainerBaseClasses =
    "relative mx-auto flex w-full max-w-[600px] flex-col min-h-[150px]";

  useImperativeHandle(ref, () => ({
    disconnect: handleDisconnect,
    getWalletState: () => walletState,
    isConnected: () => walletState.isConnected,
  }));

  const showErrorOnce = (message: string) => {
    const now = Date.now();
    const lastError = lastErrorRef.current;
    
    if (!lastError || lastError.message !== message || now - lastError.timestamp > 1000) {
      showError(message);
      lastErrorRef.current = { message, timestamp: now };
    }
  };

  const openWalletList = () => {
    setConnectionError(null);
    setPendingWallet(null);

    if (isDropdownLayout) {
      setShowWalletList((prev) => !prev);
    } else {
      setShowWalletList(true);
    }
  };

  const closeWalletList = () => {
    if (isConnecting) {
      return;
    }

    setShowWalletList(false);
    setConnectionError(null);
    setPendingWallet(null);
  };

  const handleSuccessfulConnect = (walletName: string, walletApi: CardanoWalletApi, stakeAddress: string | null) => {
    setConnectionError(null);
    setShowWalletList(false);
    setWalletState({
      isConnected: true,
      walletName,
      walletApi,
      stakeAddress,
    });

    if (onConnect) {
      onConnect(walletName, walletApi, stakeAddress);
    } else if (navigateOnConnect) {
      navigateOnConnect("/account");
    }
  };

  const handleDisconnect = () => {
    setWalletState({
      isConnected: false,
      walletName: null,
      walletApi: null,
      stakeAddress: null,
    });

    if (onDisconnect) {
      onDisconnect();
    }
  };

  const onConnectWallet = async (walletName: string) => {
    setIsConnecting(true);
    setConnectionError(null);
    setPendingWallet(walletName);

    try {
      if (!window.cardano || !window.cardano[walletName]) {
        showErrorOnce(`${walletName} wallet is not installed. Please install it from the official website.`);
        setIsConnecting(false);
        setPendingWallet(null);
        return;
      }

      const walletApi = await window.cardano[walletName].enable();

      const walletNetworkId = await walletApi.getNetworkId();
      const expectedNetworkId = networkType === NetworkType.MAINNET ? 1 : 0;

      if (walletNetworkId !== expectedNetworkId) {
        const expectedNetwork = networkType === NetworkType.MAINNET ? "Mainnet" : "Testnet";
        showErrorOnce(`Network mismatch: This app requires ${expectedNetwork}. Please switch your wallet network.`);
        setIsConnecting(false);
        setPendingWallet(null);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
      let stakeAddresses: string[] = [];
      let retries = 3;

      while (retries > 0) {
        try {
          stakeAddresses = await walletApi.getRewardAddresses();
          break;
        } catch (error: unknown) {
          retries--;

          if (
            error instanceof Error &&
            (error.message.includes("account changed") ||
              error.message.includes("Account changed"))
          ) {
            if (retries > 0) {
              await new Promise((resolve) => setTimeout(resolve, 500));
              continue;
            } else {
              const newWalletApi = await window.cardano[walletName].enable();
              await new Promise((resolve) => setTimeout(resolve, 200));
              stakeAddresses = await newWalletApi.getRewardAddresses();
              break;
            }
          } else {
            throw error;
          }
        }
      }

      const stakeAddress = stakeAddresses?.[0] || null;

      handleSuccessfulConnect(walletName, walletApi, stakeAddress);
    } catch (error) {
      console.error(`Error connecting to ${walletName}:`, error);
      setConnectionError(
        `Error connecting to ${walletName}: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    } finally {
      setIsConnecting(false);
      setPendingWallet(null);
    }
  };

  const onConnectError = (walletName: string, error: Error) => {
    console.error(`ConnectWalletList error for ${walletName}:`, error);
    
    const errorMessage = error.message.toLowerCase();
    if (
      errorMessage.includes("not installed") ||
      errorMessage.includes("not found") ||
      errorMessage.includes("not available") ||
      errorMessage.includes("no wallet")
    ) {
      showErrorOnce(`${walletName} wallet is not installed. Please install it from the official website.`);
    } else if (
      errorMessage.includes("wrong network") ||
      errorMessage.includes("network type") ||
      errorMessage.includes("mainnet") ||
      errorMessage.includes("testnet")
    ) {
      const expectedNetwork = networkType === NetworkType.MAINNET ? "Mainnet" : "Testnet";
      const message = `Network mismatch: This app requires ${expectedNetwork}. Please switch your wallet to ${expectedNetwork} and try again.`;
      showErrorOnce(message);
      setConnectionError(message);
    } else {
      showErrorOnce(`Error connecting to ${walletName}: ${error.message}`);
      setConnectionError(`Error with ${walletName}: ${error.message}`);
    }
    
    setIsConnecting(false);
    setPendingWallet(null);
  };

  useEffect(() => {
    if (!isDropdownLayout) {
      return;
    }

    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setShowWalletList(false);
        setConnectionError(null);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isDropdownLayout]);


  const renderConnectionFeedback = (
    errorClasses = "mb-3 rounded-md border border-red-400 bg-red-500/10 px-4 py-2 text-sm text-red-200",
    statusClasses = "mb-2 text-sm text-white/80",
  ) => (
    <>
      {connectionError && (
        <div className={errorClasses}>{connectionError}</div>
      )}
      {isConnecting && pendingWallet && (
        <p className={`${statusClasses} animate-pulse`}>Connecting to {pendingWallet}...</p>
      )}
    </>
  );

  const renderWalletList = () => (
    <ConnectWalletList
      borderRadius={15}
      gap={12}
      primaryColor="#000000"
      onConnect={onConnectWallet}
      onConnectError={onConnectError}
      supportedWallets={supportedWallets}
      showUnavailableWallets={0}
      peerConnectEnabled={false}
      limitNetwork={networkType}
      customCSS={isDropdownLayout ? DROPDOWN_WALLET_LIST_CSS : FLEX_WALLET_LIST_CSS}
    />
  );

  if (walletState.isConnected) {
    return (
      <div className="flex items-center space-x-4">
        <button
          onClick={handleDisconnect}
          className="flex py-2.5 px-6 justify-center items-center gap-2.5 self-stretch rounded-md border border-white/20 backdrop-blur-sm text-white font-medium cursor-pointer"
        >
          Disconnect
        </button>
      </div>
    );
  }

  const buttonClasses =
    variant === "white"
      ? "flex py-3 px-8 justify-center items-center gap-2.5 rounded-md bg-white text-black font-medium cursor-pointer text-lg md:text-base hover:bg-gray-100 transition-all"
      : "flex py-2.5 px-10 justify-center items-center gap-2.5 self-stretch rounded-md border border-white/20 backdrop-blur-sm text-white font-medium z-40 cursor-pointer hover:bg-white/10 hover:border-white/30 transition-all";

  if (showTitle || showDescription) {
    return (
      <div className="flex flex-col items-center justify-center w-full max-w-4xl mx-auto">
        <div className="border-2 border-white rounded-3xl p-8 md:p-12 w-full">
          <div className="flex items-start gap-4 mb-6">
            <div className="flex-1">
              {showTitle && (
                <h1 className="text-white text-2xl md:text-3xl font-bold mb-4">
                  Connect Your Wallet to Begin
                </h1>
              )}
            </div>
          </div>

          {showDescription && (
            <p className="text-white text-base md:text-lg font-light leading-relaxed mb-8">
              Connect your Cardano wallet to get started.
            </p>
          )}

          <div className="relative" ref={dropdownRef}>
            {isDropdownLayout ? (
              <>
                <button
                  onClick={openWalletList}
                  className={`bg-white text-black font-medium py-3 px-8 rounded-lg text-lg cursor-pointer hover:bg-gray-100 transition-all ${isConnecting ? 'animate-pulse' : ''}`}
                  disabled={isConnecting}
                >
                  {isConnecting ? "Connecting..." : "Connect"}
                </button>

                {showWalletList && (
                  <div className="absolute top-full left-0 mt-2 backdrop-blur-sm p-4 z-50 min-w-[200px]">
                    {renderConnectionFeedback(
                      "mb-3 rounded-md border border-red-400 bg-red-500/10 px-4 py-2 text-sm text-red-200",
                      "mb-2 text-sm text-white/80",
                    )}
                    {renderWalletList()}
                  </div>
                )}
              </>
            ) : !showWalletList ? (
              <div className={`${flexContainerBaseClasses} items-start`}>
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 bg-white/10 rounded-full flex items-center justify-center">
                    ₳
                  </div>
                  <div className="flex flex-col">
                    <h3 className="text-white text-lg font-medium">
                      Connect Wallet
                    </h3>
                    <p className="text-white/70 text-sm md:text-base">
                      Connect your Cardano wallet
                    </p>
                  </div>
                </div>
                <button
                  onClick={openWalletList}
                  className={`bg-white text-black font-medium py-3 px-8 rounded-lg text-lg cursor-pointer hover:bg-gray-100 transition-all ${isConnecting ? 'animate-pulse' : ''}`}
                  disabled={isConnecting}
                >
                  {isConnecting ? "Connecting..." : "Connect"}
                </button>
              </div>
            ) : (
              <div className={`${flexContainerBaseClasses} items-center justify-start`}>
                {renderConnectionFeedback(
                  "rounded-md border border-red-400 bg-red-500/10 px-4 py-2 text-sm text-red-200 max-w-[540px] w-full",
                  "text-sm text-white/80",
                )}
                {renderWalletList()}
                <button
                  type="button"
                  onClick={closeWalletList}
                  disabled={isConnecting}
                  className="absolute bottom-0 right-0 text-sm text-white/70 transition-colors hover:text-white disabled:cursor-not-allowed disabled:text-white/40 mt-auto cursor-pointer px-4 py-3 z-50 hover:bg-white/5 rounded"
                >
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (isDropdownLayout) {
    return (
      <div className="relative" ref={dropdownRef}>
        <button
          onClick={openWalletList}
          className={`${buttonClasses} ${isConnecting ? 'animate-pulse' : ''}`}
          disabled={isConnecting}
        >
          {isConnecting ? "Connecting..." : "Connect Wallet"}
        </button>

        {showWalletList && (
          <div className="absolute top-full left-0 right-0 pt-3 z-50 animate-in slide-in-from-top-2 duration-300">
            {renderWalletList()}
          </div>
        )}
      </div>
    );
  }

  return showWalletList ? (
    <div
      className={`${flexContainerBaseClasses} items-center justify-start gap-3`}
      ref={dropdownRef}
    >
      {renderWalletList()}
      <button
        type="button"
        onClick={closeWalletList}
        disabled={isConnecting}
        className="absolute bottom-0 right-0 text-sm text-white/70 transition-colors hover:text-white disabled:cursor-not-allowed disabled:text-white/40 cursor-pointer px-4 py-3 z-50 hover:bg-white/5 rounded"
      >
        Close
      </button>
    </div>
  ) : (
    <div
      className={`${flexContainerBaseClasses} items-start justify-between`}
      ref={dropdownRef}
    >
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 bg-white/10 rounded-full flex items-center justify-center text-white text-xl">
          ₳
        </div>
        <div className="flex flex-col">
          <h3 className="text-white text-lg font-medium">Connect Wallet</h3>
          <p className="text-white/70 text-sm md:text-base">
            Connect your Cardano wallet
          </p>
        </div>
      </div>
      <button
        onClick={openWalletList}
        className={`${buttonClasses} ${isConnecting ? 'animate-pulse' : ''}`}
        disabled={isConnecting}
      >
        {isConnecting ? "Connecting..." : "Connect Wallet"}
      </button>
    </div>
  );
});

CardanoWalletConnector.displayName = 'CardanoWalletConnector';

declare global {
  interface Window {
    cardano?: {
      [key: string]: {
        enable: () => Promise<CardanoWalletApi>;
        isEnabled: () => Promise<boolean>;
        name: string;
        icon: string;
        apiVersion: string;
      };
    };
  }
}

export default CardanoWalletConnector;

