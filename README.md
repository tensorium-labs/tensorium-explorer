# Tensorium Explorer

Lightweight Node.js block explorer for the Tensorium Proof-of-Work chain.

The explorer reads block and transaction data from a Tensorium node RPC endpoint and serves public HTML pages for blocks, transactions, addresses, and basic chain statistics.

## Features

- Block pages by height
- Transaction lookup
- Address activity pages
- Chain tip and block count display
- Lightweight local index file for faster lookups

## Runtime Requirements

- A synced Tensorium node RPC endpoint
- RPC defaults to `127.0.0.1:33332`
- P2P is not required by the explorer itself

## Important TXM L1 Notes

- The explorer is read-only and depends on node RPC correctness
- RPC should normally remain bound to localhost
- Current chain ID: `tensorium-mainnet-candidate-0`
- Public P2P port for nodes: `33333/tcp`
- Current transaction fee posture: no protocol-enforced minimum fee
- Coinbase outputs mature after `100` blocks

## Configuration

- `TENSORIUM_EXPLORER_RPC_HOST` — RPC host, default `127.0.0.1`
- `TENSORIUM_EXPLORER_RPC_PORT` — RPC port, default `33332`
- `TENSORIUM_EXPLORER_INDEX` — path to local tx index cache

## Development

```bash
npm install
npm run dev
```

## Production

```bash
npm install
npm start
```

## License

Apache-2.0
