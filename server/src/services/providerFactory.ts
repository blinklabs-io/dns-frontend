/* eslint-env node */
/* global process */

const DEFAULT_RPC_URL = "https://preprod.utxorpc-v0.demeter.run";

function makeHeaders(apiKey?: string) {
  return apiKey ? { "dmtr-api-key": apiKey } : {};
}

type MeshProvider = {
  getNetworkId?: () => Promise<number> | number;
  getUnspentOutputs?: (address: unknown) => Promise<unknown[]>;
  getUnspentOutputsWithAsset?: (address: unknown, assetId: string) => Promise<unknown[]>;
  fetchAddressUTxOs?: (address: unknown, assetId?: string) => Promise<unknown[]>;
  fetchUTxOs?: (address: unknown) => Promise<unknown[]>;
  fetchUTxOsWithAsset?: (address: unknown, assetId: string) => Promise<unknown[]>;
  resolveUnspentOutputs?: (inputs: unknown[]) => Promise<unknown[]>;
  postTransactionToChain?: (tx: unknown) => Promise<unknown>;
  submitTx?: (tx: unknown) => Promise<unknown>;
};

export class MeshProviderAdapter {
  private opts: { url: string; headers?: Record<string, string> };
  private inner: MeshProvider | null = null;

  constructor({ url, headers }: { url: string; headers?: Record<string, string> }) {
    this.opts = { url, headers };
  }

  private async ensureInner(): Promise<MeshProvider> {
    if (this.inner) return this.inner;
    const { U5CProvider } = await import("@meshsdk/core");
    this.inner = new U5CProvider(this.opts) as MeshProvider;
    return this.inner;
  }

  async getNetworkId(): Promise<number> {
    const inner = await this.ensureInner();
    if (typeof inner.getNetworkId === "function") {
      const res = await inner.getNetworkId();
      return typeof res === "number" ? res : 0;
    }
    return 0;
  }

  async getUnspentOutputs(address: unknown): Promise<unknown[]> {
    const inner = await this.ensureInner();
    if (typeof inner.getUnspentOutputs === "function") return inner.getUnspentOutputs(address);
    if (typeof inner.fetchAddressUTxOs === "function") return inner.fetchAddressUTxOs(address);
    if (typeof inner.fetchUTxOs === "function") return inner.fetchUTxOs(address);
    throw new Error("Mesh provider does not expose getUnspentOutputs/fetchUTxOs");
  }

  async getUnspentOutputsWithAsset(address: unknown, assetId: string): Promise<unknown[]> {
    const inner = await this.ensureInner();
    if (typeof inner.getUnspentOutputsWithAsset === "function") return inner.getUnspentOutputsWithAsset(address, assetId);
    if (typeof inner.fetchAddressUTxOs === "function") return inner.fetchAddressUTxOs(address, assetId);
    if (typeof inner.fetchUTxOsWithAsset === "function") return inner.fetchUTxOsWithAsset(address, assetId);
    throw new Error("Mesh provider does not expose getUnspentOutputsWithAsset/fetchUTxOsWithAsset");
  }

  async resolveUnspentOutputs(inputs: unknown[]): Promise<unknown[]> {
    const inner = await this.ensureInner();
    if (typeof inner.resolveUnspentOutputs === "function") return inner.resolveUnspentOutputs(inputs);
    throw new Error("Mesh provider does not expose resolveUnspentOutputs");
  }

  async postTransactionToChain(tx: unknown): Promise<unknown> {
    const inner = await this.ensureInner();
    if (typeof inner.postTransactionToChain === "function") return inner.postTransactionToChain(tx);
    if (typeof inner.submitTx === "function") return inner.submitTx(tx);
    throw new Error("Mesh provider does not expose postTransactionToChain/submitTx");
  }
}

export function createProvider() {
  const url = process.env.UTXORPC_URL || DEFAULT_RPC_URL;
  const apiKey = process.env.DMTR_API_KEY;
  const headers = apiKey ? makeHeaders(apiKey) : undefined;
  return new MeshProviderAdapter({ url, headers: headers as Record<string, string> });
}
