# Express Server (Mesh Providers)

Simple Express API to create, submit, and decode Cardano transactions using Mesh providers.

## Setup

```bash
cd server
npm install
cp env.example .env
# choose provider + set credentials/URLs
```

## Run

```bash
# Development (auto-restart)
npm run dev

# Production
npm start
```

Server listens on `PORT` (default `3000`).

## Endpoints

- `POST /api/transactions/create` → returns `{ unsignedTx }`
- `POST /api/transactions/submit` → returns `{ txId }`
- `POST /api/transactions/decode-utxos` → returns decoded UTXO objects

## Env Vars

- `MESH_PROVIDER` – `blockfrost` (default), `kupo`, `ogmios`, `kupo+ogmios`
- `PORT` – server port (optional)

### Blockfrost
- `BLOCKFROST_PROJECT_ID` – Blockfrost project ID (required unless `BLOCKFROST_URL` provided)
- `BLOCKFROST_VERSION` – optional numeric API version (default `0`)
- `BLOCKFROST_URL` – optional base URL for private/hosted Blockfrost instance

### Kupo + Ogmios
- `KUPO_URL` – Kupo base URL (required when `MESH_PROVIDER=kupo` or `kupo+ogmios`)
- `OGMIOS_URL` – Ogmios URL (required when `MESH_PROVIDER=ogmios` or `kupo+ogmios`)
