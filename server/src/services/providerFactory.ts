/* global process */

import type { IFetcher, UTxO, AccountInfo, TransactionInfo, AssetMetadata, BlockInfo, Asset, Protocol, GovernanceProposalInfo } from "@meshsdk/common";
import { normalizeAssetId } from "../utils/cardano.js";

/**
 * Provider Factory for Cardano blockchain access.
 *
 * Supported providers (set via MESH_PROVIDER or PROVIDER env var):
 * - "blockfrost" (default): Requires BLOCKFROST_PROJECT_ID env var
 * - "kupo": Requires KUPO_URL env var
 * - "ogmios": Requires OGMIOS_URL env var
 *
 * Limitations:
 * - Provider is lazily initialized on first use
 * - Provider instance is cached (singleton per adapter instance)
 * - Only fetchAddressUTxOs and submitTx are fully implemented; other IFetcher methods throw
 */

type MeshProvider = {
  getUnspentOutputs?: (address: unknown) => Promise<unknown[]>;
  fetchAddressUTxOs?: (address: unknown, asset?: string) => Promise<unknown[]>;
  fetchUTxOs?: (hash: string, index?: number) => Promise<unknown[]>;
  submitTx?: (tx: unknown) => Promise<unknown>;
  fetchProtocolParameters?: (epoch?: number) => Promise<unknown>;
  fetchAssetAddresses?: (asset: string) => Promise<{ address: string; quantity: string }[]>;
  fetchBlockInfo?: (hash: string) => Promise<unknown>;
  fetchLatestBlock?: () => Promise<unknown>;
};

/**
 * Adapter that wraps Mesh SDK providers with a consistent interface.
 * Implements IFetcher for compatibility with MeshTxBuilder.
 * Handles lazy initialization and method name differences between providers.
 */
export class MeshProviderAdapter implements IFetcher {
  private providerPromise: Promise<MeshProvider> | null = null;
  private factory: () => Promise<MeshProvider>;

  constructor(factory: () => Promise<MeshProvider>) {
    this.factory = factory;
  }

  private async ensureProvider(): Promise<MeshProvider> {
    if (!this.providerPromise) {
      this.providerPromise = this.factory().catch((err) => {
        this.providerPromise = null;
        throw err;
      });
    }
    return this.providerPromise;
  }

  /**
   * Fetches unspent transaction outputs for an address.
   * This is the primary method used by MeshTxBuilder for coin selection.
   */
  async fetchAddressUTxOs(address: string, asset?: string): Promise<UTxO[]> {
    const provider = await this.ensureProvider();
    let result: unknown[];
    if (typeof provider.fetchAddressUTxOs === "function") {
      result = await provider.fetchAddressUTxOs(address, asset);
    } else if (typeof provider.getUnspentOutputs === "function") {
      result = await provider.getUnspentOutputs(address);
      // getUnspentOutputs does not support asset filtering — apply it client-side.
      // Normalize dot separators for consistent format matching across providers.
      if (asset && result) {
        const normalizedAsset = normalizeAssetId(asset);
        result = (result as UTxO[]).filter((utxo) =>
          utxo.output.amount.some((a) => normalizeAssetId(a.unit) === normalizedAsset)
        );
      }
    } else {
      throw new Error("Provider does not support fetchAddressUTxOs");
    }
    return (result ?? []) as UTxO[];
  }

  /**
   * Alias for fetchAddressUTxOs for backward compatibility.
   */
  async getUnspentOutputs(address: string): Promise<UTxO[]> {
    return this.fetchAddressUTxOs(address);
  }

  /**
   * Submits a signed transaction to the blockchain.
   * @param tx - CBOR-encoded signed transaction (hex string)
   * @returns Transaction hash on success
   */
  async submitTx(tx: string): Promise<string> {
    const provider = await this.ensureProvider();
    if (typeof provider.submitTx === "function") {
      return provider.submitTx(tx) as Promise<string>;
    }
    throw new Error("Provider does not support submitTx");
  }

  /**
   * Alias for submitTx for backward compatibility.
   */
  async postTransactionToChain(tx: string): Promise<string> {
    return this.submitTx(tx);
  }

  // The following IFetcher methods are not implemented but required by the interface.
  // MeshTxBuilder primarily uses fetchAddressUTxOs; these are stubs for type compliance.
  /* eslint-disable @typescript-eslint/no-unused-vars */

