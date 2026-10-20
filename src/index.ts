// @cutoptim/engine — the official client for the CutOptim Engine API (https://cutoptim.com/engine/reference).
// Zero runtime dependencies: the global fetch (Node 18+, Deno, Bun, browsers). Types are generated from the OpenAPI
// document (types.gen.ts); this file is the hand-written client around them.
//
// Behaviour worth knowing:
//   • Every optimize call carries an Idempotency-Key (yours, or a generated UUID), so the client's own retries — and
//     yours with the same key — are never charged twice and never queue a second max job.
//   • 429 / 503 / 409 idempotency_in_progress / network errors are retried (default 2 times), honouring Retry-After.
//   • A non-2xx answer throws CutOptimError with the API's stable `code` (branch on it, never on the message).
//   • engine:"max" answers 202 with a jobId: await client.waitForJob(jobId) — or register a webhook.
import type * as T from './types.gen.js';
import { VERSION } from './version.js';

export type * from './types.gen.js';
export { verifyWebhook, SIGNATURE_HEADER } from './webhooks.js';
export { VERSION } from './version.js';

export interface CutOptimOptions {
  /** Your API key (co_live_… or co_test_…). Not needed for health() and the validate*() calls. */
  apiKey?: string;
  /** Default https://api.cutoptim.com */
  baseUrl?: string;
  /** Retries on 429 / 503 / 409 in-progress / network errors (default 2). */
  maxRetries?: number;
  /** Per-request timeout in milliseconds (default 30 000). */
  timeoutMs?: number;
  /** A fetch implementation (default: the global fetch). */
  fetch?: typeof fetch;
}

