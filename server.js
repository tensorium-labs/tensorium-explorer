const express = require('express');
const http = require('http');
const path = require('path');

const app = express();
const PORT = 3000;
const RPC_HOST = '127.0.0.1';
const RPC_PORT = 23332;
const ATOMS_PER_TXM = 100_000_000n;
const CACHE_TTL_MS = 15_000;
const CHART_CACHE_TTL_MS = 120_000;
const CHART_BLOCK_WINDOW = 240;
const TX_SCAN_WINDOW = 120;
const TX_BATCH_SIZE = 10;

app.use(express.static(path.join(__dirname, 'public')));

// ── helpers ──────────────────────────────────────────────────────────────────

function toHex(arr) {
  if (!arr || !arr.length) return '0'.repeat(64);
  return arr.map(b => b.toString(16).padStart(2, '0')).join('');
}

function atomsToTxm(atoms) {
  if (typeof atoms !== 'number') return '0';
  const big = BigInt(atoms);
  const whole = big / ATOMS_PER_TXM;
  const frac = big % ATOMS_PER_TXM;
  return `${whole}.${frac.toString().padStart(8, '0')}`;
}

function rpcGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: RPC_HOST, port: RPC_PORT, path, method: 'GET' },
      res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`JSON parse error: ${data.slice(0, 100)}`)); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('RPC timeout')); });
    req.end();
  });
}

const responseCache = new Map();

async function withCache(key, ttlMs, loader) {
  const now = Date.now();
  const cached = responseCache.get(key);
  if (cached && cached.expiresAt > now && Object.prototype.hasOwnProperty.call(cached, 'value')) {
    return cached.value;
  }
  if (cached?.promise) return cached.promise;

  const promise = Promise.resolve(loader())
    .then(value => {
      responseCache.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    })
    .catch(error => {
      responseCache.delete(key);
      throw error;
    });

  responseCache.set(key, { promise, expiresAt: now + ttlMs });
  return promise;
}

async function getTipState() {
  return withCache('rpc:getblockcount', CACHE_TTL_MS, () => rpcGet('/getblockcount'));
}

async function getBlockByHeight(height) {
  return withCache(`block:${height}`, CACHE_TTL_MS, async () => {
    const raw = await rpcGet(`/getblock/${height}`);
    return transformBlock(raw);
  });
}

function transformBlock(raw) {
  const h = raw.block.header;
  const txs = raw.block.transactions.map(tx => ({
    id: toHex(tx.id),
    inputs: (tx.inputs || []).map(input => ({
      previous_txid: toHex(input.previous_output?.txid || []),
      output_index: input.previous_output?.output_index ?? 0,
      signature_script: input.signature_script || [],
    })),
    outputs: (tx.outputs || []).map(o => ({
      address: o.address,
      value_atoms: o.value_atoms,
      value_txm: atomsToTxm(o.value_atoms),
    })),
    is_coinbase: !tx.inputs || tx.inputs.length === 0,
    payload_text: tx.payload ? Buffer.from(tx.payload).toString('utf8') : '',
  }));

  const miner = txs[0]?.outputs[0]?.address ?? 'unknown';
  const reward = txs[0]?.outputs[0]?.value_txm ?? '0';

  return {
    height: h.height,
    hash: toHex(raw.hash),
    prev_hash: toHex(h.previous_hash),
    merkle_root: toHex(h.merkle_root),
    timestamp: h.timestamp_seconds,
    nonce: h.nonce,
    difficulty_bits: h.leading_zero_bits,
    version: h.version,
    chain_id: h.chain_id,
    tx_count: txs.length,
    miner,
    reward,
    transactions: txs,
  };
}

// Estimate network hashrate from last N blocks
function estimateHashrate(blocks) {
  if (blocks.length < 2) return null;
  const sorted = [...blocks].sort((a, b) => a.height - b.height);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const spanSecs = last.timestamp - first.timestamp;
  if (spanSecs <= 0) return null;
  // work = sum of 2^difficulty_bits for each block
  const totalWork = sorted.reduce((s, b) => s + Math.pow(2, b.difficulty_bits), 0);
  return Math.round(totalWork / spanSecs);
}

