# Express Server (Demeter UTXORPC + Blaze)

Simple Express API to create, submit, and decode Cardano transactions using Demeter UTXORPC and Blaze.

## Setup

```bash
cd server
npm install
cp env.example .env
# fill in DMTR_API_KEY (Demeter)
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

- `DMTR_API_KEY` – Demeter API key
- `UTXORPC_URL` – defaults to `https://preprod.utxorpc-v0.demeter.run`
- `PORT` – server port (optional)
