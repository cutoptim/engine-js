<p align="center">
  <a href="https://cutoptim.com/engine"><img src="https://raw.githubusercontent.com/cutoptim/engine-js/main/.github/logo.png" width="88" height="88" alt="CutOptim"></a>
</p>

<h1 align="center">CutOptim Engine API — TypeScript SDK</h1>

<p align="center">
  Cutting optimization over HTTPS: <b>2D panels</b>, <b>1D linear</b>, <b>timber</b> and <b>true-shape nesting</b>.<br>
  Deterministic plans, saw-ready cut sequences — typed end to end.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@cutoptim/engine"><img alt="npm" src="https://img.shields.io/npm/v/@cutoptim/engine?color=f0c040&labelColor=0d0f14&label=npm"></a>
  <a href="https://github.com/cutoptim/engine-js/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/cutoptim/engine-js/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Node 18+" src="https://img.shields.io/badge/node-%E2%89%A518-f0c040?labelColor=0d0f14">
  <img alt="Zero dependencies" src="https://img.shields.io/badge/dependencies-0-f0c040?labelColor=0d0f14">
  <a href="https://github.com/cutoptim/engine-js/blob/main/LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-f0c040?labelColor=0d0f14"></a>
</p>

<p align="center">
  <a href="https://cutoptim.com/engine/reference/quickstart">Quickstart</a> ·
  <a href="https://cutoptim.com/engine/reference">API reference</a> ·
  <a href="https://cutoptim.com/engine/reference/guides/webhooks">Webhooks</a> ·
  <a href="https://cutoptim.com/engine/reference/changelog">Changelog</a> ·
  <a href="https://cutoptim.com/dashboard#api-keys">Get an API key</a>
</p>

---

## Why this SDK

