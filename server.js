const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');

const app = express();
const PORT = 3000;
const RPC_HOST = process.env.TENSORIUM_EXPLORER_RPC_HOST || '127.0.0.1';
const RPC_PORT = Number(process.env.TENSORIUM_EXPLORER_RPC_PORT || 33332);
const ATOMS_PER_TXM = 100_000_000n;
const CACHE_TTL_MS = 15_000;
const CHART_CACHE_TTL_MS = 120_000;
const CHART_BLOCK_WINDOW = 240;
const TX_SCAN_WINDOW = 120;
const TX_BATCH_SIZE = 10;
const INDEX_BATCH_SIZE = 25;
const INDEX_PATH = process.env.TENSORIUM_EXPLORER_INDEX || path.join(__dirname, 'txindex.json');
const ADDRESS_HRP = 'txm';
const P2SH_HRP = 'txms';
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html') || req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  if (req.path.endsWith('/js/utils.js') || req.path === '/js/utils.js') {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

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

function bech32Polymod(values) {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const value of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < generators.length; i += 1) {
      if ((top >>> i) & 1) chk ^= generators[i];
    }
  }
  return chk;
}

function bech32HrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i += 1) out.push(hrp.charCodeAt(i) >>> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i += 1) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function convertBits(data, fromBits, toBits, pad = true) {
  let acc = 0;
  let bits = 0;
  const maxv = (1 << toBits) - 1;
  const out = [];
  for (const value of data) {
    if (!Number.isInteger(value) || value < 0 || value >>> fromBits !== 0) {
      return null;
    }
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      out.push((acc >>> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
    return null;
  }
  return out;
}

function bech32Encode(hrp, bytes) {
  const words = convertBits(bytes, 8, 5, true);
  if (!words) return null;
  const values = bech32HrpExpand(hrp).concat(words).concat([0, 0, 0, 0, 0, 0]);
  const polymod = bech32Polymod(values) ^ 1;
  const checksum = [];
  for (let i = 0; i < 6; i += 1) {
    checksum.push((polymod >>> (5 * (5 - i))) & 31);
  }
  return `${hrp}1${words.concat(checksum).map(v => BECH32_CHARSET[v]).join('')}`;
}

function extractAddressFromScriptPubkey(scriptPubkey) {
  if (!Array.isArray(scriptPubkey)) return null;

  // P2SH: OP_HASH160 0x14 <20-byte hash> OP_EQUAL
  if (scriptPubkey.length === 23 && scriptPubkey[0] === 0xa9 && scriptPubkey[1] === 0x14 && scriptPubkey[22] === 0x87) {
    return bech32Encode(P2SH_HRP, scriptPubkey.slice(2, 22));
  }

  // P2PKH: OP_DUP OP_HASH160 0x14 <20-byte hash> OP_EQUALVERIFY OP_CHECKSIG
  if (
    scriptPubkey.length === 25 &&
    scriptPubkey[0] === 0x76 &&
    scriptPubkey[1] === 0xa9 &&
    scriptPubkey[2] === 0x14 &&
    scriptPubkey[23] === 0x88 &&
    scriptPubkey[24] === 0xac
  ) {
    return bech32Encode(ADDRESS_HRP, scriptPubkey.slice(3, 23));
  }

  return null;
}

function normalizeOutputAddress(output) {
  if (typeof output?.address === 'string' && output.address.length > 0) return output.address;
  return extractAddressFromScriptPubkey(output?.script_pubkey);
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
const explorerIndex = {
  chainId: null,
  tipHeight: -1,
  tipHash: null,
  syncedAt: 0,
  persistedAt: 0,
  lastError: null,
  syncPromise: null,
  savePromise: null,
  loadedFromDisk: false,
  txById: new Map(),
  addressAppearances: new Map(),
  blockHashByHeight: new Map(),
};

function resetExplorerIndex() {
  explorerIndex.chainId = null;
  explorerIndex.tipHeight = -1;
  explorerIndex.tipHash = null;
  explorerIndex.syncedAt = 0;
  explorerIndex.persistedAt = 0;
  explorerIndex.lastError = null;
  explorerIndex.loadedFromDisk = false;
  explorerIndex.txById.clear();
  explorerIndex.addressAppearances.clear();
  explorerIndex.blockHashByHeight.clear();
}

function serializeExplorerIndex() {
  return {
    chainId: explorerIndex.chainId,
    tipHeight: explorerIndex.tipHeight,
    tipHash: explorerIndex.tipHash,
    syncedAt: explorerIndex.syncedAt,
    persistedAt: Date.now(),
    txById: Object.fromEntries(explorerIndex.txById),
    addressAppearances: Object.fromEntries(explorerIndex.addressAppearances),
    blockHashByHeight: Object.fromEntries(explorerIndex.blockHashByHeight),
  };
}

async function saveExplorerIndexToDisk() {
  if (explorerIndex.savePromise) return explorerIndex.savePromise;

  explorerIndex.savePromise = (async () => {
    const payload = JSON.stringify(serializeExplorerIndex());
    const tempPath = `${INDEX_PATH}.tmp`;
    await fs.promises.writeFile(tempPath, payload);
    await fs.promises.rename(tempPath, INDEX_PATH);
    explorerIndex.persistedAt = Date.now();
  })()
    .catch(error => {
      explorerIndex.lastError = `index save failed: ${error.message}`;
      throw error;
    })
    .finally(() => {
      explorerIndex.savePromise = null;
    });

  return explorerIndex.savePromise;
}

async function loadExplorerIndexFromDisk() {
  try {
    const raw = await fs.promises.readFile(INDEX_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    explorerIndex.chainId = parsed.chainId || null;
    explorerIndex.tipHeight = Number.isInteger(parsed.tipHeight) ? parsed.tipHeight : -1;
    explorerIndex.tipHash = parsed.tipHash || null;
    explorerIndex.syncedAt = parsed.syncedAt || 0;
    explorerIndex.persistedAt = parsed.persistedAt || 0;
    explorerIndex.lastError = null;
    explorerIndex.loadedFromDisk = true;
    explorerIndex.txById = new Map(Object.entries(parsed.txById || {}));
    explorerIndex.addressAppearances = new Map(Object.entries(parsed.addressAppearances || {}));
    explorerIndex.blockHashByHeight = new Map(
      Object.entries(parsed.blockHashByHeight || {}).map(([height, hash]) => [Number(height), hash])
    );
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    explorerIndex.lastError = `index load failed: ${error.message}`;
    throw error;
  }
}

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
      address: normalizeOutputAddress(o),
      script_pubkey: o.script_pubkey || [],
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

function indexBlock(block) {
  explorerIndex.blockHashByHeight.set(block.height, block.hash);
  explorerIndex.tipHeight = block.height;
  explorerIndex.tipHash = block.hash;
  explorerIndex.chainId = block.chain_id;
  explorerIndex.syncedAt = Date.now();

  for (const [txIndex, tx] of block.transactions.entries()) {
    const txRecord = {
      txid: tx.id,
      block_height: block.height,
      block_hash: block.hash,
      block_time: block.timestamp,
      chain_id: block.chain_id,
      difficulty_bits: block.difficulty_bits,
      is_coinbase: tx.is_coinbase,
      payload_text: tx.payload_text,
      inputs: tx.inputs,
      outputs: tx.outputs,
      tx_index: txIndex,
    };
    explorerIndex.txById.set(tx.id, txRecord);

    const totalsByAddress = new Map();
    for (const output of tx.outputs) {
      if (
        !output.address ||
        (!output.address.startsWith(`${ADDRESS_HRP}1`) && !output.address.startsWith(`${P2SH_HRP}1`))
      ) {
        continue;
      }
      totalsByAddress.set(
        output.address,
        (totalsByAddress.get(output.address) || 0n) + BigInt(output.value_atoms)
      );
    }

    for (const [address, valueAtoms] of totalsByAddress.entries()) {
      const appearances = explorerIndex.addressAppearances.get(address) || [];
      appearances.push({
        block_height: block.height,
        block_hash: block.hash,
        block_time: block.timestamp,
        txid: tx.id,
        is_coinbase: tx.is_coinbase,
        received_atoms: Number(valueAtoms),
        received_txm: atomsToTxm(Number(valueAtoms)),
      });
      explorerIndex.addressAppearances.set(address, appearances);
    }
  }
}

async function ensureExplorerIndex() {
  if (explorerIndex.syncPromise) return explorerIndex.syncPromise;

  explorerIndex.syncPromise = (async () => {
    try {
      if (explorerIndex.tipHeight < 0 && explorerIndex.txById.size === 0) {
        await loadExplorerIndexFromDisk();
      }

      const tip = await getTipState();
      let changed = false;
      if (explorerIndex.chainId && explorerIndex.chainId !== tip.chain_id) {
        resetExplorerIndex();
        changed = true;
      }

      if (explorerIndex.tipHeight >= 0) {
        const currentTipBlock = await getBlockByHeight(explorerIndex.tipHeight);
        if (currentTipBlock.hash !== explorerIndex.blockHashByHeight.get(explorerIndex.tipHeight)) {
          resetExplorerIndex();
          changed = true;
        }
      }

      const startHeight = explorerIndex.tipHeight + 1;
      for (let batchStart = startHeight; batchStart <= tip.height; batchStart += INDEX_BATCH_SIZE) {
        const heights = [];
        for (
          let h = batchStart;
          h <= tip.height && h < batchStart + INDEX_BATCH_SIZE;
          h++
        ) {
          heights.push(h);
        }
        const blocks = await Promise.all(heights.map(h => getBlockByHeight(h)));
        blocks
          .sort((a, b) => a.height - b.height)
          .forEach(block => indexBlock(block));
        changed = true;
      }

      explorerIndex.chainId = tip.chain_id;
      explorerIndex.lastError = null;
      if (changed) {
        await saveExplorerIndexToDisk();
      }
    } catch (error) {
      explorerIndex.lastError = error.message;
      throw error;
    } finally {
      explorerIndex.syncPromise = null;
    }
  })();

  return explorerIndex.syncPromise;
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

    await ensureExplorerIndex();
    const appearances = [...(explorerIndex.addressAppearances.get(addr) || [])]
      .sort((a, b) => b.block_height - a.block_height);
    const totalReceived = appearances.reduce((sum, item) => sum + BigInt(item.received_atoms), 0n);

    res.json({
      address: addr,
      total_received_atoms: Number(totalReceived),
      total_received_txm: atomsToTxm(Number(totalReceived)),
      tx_count: appearances.length,
      appearances,
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

    await ensureExplorerIndex();
    const tx = explorerIndex.txById.get(txid);
    if (tx) {
      const totalOutputAtoms = tx.outputs.reduce(
        (sum, output) => sum + BigInt(output.value_atoms),
        0n
      );

      return res.json({
        ...tx,
        total_output_atoms: Number(totalOutputAtoms),
        total_output_txm: atomsToTxm(Number(totalOutputAtoms)),
      });
    }

    return res.status(404).json({ error: 'transaction not found' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/indexer/status', async (req, res) => {
  try {
    await ensureExplorerIndex();
    res.json({
      chain_id: explorerIndex.chainId,
      indexed_tip_height: explorerIndex.tipHeight,
      indexed_tip_hash: explorerIndex.tipHash,
      tx_count: explorerIndex.txById.size,
      address_count: explorerIndex.addressAppearances.size,
      synced_at: explorerIndex.syncedAt,
      persisted_at: explorerIndex.persistedAt,
      loaded_from_disk: explorerIndex.loadedFromDisk,
      index_path: INDEX_PATH,
      last_error: explorerIndex.lastError,
    });
  } catch (e) {
    res.status(502).json({
      chain_id: explorerIndex.chainId,
      indexed_tip_height: explorerIndex.tipHeight,
      indexed_tip_hash: explorerIndex.tipHash,
      tx_count: explorerIndex.txById.size,
      address_count: explorerIndex.addressAppearances.size,
      synced_at: explorerIndex.syncedAt,
      persisted_at: explorerIndex.persistedAt,
      loaded_from_disk: explorerIndex.loadedFromDisk,
      index_path: INDEX_PATH,
      last_error: e.message,
    });
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