  async fetchAccountInfo(address: string): Promise<AccountInfo> {
    throw new Error("fetchAccountInfo not implemented");
  }

  async fetchAddressTxs(address: string): Promise<TransactionInfo[]> {
    throw new Error("fetchAddressTxs not implemented");
  }

  async fetchAssetAddresses(asset: string): Promise<{ address: string; quantity: string }[]> {
    const provider = await this.ensureProvider();
    if (typeof provider.fetchAssetAddresses === "function") {
      return provider.fetchAssetAddresses(asset);
    }
    throw new Error("Provider does not support fetchAssetAddresses");
  }

  async fetchAssetMetadata(asset: string): Promise<AssetMetadata> {
    throw new Error("fetchAssetMetadata not implemented");
  }

  async fetchBlockInfo(hash: string): Promise<BlockInfo> {
    const provider = await this.ensureProvider();
    if (typeof provider.fetchBlockInfo === "function") {
      return provider.fetchBlockInfo(hash) as Promise<BlockInfo>;
    }
    throw new Error("Provider does not support fetchBlockInfo");
  }

  async fetchLatestBlock(): Promise<BlockInfo> {
    const provider = await this.ensureProvider();
    if (typeof provider.fetchLatestBlock === "function") {
      return provider.fetchLatestBlock() as Promise<BlockInfo>;
    }
    throw new Error("Provider does not support fetchLatestBlock");
  }

  async fetchCollectionAssets(policyId: string, cursor?: number | string): Promise<{ assets: Asset[]; next?: string | number | null }> {
    throw new Error("fetchCollectionAssets not implemented");
  }

  async fetchProtocolParameters(epoch: number): Promise<Protocol> {
    const provider = await this.ensureProvider();
    if (typeof provider.fetchProtocolParameters === "function") {
      return provider.fetchProtocolParameters(epoch) as Promise<Protocol>;
    }
    throw new Error("Provider does not support fetchProtocolParameters");
  }

  async fetchTxInfo(hash: string): Promise<TransactionInfo> {
    throw new Error("fetchTxInfo not implemented");
  }

  /* eslint-enable @typescript-eslint/no-unused-vars */

  async fetchUTxOs(hash: string, index?: number): Promise<UTxO[]> {
    const provider = await this.ensureProvider();
    if (typeof provider.fetchUTxOs === "function") {
      const result = await provider.fetchUTxOs(hash, index);
      return (result ?? []) as UTxO[];
    }
    throw new Error("Provider does not support fetchUTxOs");
  }

  /* eslint-disable @typescript-eslint/no-unused-vars */

  async fetchGovernanceProposal(txHash: string, certIndex: number): Promise<GovernanceProposalInfo> {
    throw new Error("fetchGovernanceProposal not implemented");
  }

  async get(url: string): Promise<unknown> {
    throw new Error("get not implemented");
  }

  /* eslint-enable @typescript-eslint/no-unused-vars */
}

let cachedProvider: MeshProviderAdapter | null = null;

/**
 * Creates or returns a cached provider adapter based on environment configuration.
 * Provider type is determined by MESH_PROVIDER or PROVIDER env var.
 * The adapter is cached as a singleton since the underlying provider is lazily initialized.
 * @returns MeshProviderAdapter instance configured for the selected provider
 * @throws Error if required environment variables are missing
 */