- **Typed from the contract.** Every request and response type is generated from the [OpenAPI 3.1 document](https://cutoptim.com/engine/openapi.json) — your editor knows every field, and its tooltip is the reference text.
- **Zero dependencies.** The built-in `fetch` and Web Crypto: Node 18+, Deno, Bun, edge runtimes and the browser.
- **Retries that never cost twice.** Every optimize call carries an `Idempotency-Key`; a retried call returns the stored answer instead of a second charge.
- **Async jobs without the boilerplate.** `waitForJob()` polls the `max` engine for you — or let a webhook tell you.
- **Webhook verification built in.** `verifyWebhook()` checks the signature on the raw body, with the replay window and secret rotation handled.

## Install

```bash
npm install @cutoptim/engine
```

A free **test key** (`co_test_…`, never billed) is enough to build the whole integration — create one on your [dashboard](https://cutoptim.com/dashboard#api-keys).

## Quickstart

```ts
import { CutOptim } from '@cutoptim/engine';

const client = new CutOptim({ apiKey: process.env.CUTOPTIM_KEY });

const plan = await client.optimize2d({
  parts: [
    { name: 'Side', w: 720, h: 560, qty: 2 },
    { name: 'Shelf', w: 764, h: 540, qty: 3, rotatable: false },
  ],
  stock: [{ w: 2800, h: 2070, price: 48 }],
  options: { kerf: 4 },
});

if (!CutOptim.isJobAccepted(plan)) {
  console.log(`${plan.metrics.sheetCount} sheet(s), ${plan.metrics.yieldPct}% yield`);
  for (const sheet of plan.sheets) {
    for (const p of sheet.parts) console.log(p.name, p.x, p.y, p.w, p.h, p.rotated ? '↻' : '');
  }
}
```

The same input always returns the same plan — cache it, test against it, quote from it.

## Every mode

```ts
// 1D linear — bars, profiles, tubes
const bars = await client.optimize1d({
  parts: [{ name: 'Rail', length: 1200, qty: 6 }],
  stock: [{ length: 6000 }],
});
console.log(bars.metrics.rodCount, bars.metrics.yieldPct);

// Timber — lengths cut from beams of a given cross-section (sw × sh)
const timber = await client.optimizeWood({
  parts: [{ name: 'Joist', sw: 45, sh: 145, length: 3600, qty: 4 }],
  stock: [{ sw: 45, sh: 145, length: 4800 }],
});

// True-shape nesting — polygons (or SVG/DXF sources) on sheets
const nest = await client.optimizeNest({
  parts: [{ name: 'Bracket', polygon: [[0, 0], [120, 0], [120, 40], [40, 120], [0, 120]], qty: 10 }],
  stock: [{ w: 1000, h: 500 }],
});
if (!CutOptim.isJobAccepted(nest)) console.log(nest.metrics.sheetCount, nest.metrics.density);
```

Check a request without spending a call — the validate endpoints need no key and give the same verdict:

```ts
const check = await new CutOptim().validate2d(request); // { valid: true, warnings: [...] } or a typed 400
```

## Async `max` jobs

`engine: "max"` searches harder (seconds to a minute) and answers `202` with a job id instead of a plan:

```ts
const accepted = await client.optimize2d({ ...request, engine: 'max' });
if (CutOptim.isJobAccepted(accepted)) {
  const job = await client.waitForJob(accepted.jobId, { timeoutMs: 5 * 60_000 }); // polls GET /v1/jobs/{id}, no quota
  if (job.status === 'succeeded') console.log(job.result);
}
```

## Webhooks

Instead of polling, register an endpoint on your [dashboard](https://cutoptim.com/dashboard#api-webhooks) and receive a signed `POST` (`job.succeeded` / `job.failed`) when a `max` job finishes. Verify it on the **raw** body:

```ts
// Express
import express from 'express';
import { verifyWebhook } from '@cutoptim/engine';

app.post('/cutoptim/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const ok = await verifyWebhook(req.body, req.get('CutOptim-Signature'), process.env.CUTOPTIM_WEBHOOK_SECRET!);
  if (!ok) return res.sendStatus(400);
  res.sendStatus(204);                     // answer within 10 s, then do the work
  const event = JSON.parse(req.body.toString('utf8'));
  // deduplicate on event.id — delivery is at least once
});
```

```ts
// Next.js route handler / any Web-standard runtime
export async function POST(request: Request) {
  const raw = await request.text();
  if (!(await verifyWebhook(raw, request.headers.get('CutOptim-Signature'), process.env.CUTOPTIM_WEBHOOK_SECRET!))) {
    return new Response(null, { status: 400 });
  }
  const event = JSON.parse(raw);           // { id, type, created, env, data: { jobId, mode, engine, status } }
  return new Response(null, { status: 204 });
}
```

During a secret rotation both secrets sign for 24 hours — pass both: `verifyWebhook(raw, header, [newSecret, oldSecret])`.

## Retries and idempotency

| Situation | What the client does |
|---|---|
| `429 busy`, `503`, network error | retries (2× by default), waiting `Retry-After` when the API sends it |
| `409 idempotency_in_progress` | retries — the first request is still running; the retry receives its answer |
| any optimize call | sends an `Idempotency-Key` (a fresh UUID, or yours) — the **same** key on every retry |

Pass your own key to make retries safe across process restarts too:

```ts
await client.optimizeNest(request, { idempotencyKey: `order-${orderId}` });
```

Within 24 hours the same key and request return the stored answer — not charged again, and a `max` job is not queued twice.

## Errors

Any non-2xx answer throws a `CutOptimError`:

```ts
import { CutOptimError } from '@cutoptim/engine';

try {
  await client.optimize2d(request);
} catch (e) {
  if (e instanceof CutOptimError) {
    console.log(e.status, e.code, e.details, e.retryAfter); // branch on e.code, never on e.message
  }
}
```

| `code` | Status | Meaning |
|---|---|---|
| `invalid_request` | 400 | the request is wrong — `details.path` names the field; never charged |
| `unauthorized` | 401 | missing or unknown API key |
| `quota_exceeded` | 402 | the account's monthly quota is used up — `retryAfter` counts to the reset |
| `key_revoked` | 403 | the key is revoked, or the API subscription is not active |
| `idempotency_conflict` | 409 | the key was used for a different request — use a new key |
| `too_large` | 413 | an input cap was exceeded (parts, rows, body size) |
| `busy` | 429 | at capacity right now — retried automatically |
| `service_unavailable` | 503 | an engine is not available on this deployment |
| `solve_timeout` | 504 | the nesting solve ran out of time |
| `timeout` | — | `waitForJob()` gave up waiting (the job keeps running) |

The full list, with what to do for each, is on the [errors page](https://cutoptim.com/engine/reference/errors).

## Configuration

```ts
new CutOptim({
  apiKey: 'co_live_…',                   // not needed for health() and validate*()
  baseUrl: 'https://api.cutoptim.com',   // default
  maxRetries: 2,                         // 429 / 503 / 409 in-progress / network errors
  timeoutMs: 30_000,                     // per request
  fetch: customFetch,                    // optional: your own fetch implementation
});
```

## API coverage

| Method | Endpoint | Quota |
|---|---|---|
| `optimize2d(req, opts?)` | `POST /v1/optimize/2d` | 1 call |
| `optimize1d(req, opts?)` | `POST /v1/optimize/1d` | 1 call |
| `optimizeWood(req, opts?)` | `POST /v1/optimize/wood` | 1 call |
| `optimizeNest(req, opts?)` | `POST /v1/optimize/nest` | 1 call |
| `validate2d` · `validate1d` · `validateWood` · `validateNest` | `POST /v1/validate/*` | free, no key |
| `importNest(req)` | `POST /v1/import/nest` | free (key required) |
| `getJob(id)` · `waitForJob(id)` | `GET /v1/jobs/{id}` | free |
| `usage()` | `GET /v1/usage` | free |
| `health()` | `GET /v1/health` | free, no key |

## Versioning

The SDK follows semver. The API is `v1` and only grows within it: a new field, endpoint or option arrives as a **minor** SDK release with the regenerated types; nothing you use today is removed or narrowed. See [versioning and stability](https://cutoptim.com/engine/reference/versioning) and the [API changelog](https://cutoptim.com/engine/reference/changelog) (also as RSS).

## Support

- Questions and bugs: [GitHub issues](https://github.com/cutoptim/engine-js/issues) or [support@cutoptim.com](mailto:support@cutoptim.com)
- Limits and quotas: [cutoptim.com/engine/reference/limits](https://cutoptim.com/engine/reference/limits)

This repository is published from the CutOptim monorepo; pull requests are welcome and applied upstream.

## License

[MIT](https://github.com/cutoptim/engine-js/blob/main/LICENSE) © CutOptim