export interface CallOptions {
  /** Your own Idempotency-Key for this job (8–128 of A-Z a-z 0-9 _ -). Default: a fresh UUID per call. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface JobAccepted { jobId: string; status: 'queued'; mode: string; engine: 'max'; pollAfterMs: number; quota?: { reserved?: number; used?: number; limit?: number } }
export type JobStatus = T.GetJobResult;

/** A non-2xx answer from the API. `code` is the stable machine-readable error (`invalid_request`, `quota_exceeded`, …). */
export class CutOptimError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly retryAfter: number | null;
  constructor(status: number, code: string, message: string, details: unknown, retryAfter: number | null) {
    super(message);
    this.name = 'CutOptimError';
    this.status = status; this.code = code; this.details = details; this.retryAfter = retryAfter;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newKey = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

export class CutOptim {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: CutOptimOptions = {}) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? 'https://api.cutoptim.com').replace(/\/+$/, '');
    this.maxRetries = opts.maxRetries ?? 2;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    const f = opts.fetch ?? globalThis.fetch;
    if (!f) throw new Error('CutOptim: no fetch available — pass options.fetch (Node 18+ has one built in)');
    this.fetchImpl = f.bind(globalThis);
  }

  // ── optimize (metered) ──
  /** 2D panels. engine:"max" answers with a JobAccepted (202) — see waitForJob. */
  optimize2d(request: T.Optimize2dBody, opts?: CallOptions): Promise<T.Optimize2DResponse | JobAccepted> { return this.call('POST', '/v1/optimize/2d', request, opts, true); }
  /** 1D linear cutting. */
  optimize1d(request: T.Optimize1dBody, opts?: CallOptions): Promise<T.Optimize1DResponse> { return this.call('POST', '/v1/optimize/1d', request, opts, true); }
  /** Timber with cross-sections. */
  optimizeWood(request: T.OptimizeWoodRequest, opts?: CallOptions): Promise<T.OptimizeWoodResponse> { return this.call('POST', '/v1/optimize/wood', request, opts, true); }
  /** True-shape nesting. engine:"max" answers with a JobAccepted (202). */
  optimizeNest(request: T.OptimizeNestRequest, opts?: CallOptions): Promise<T.OptimizeNestResponse | JobAccepted> { return this.call('POST', '/v1/optimize/nest', request, opts, true); }

  // ── free / account ──
  validate2d(request: T.Optimize2dBody, opts?: CallOptions): Promise<T.ValidateResponse> { return this.call('POST', '/v1/validate/2d', request, opts); }
  validate1d(request: T.Optimize1dBody, opts?: CallOptions): Promise<T.ValidateResponse> { return this.call('POST', '/v1/validate/1d', request, opts); }
  validateWood(request: T.OptimizeWoodRequest, opts?: CallOptions): Promise<T.ValidateResponse> { return this.call('POST', '/v1/validate/wood', request, opts); }
  validateNest(request: T.OptimizeNestRequest, opts?: CallOptions): Promise<T.ValidateResponse> { return this.call('POST', '/v1/validate/nest', request, opts); }
  /** Read the parts out of an SVG or DXF file (needs a key, costs no quota). */
  importNest(request: T.NestImportRequest, opts?: CallOptions): Promise<T.NestImportResponse> { return this.call('POST', '/v1/import/nest', request, opts); }
  getJob(jobId: string, opts?: CallOptions): Promise<JobStatus> { return this.call('GET', `/v1/jobs/${encodeURIComponent(jobId)}`, undefined, opts); }
  usage(opts?: CallOptions): Promise<T.UsageResponse> { return this.call('GET', '/v1/usage', undefined, opts); }
  health(opts?: CallOptions): Promise<T.HealthResponse> { return this.call('GET', '/v1/health', undefined, opts); }

  /** True when an optimize answer is the async 202 of engine:"max". */
  static isJobAccepted(r: unknown): r is JobAccepted {
    return !!r && typeof r === 'object' && typeof (r as JobAccepted).jobId === 'string' && (r as JobAccepted).status === 'queued';
  }

  /** Poll GET /v1/jobs/{id} (no quota) until the job succeeded or failed. Honours pollAfterMs; default timeout 5 minutes. */
  async waitForJob(jobId: string, opts: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {}): Promise<JobStatus> {
    const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
    let wait = opts.intervalMs ?? 2000;
    for (;;) {
      const j = await this.getJob(jobId, { signal: opts.signal });
      if (j.status === 'succeeded' || j.status === 'failed') return j;
      if (Date.now() + wait > deadline) throw new CutOptimError(0, 'timeout', `job ${jobId} is still ${j.status} after the wait timeout`, null, null);
      await sleep(wait);
      wait = Math.min(wait * 1.5, 10_000);
    }
  }

  private async call<R>(method: string, path: string, body: unknown, opts: CallOptions = {}, idempotent = false): Promise<R> {
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': `cutoptim-engine-js/${VERSION}` };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    // One key for the whole call, retries included: a retried optimize returns the stored answer, never a second charge.
    if (idempotent) headers['Idempotency-Key'] = opts.idempotencyKey ?? newKey();
    const payload = body === undefined ? undefined : JSON.stringify(body);
    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      const onAbort = () => ctrl.abort();
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, body: payload, signal: ctrl.signal });
      } catch (e) {
        if (opts.signal?.aborted || attempt >= this.maxRetries) throw e;
        await sleep(this.backoff(attempt, null));
        continue;
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
      }
      const text = await res.text();
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* a proxy's 504 page is not JSON */ }
      if (res.ok) return json as R;
      const retryAfter = Number(res.headers.get('Retry-After')) || null;
      const code = typeof json?.error === 'string' ? json.error : `http_${res.status}`;
      const retryable = res.status === 429 || res.status === 503 || (res.status === 409 && code === 'idempotency_in_progress');
      if (retryable && attempt < this.maxRetries) { await sleep(this.backoff(attempt, retryAfter)); continue; }
      throw new CutOptimError(res.status, code, typeof json?.message === 'string' ? json.message : `HTTP ${res.status}`, json?.details ?? null, retryAfter);
    }
  }

  private backoff(attempt: number, retryAfterS: number | null): number {
    if (retryAfterS) return Math.min(retryAfterS, 60) * 1000;
    return Math.min(500 * 2 ** attempt, 8000);
  }
}

export default CutOptim;