export function createProvider(): MeshProviderAdapter {
  if (cachedProvider) return cachedProvider;
  const providerKind = (process.env.MESH_PROVIDER || process.env.PROVIDER || "blockfrost")
    .toLowerCase()
    .trim();

  let adapter: MeshProviderAdapter;

  if (providerKind === "blockfrost") {
    adapter = new MeshProviderAdapter(async () => {
      const { BlockfrostProvider } = await import("@meshsdk/core");
      const baseUrl = process.env.BLOCKFROST_URL;
      if (baseUrl) {
        // Use private/hosted Blockfrost instance via base URL
        return new BlockfrostProvider(baseUrl.trim()) as MeshProvider;
      }
      const projectId = process.env.BLOCKFROST_PROJECT_ID;
      if (!projectId) throw new Error("BLOCKFROST_PROJECT_ID or BLOCKFROST_URL is required");
      const rawVersion = process.env.BLOCKFROST_VERSION ? Number(process.env.BLOCKFROST_VERSION) : 0;
      const version = Number.isFinite(rawVersion) ? rawVersion : 0;
      // Trim project ID to handle accidental whitespace in env vars
      const trimmedProjectId = projectId.trim();
      return new BlockfrostProvider(trimmedProjectId, version) as MeshProvider;
    });
  } else if (providerKind === "kupo") {
    adapter = new MeshProviderAdapter(async () => {
      const { KupoProvider } = await import("@meshsdk/core");
      const kupoUrl = process.env.KUPO_URL;
      if (!kupoUrl) throw new Error("KUPO_URL is required when MESH_PROVIDER=kupo");
      return new KupoProvider(kupoUrl) as MeshProvider;
    });
  } else if (providerKind === "ogmios") {
    adapter = new MeshProviderAdapter(async () => {
      const { OgmiosProvider } = await import("@meshsdk/core");
      const ogmiosUrl = process.env.OGMIOS_URL;
      if (!ogmiosUrl) throw new Error("OGMIOS_URL is required when MESH_PROVIDER=ogmios");
      return new OgmiosProvider(ogmiosUrl) as MeshProvider;
    });
  } else if (providerKind === "kupo+ogmios") {
    adapter = new MeshProviderAdapter(async () => {
      const { KupoProvider, OgmiosProvider } = await import("@meshsdk/core");
      const kupoUrl = process.env.KUPO_URL;
      const ogmiosUrl = process.env.OGMIOS_URL;
      if (!kupoUrl) throw new Error("KUPO_URL is required when MESH_PROVIDER=kupo+ogmios");
      if (!ogmiosUrl) throw new Error("OGMIOS_URL is required when MESH_PROVIDER=kupo+ogmios");

      const kupoProvider = new KupoProvider(kupoUrl) as MeshProvider;
      const ogmiosProvider = new OgmiosProvider(ogmiosUrl) as MeshProvider;

      // Shared implementation so both aliases can call it without relying on `this`
      async function fetchAddressUTxOsImpl(address: unknown, asset?: string): Promise<unknown[]> {
        let result: unknown[] | undefined;
        // Track whether the result came from getUnspentOutputs, which does not
        // support server-side asset filtering and therefore needs client-side filtering.
        let needsClientFilter = false;
        try {
          if (typeof kupoProvider.fetchAddressUTxOs === "function") {
            result = await kupoProvider.fetchAddressUTxOs(address, asset);
          } else if (typeof kupoProvider.getUnspentOutputs === "function") {
            result = await kupoProvider.getUnspentOutputs(address);
            needsClientFilter = true;
          }
        } catch (err) {
          console.warn("Kupo fetchAddressUTxOs failed, falling back to Ogmios:", err);
        }
        if (result === undefined) {
          needsClientFilter = false;
          if (typeof ogmiosProvider.fetchAddressUTxOs === "function") {
            result = await ogmiosProvider.fetchAddressUTxOs(address, asset);
          } else if (typeof ogmiosProvider.getUnspentOutputs === "function") {
            result = await ogmiosProvider.getUnspentOutputs(address);
            needsClientFilter = true;
          }
        }
        if (result === undefined) {
          throw new Error("Neither Kupo nor Ogmios supports fetchAddressUTxOs");
        }
        // Only apply client-side asset filtering when the result came from
        // getUnspentOutputs, which does not support server-side filtering.
        // fetchAddressUTxOs already filters by asset on the provider side.
        // Normalize by removing dot separators to handle both "policyId.assetName" and
        // "policyIdassetName" formats consistently across providers.
        if (needsClientFilter && asset && result) {
          const normalizedAsset = normalizeAssetId(asset);
          result = (result as UTxO[]).filter((utxo) =>
            utxo.output.amount.some((a) => normalizeAssetId(a.unit) === normalizedAsset)
          );
        }
        return result;
      }

      // Composite provider: delegates to Kupo (primary), falls back to Ogmios
      return {
        async fetchAddressUTxOs(address: unknown, asset?: string): Promise<unknown[]> {
          return fetchAddressUTxOsImpl(address, asset);
        },

        async getUnspentOutputs(address: unknown): Promise<unknown[]> {
          return fetchAddressUTxOsImpl(address);
        },

        async fetchUTxOs(hash: string, index?: number): Promise<unknown[]> {
          try {
            if (typeof kupoProvider.fetchUTxOs === "function") {
              return await kupoProvider.fetchUTxOs(hash, index);
            }
          } catch (err) {
            console.warn("Kupo fetchUTxOs failed, falling back to Ogmios:", err);
          }
          if (typeof ogmiosProvider.fetchUTxOs === "function") {
            return await ogmiosProvider.fetchUTxOs(hash, index);
          }
          throw new Error("Neither Kupo nor Ogmios supports fetchUTxOs");
        },

        async submitTx(tx: unknown): Promise<unknown> {
          // Prefer Ogmios for transaction submission (more reliable for mempool)
          let ogmiosError: unknown;
          try {
            if (typeof ogmiosProvider.submitTx === "function") {
              return await ogmiosProvider.submitTx(tx);
            }
          } catch (err) {
            ogmiosError = err;
            console.warn("Ogmios submitTx failed, falling back to Kupo:", err);
          }
          if (typeof kupoProvider.submitTx === "function") {
            try {
              return await kupoProvider.submitTx(tx);
            } catch (kupoError) {
              console.warn("Kupo submitTx also failed:", kupoError);
              // Re-throw the original Ogmios error since it's typically more informative
              if (ogmiosError) throw ogmiosError;
              throw kupoError;
            }
          }
          // Re-throw the original Ogmios error if available, since Kupo typically doesn't support submitTx
          if (ogmiosError) throw ogmiosError;
          throw new Error("Neither Ogmios nor Kupo supports submitTx");
        },

        async fetchProtocolParameters(epoch?: number): Promise<unknown> {
          // Try Ogmios first for protocol parameters
          const ogmiosProv = ogmiosProvider as MeshProvider;
          if (typeof ogmiosProv.fetchProtocolParameters === "function") {
            try {
              return await ogmiosProv.fetchProtocolParameters(epoch);
            } catch (err) {
              console.warn("Ogmios fetchProtocolParameters failed, falling back to Kupo:", err);
            }
          }
          const kupoProv = kupoProvider as MeshProvider;
          if (typeof kupoProv.fetchProtocolParameters === "function") {
            return await kupoProv.fetchProtocolParameters(epoch);
          }
          throw new Error("Neither Ogmios nor Kupo supports fetchProtocolParameters");
        },

        async fetchAssetAddresses(asset: string): Promise<{ address: string; quantity: string }[]> {
          const kupoProv = kupoProvider as MeshProvider;
          if (typeof kupoProv.fetchAssetAddresses === "function") {
            try {
              return await kupoProv.fetchAssetAddresses(asset);
            } catch (err) {
              console.warn("Kupo fetchAssetAddresses failed, falling back to Ogmios:", err);
            }
          }
          const ogmiosProv = ogmiosProvider as MeshProvider;
          if (typeof ogmiosProv.fetchAssetAddresses === "function") {
            return await ogmiosProv.fetchAssetAddresses(asset);
          }
          throw new Error("Neither Kupo nor Ogmios supports fetchAssetAddresses");
        },

        async fetchBlockInfo(hash: string): Promise<unknown> {
          const kupoProv = kupoProvider as MeshProvider;
          if (typeof kupoProv.fetchBlockInfo === "function") {
            try {
              return await kupoProv.fetchBlockInfo(hash);
            } catch (err) {
              console.warn("Kupo fetchBlockInfo failed, falling back to Ogmios:", err);
            }
          }
          const ogmiosProv = ogmiosProvider as MeshProvider;
          if (typeof ogmiosProv.fetchBlockInfo === "function") {
            return await ogmiosProv.fetchBlockInfo(hash);
          }
          throw new Error("Neither Kupo nor Ogmios supports fetchBlockInfo");
        },

        async fetchLatestBlock(): Promise<unknown> {
          const ogmiosProv = ogmiosProvider as MeshProvider;
          if (typeof ogmiosProv.fetchLatestBlock === "function") {
            try {
              return await ogmiosProv.fetchLatestBlock();
            } catch (err) {
              console.warn("Ogmios fetchLatestBlock failed, falling back to Kupo:", err);
            }
          }
          const kupoProv = kupoProvider as MeshProvider;
          if (typeof kupoProv.fetchLatestBlock === "function") {
            return await kupoProv.fetchLatestBlock();
          }
          throw new Error("Neither Ogmios nor Kupo supports fetchLatestBlock");
        },
      } as MeshProvider;
    });
  } else {
    throw new Error(`Unsupported MESH_PROVIDER: ${providerKind}`);
  }

  cachedProvider = adapter;
  return adapter;
}