function sampleSeries(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const sampled = [];
  const lastIndex = points.length - 1;
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.round((i * lastIndex) / (maxPoints - 1));
    sampled.push(points[idx]);
  }
  return sampled;
}

// ── API routes ────────────────────────────────────────────────────────────────

app.get('/api/stats', async (req, res) => {
  try {
    const payload = await withCache('stats', CACHE_TTL_MS, async () => {
      const [count, diff, mempool] = await Promise.all([
        getTipState(),
        rpcGet('/getdifficulty'),
        rpcGet('/getmempoolinfo'),
      ]);

      const height = count.height;
      const fetchFrom = Math.max(0, height - 9);
      const blockPromises = [];
      for (let h = fetchFrom; h <= height; h++) {
        blockPromises.push(getBlockByHeight(h).catch(() => null));
      }
      const recentBlocks = (await Promise.all(blockPromises)).filter(Boolean);
      const hashrate = estimateHashrate(recentBlocks);

      return {
        height: count.height,
        blocks: count.blocks,
        chain_id: count.chain_id,
        difficulty_bits: diff.leading_zero_bits,
        mempool_count: mempool.count,
        hashrate,
      };
    });

    res.json(payload);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/blocks', async (req, res) => {
  try {
    const count = await getTipState();
    const height = count.height;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const from = req.query.from !== undefined ? parseInt(req.query.from) : height;
    const cacheKey = `blocks:${from}:${limit}:${height}`;

    const payload = await withCache(cacheKey, CACHE_TTL_MS, async () => {
      const promises = [];
      for (let h = from; h >= Math.max(0, from - limit + 1); h--) {
        promises.push(getBlockByHeight(h).catch(() => null));
      }
      const blocks = (await Promise.all(promises)).filter(Boolean);
      return { blocks, tip: height };
    });

    res.json(payload);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/transactions', async (req, res) => {
  try {
    const count = await getTipState();
    const tip = count.height;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const cacheKey = `transactions:${tip}:${limit}`;

    const payload = await withCache(cacheKey, CACHE_TTL_MS, async () => {
      const items = [];
      let scanned = 0;

      for (let start = tip; start >= 0 && items.length < limit && scanned < TX_SCAN_WINDOW; start -= TX_BATCH_SIZE) {
        const heights = [];
        for (let h = start; h > start - TX_BATCH_SIZE && h >= 0; h--) {
          heights.push(h);
        }
        scanned += heights.length;

        const blocks = (await Promise.all(
          heights.map(h => getBlockByHeight(h).catch(() => null))
        )).filter(Boolean);

        for (const block of blocks) {
          for (const tx of block.transactions) {
            const totalOutputAtoms = tx.outputs.reduce(
              (sum, output) => sum + BigInt(output.value_atoms),
              0n
            );
            items.push({
              txid: tx.id,
              block_height: block.height,
              block_time: block.timestamp,
              is_coinbase: tx.is_coinbase,
              output_count: tx.outputs.length,
              total_output_atoms: Number(totalOutputAtoms),
              total_output_txm: atomsToTxm(Number(totalOutputAtoms)),
            });
            if (items.length >= limit) break;
          }
          if (items.length >= limit) break;
        }
      }

      return {
        transactions: items,
        tip_height: tip,
        scanned_blocks: scanned,
      };
    });

    res.json(payload);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/charts', async (req, res) => {
  try {
    const count = await getTipState();
    const tip = count.height;
    const cacheKey = `charts:${tip}`;

    const payload = await withCache(cacheKey, CHART_CACHE_TTL_MS, async () => {
      const start = Math.max(0, tip - CHART_BLOCK_WINDOW + 1);
      const heights = [];
      for (let h = start; h <= tip; h++) heights.push(h);

      const blocks = (await Promise.all(
        heights.map(h => getBlockByHeight(h).catch(() => null))
      ))
        .filter(Boolean)
        .sort((a, b) => a.height - b.height);

      let cumulativeAtoms = 0n;
      const difficultySeries = [];
      const supplySeries = [];

      for (const block of blocks) {
        const coinbase = block.transactions.find(tx => tx.is_coinbase);
        const coinbaseAtoms = coinbase
          ? coinbase.outputs.reduce((sum, output) => sum + BigInt(output.value_atoms), 0n)
          : 0n;
        cumulativeAtoms += coinbaseAtoms;

        difficultySeries.push({
          height: block.height,
          timestamp: block.timestamp,
          value: block.difficulty_bits,
        });
        supplySeries.push({
          height: block.height,
          timestamp: block.timestamp,
          value_atoms: Number(cumulativeAtoms),
          value_txm: atomsToTxm(Number(cumulativeAtoms)),
        });
      }

      return {
        tip_height: tip,
        range_start: start,
        sample_size: Math.min(blocks.length, 120),
        difficulty: sampleSeries(difficultySeries, 120),
        supply: sampleSeries(supplySeries, 120),
        current_supply_atoms: Number(cumulativeAtoms),
        current_supply_txm: atomsToTxm(Number(cumulativeAtoms)),
      };
    });

    res.json(payload);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/block/:height', async (req, res) => {
  try {
    const h = parseInt(req.params.height);
    if (isNaN(h) || h < 0) return res.status(400).json({ error: 'invalid height' });
    res.json(await getBlockByHeight(h));
  } catch (e) {
    const msg = e.message || '';
    const status = msg.includes('not found') || msg.includes('404') ? 404 : 502;
    res.status(status).json({ error: e.message });
  }
});

app.get('/api/address/:addr', async (req, res) => {
  try {
    const addr = req.params.addr;
    if (!addr.startsWith('txm1')) return res.status(400).json({ error: 'invalid address' });

    const count = await getTipState();
    const height = count.height;

    // scan all blocks (fine for testnet; add DB index for mainnet)
    const promises = [];
    for (let h = 0; h <= height; h++) {
      promises.push(getBlockByHeight(h).catch(() => null));
    }
    const blocks = (await Promise.all(promises)).filter(Boolean);

    let totalReceived = 0n;
    const appearances = [];

    for (const block of blocks) {
      for (const tx of block.transactions) {
        const matchedOutputs = tx.outputs.filter(o => o.address === addr);
        if (matchedOutputs.length > 0) {
          const value = matchedOutputs.reduce((s, o) => s + BigInt(o.value_atoms), 0n);
          totalReceived += value;
          appearances.push({
            block_height: block.height,
            block_hash: block.hash,
            block_time: block.timestamp,
            txid: tx.id,
            is_coinbase: tx.is_coinbase,
            received_atoms: Number(value),
            received_txm: atomsToTxm(Number(value)),
          });
        }
      }
    }

    res.json({
      address: addr,
      total_received_atoms: Number(totalReceived),
      total_received_txm: atomsToTxm(Number(totalReceived)),
      tx_count: appearances.length,
      appearances: appearances.sort((a, b) => b.block_height - a.block_height),
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/tx/:txid', async (req, res) => {
  try {
    const txid = String(req.params.txid || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txid)) {
      return res.status(400).json({ error: 'invalid txid' });
    }

    const count = await getTipState();
    const height = count.height;

    for (let h = height; h >= 0; h--) {
      const block = await getBlockByHeight(h);
      const txIndex = block.transactions.findIndex(tx => tx.id === txid);
      if (txIndex === -1) continue;

      const tx = block.transactions[txIndex];
      const totalOutputAtoms = tx.outputs.reduce(
        (sum, output) => sum + BigInt(output.value_atoms),
        0n
      );

      return res.json({
        txid: tx.id,
        block_height: block.height,
        block_hash: block.hash,
        block_time: block.timestamp,
        chain_id: block.chain_id,
        difficulty_bits: block.difficulty_bits,
        tx_index: txIndex,
        is_coinbase: tx.is_coinbase,
        total_output_atoms: Number(totalOutputAtoms),
        total_output_txm: atomsToTxm(Number(totalOutputAtoms)),
        payload_text: tx.payload_text,
        inputs: tx.inputs,
        outputs: tx.outputs,
      });
    }

    return res.status(404).json({ error: 'transaction not found' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// SPA fallback for client-side routing
app.get('/block/:height', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'block.html'))
);
app.get('/address/:addr', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'address.html'))
);
app.get('/tx/:txid', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'tx.html'))
);

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Tensorium Explorer running on http://127.0.0.1:${PORT}`);
});
