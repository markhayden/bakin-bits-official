---
title: API Integration
tags: [dev, api, integration, resilience]
defaultEnabled: false
---

# API Integration

The deep end of Patch's work: wiring two systems together so the seam doesn't leak.
This is durable craft — language- and SDK-agnostic. The voice is the same as dev-discipline:
conservative, no clever-but-fragile.

## Auth: pick the right mechanism, store it right

- **API keys** for service-to-service where the caller is trusted. Simplest; rotate-able.
- **OAuth** when acting on behalf of a *user* — you need their grant, not your own key. Store
  the refresh token, not the access token; refresh on 401, don't pre-emptively.
- **Signed requests / HMAC** when the provider requires it (webhooks back, some payment APIs).
- Secrets live in env vars or a gitignored `.env`, never in tracked files, never in logs. If a
  secret would print in an error or a request dump, redact it at the boundary.

## Resilience: assume the network hates you

- **Timeouts on every call.** A request with no timeout is a hang waiting to happen. Set a
  connect timeout and a read timeout; default to seconds, not minutes.
- **Retry only what's safe.** Retry idempotent calls (GET, PUT, DELETE) and explicit-idempotent
  POSTs. Never blind-retry a non-idempotent POST — you'll double-charge / double-send.
- **Exponential backoff with jitter.** `delay = base * 2^attempt + random()`. Jitter prevents a
  thundering herd when many clients retry in lockstep. Cap the attempts and the max delay.
- **Idempotency keys.** For "create" calls that matter (payments, orders), send a client-generated
  idempotency key so a retry is a no-op, not a duplicate. Persist the key with the request.
- **Fail closed on partial writes.** If step 2 of 3 fails, don't leave the remote in a half-state
  silently — either roll back, or record the incomplete state so a reconciler can finish it.

## Rate limits: respect them before they punish you

- Read the provider's documented limits and stay under them deliberately — don't discover them
  via 429s in production.
- On `429`, honor `Retry-After` if present; otherwise back off. Treat sustained 429s as
  backpressure: slow the producer, don't just hammer the retry loop.
- Batch and paginate to reduce call volume; cache responses that don't change per-request.

## Webhooks: you're now the server

- **Verify the signature** on every inbound webhook before trusting the body. Unsigned/unverified
  webhooks are an open RCE-adjacent door.
- **Guard against replay** — check the timestamp/nonce; reject anything older than a small window.
- **Ack fast, process async.** Return `2xx` immediately, then do the work on a queue. Providers
  retry on slow/failed responses, so slow synchronous processing causes duplicate deliveries.
- Assume **at-least-once** delivery: make handlers idempotent on the event id.

## Pagination & partial failure

- Use the provider's cursor/continuation token; don't assume offset pagination is stable under
  concurrent writes.
- Make long syncs **resumable** — checkpoint the cursor so a crash restarts from the last page,
  not the first.
- A page that fails mid-sync shouldn't discard the pages already processed; record progress.

## Observability: you can't fix what you can't see

- Log each external call: target, status, latency, and a correlation id — with secrets redacted.
- Surface the *provider's* error body, not just your wrapper's "request failed." The remote
  usually tells you exactly what's wrong.
- Alert on error-rate and latency spikes per integration, not just on hard outages — degraded is
  the failure mode you'll actually hit.
