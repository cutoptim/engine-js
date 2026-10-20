// Verify a CutOptim webhook delivery (the CutOptim-Signature header) — Web Crypto, so it runs on Node 18+, Deno, Bun,
// Cloudflare Workers and in the browser alike.
//
//   CutOptim-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>[,v1=…]
//
// Pass the RAW request body (the exact bytes received) — a body that was parsed and serialised again does not match.
// During a secret rotation the header carries two v1 values; either matching your secret is enough.

export const SIGNATURE_HEADER = 'CutOptim-Signature';
export const DEFAULT_TOLERANCE_S = 300;

const enc = new TextEncoder();

async function subtle(): Promise<SubtleCrypto> {
  if (globalThis.crypto?.subtle) return globalThis.crypto.subtle;
  // Node 18 without the global: the same API from node:crypto.
  const nodeCrypto = await import('node:crypto' as string) as { webcrypto: { subtle: SubtleCrypto } };
  return nodeCrypto.webcrypto.subtle;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export interface VerifyOptions {
  /** Maximum clock difference in seconds (default 300). */
  toleranceS?: number;
  /** Override "now" (unix seconds) — for tests. */
  nowS?: number;
}

/**
 * True when `header` is a valid CutOptim signature of `rawBody` under one of `secrets`, inside the time window.
 * `rawBody` must be the exact bytes received (string or Uint8Array).
 */
export async function verifyWebhook(rawBody: string | Uint8Array, header: string | null | undefined, secrets: string | string[], opts: VerifyOptions = {}): Promise<boolean> {
  if (typeof header !== 'string' || header.length > 4096) return false;
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) return false;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === 't') { if (t !== null || !/^\d{1,12}$/.test(v)) return false; t = Number(v); }
    else if (k === 'v1') { if (!/^[0-9a-f]{64}$/.test(v)) return false; v1.push(v); }
  }
  if (t === null || !v1.length) return false;
  const now = opts.nowS ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceS ?? DEFAULT_TOLERANCE_S)) return false;
  const body = typeof rawBody === 'string' ? enc.encode(rawBody) : rawBody;
  const signed = new Uint8Array(enc.encode(`${t}.`).length + body.length);
  signed.set(enc.encode(`${t}.`), 0); signed.set(body, enc.encode(`${t}.`).length);
  const s = await subtle();
  for (const secret of Array.isArray(secrets) ? secrets : [secrets]) {
    const key = await s.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await s.sign('HMAC', key, signed));
    if (v1.some((h) => timingSafeEqual(mac, hexToBytes(h)))) return true;
  }
  return false;
}
