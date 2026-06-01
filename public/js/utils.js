// Shared utilities

export function shortHash(h, len = 12) {
  if (!h) return '—';
  return `${h.slice(0, len)}…`;
}

export function shortAddr(a, len = 10) {
  if (!a || a === 'genesis') return a;
  return `${a.slice(0, len)}…${a.slice(-6)}`;
}

export function relativeTime(ts) {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60)    return `${diff}s ago`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function formatDate(ts) {
  return new Date(ts * 1000).toLocaleString('en-GB', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZoneName: 'short',
  });
}

export function formatHashrate(hps) {
  if (!hps || hps <= 0) return '—';
  if (hps < 1000)       return `${hps} H/s`;
  if (hps < 1_000_000)  return `${(hps / 1e3).toFixed(2)} KH/s`;
  if (hps < 1e9)        return `${(hps / 1e6).toFixed(2)} MH/s`;
  return `${(hps / 1e9).toFixed(2)} GH/s`;
}

export function formatNumber(n) {
  return n?.toLocaleString('en-US') ?? '—';
}

export function formatTxmFromAtoms(atoms) {
  if (atoms === null || atoms === undefined) return '—';
  const big = BigInt(atoms);
  const whole = big / 100000000n;
  const frac = (big % 100000000n).toString().padStart(8, '0');
  return `${whole}.${frac}`;
}

export async function fetchJSON(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  const r = await fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timeout));
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error || r.statusText);
  }
  return r.json();
}

export function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const prev = btn.textContent;
    btn.textContent = '✓';
    setTimeout(() => (btn.textContent = prev), 1500);
  });
}

export function getQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

export function setTitle(t) {
  document.title = `${t} — Tensorium Explorer`;
}

// Build a copy button
export function copyBtn(value) {
  const btn = document.createElement('button');
  btn.className = 'copy-btn';
  btn.title = 'Copy';
  btn.textContent = '⧉';
  btn.onclick = (e) => { e.preventDefault(); copyToClipboard(value, btn); };
  return btn;
}
