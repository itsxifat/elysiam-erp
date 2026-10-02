# Monitoring, alerts and the morning checks

What watches the ERP in staging and production, and what a person looks at each morning
(architecture §26; M14b, D-344, D-345).

## Health endpoints

| Endpoint            | Answers                                                                                                      | Used by                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `GET /health/live`  | 200 while the process runs                                                                                   | A first look                                                   |
| `GET /health/ready` | 200 when the database (as `erp_app`), the job queue's schema and Valkey answer; 503 naming the failing check | kamal-proxy before a release takes traffic; the uptime monitor |

Both are public and carry nothing but the check names. A 503's cause is in the API's log
(`readiness check failed`, with the check's name).

## Uptime monitor (set up at provisioning)

Any external monitor works (Cloudflare Health Checks on the zone, Better Stack, UptimeRobot);
it must run from outside the VMs:

- `https://api.<APP_DOMAIN>/health/ready`, every minute, from two regions, alert after two
  failures in a row. Expect status 200 and the body to contain `"status":"ok"`.
- `https://console.<APP_DOMAIN>/`, every five minutes, expect 200.
- Alerts to the owner's phone and the team channel.

The worker has no HTTP endpoint. It is watched through its effects: dead-lettered jobs reach
Sentry (below), the outbox's undeliverable events raise `job.failed`, and the morning checks
look at its log.

## Errors: Sentry (optional, off without `SENTRY_DSN`)

One Sentry project per environment; its DSN in the secret manager. The server reports:

- every 5xx a request ends in (`kind: http`, with the error code and method);
- every job that spent its retries (`kind: job`, with the queue and code);
- a process that fails to boot (`kind: boot`).

Errors only: Sentry traces nothing (OpenTelemetry does). Every event is scrubbed before it
leaves: no cookies, headers, bodies, query strings or user; credential-named fields
removed; phone numbers masked. Breadcrumbs are off.

Alert rules in Sentry: a new issue → the team channel; more than 20 events in 5 minutes →
the owner's phone. To check the wiring after setup, send one test event from a running
worker container, through the same seam the application uses:

```sh
kamal app exec $K --roles worker --reuse   "node --import ./dist/instrument.js --input-type=module -e \"const m = await import('./dist/platform/observability/errors.js'); m.reportError(new Error('sentry wiring test'), { kind: 'test' }); await m.shutdownObservability();\""
```

## Traces and metrics: OpenTelemetry (optional, off without an endpoint)

Set `OTEL_EXPORTER_OTLP_ENDPOINT` in `deploy.<env>.yml` and the collector's auth header as
`OTEL_EXPORTER_OTLP_HEADERS` in the secrets. The SDK reads the standard `OTEL_*` variables
(protocol `http/protobuf` by default, metrics every 60 s, `OTEL_TRACES_SAMPLER` if you want
to sample). Spans cover incoming requests (not the health probes) and every outbound call
(couriers, SMS, Meta). URLs in spans keep their path with phones masked and lose their
query string. Services are named `elysium-api` and `elysium-worker`.

## Logs

pino JSON on stdout, kept by Docker (50 MB × 5 per container, `deploy.yml`):

```sh
kamal app logs $K --roles api --since 1h
kamal app logs $K --roles worker --grep 'dead-lettered'
```

Phone numbers are masked in every line and credential-named fields never appear
(`apps/server/src/platform/logging/logger.ts`, tested). Ship them to a log service later if
the client wants search beyond `kamal app logs`.

## Alert rules (§26)

| Signal                | Where it shows                                                                       | Threshold, then who               |
| --------------------- | ------------------------------------------------------------------------------------ | --------------------------------- |
| API down or not ready | Uptime monitor on `/health/ready`                                                    | 2 failures → owner's phone        |
| Error-rate spike      | Sentry                                                                               | 20 events / 5 min → owner's phone |
| Job failures          | Sentry `kind: job`; `GET /v1/jobs/failed` (super admin); `job.failed` in the console | any → team channel                |
| Stock drift           | The nightly reconciliation's alert (`inventory.reconcile`)                           | any → the brand's org admin       |
| Settlement exceptions | **Courier → Settlements**, exceptions                                                | any → the brand's accounts user   |
| Slow queries          | The provider's query insights (statements over 500 ms)                               | weekly review                     |
| Backup missing        | The second provider's bucket has no file from last night                             | any → owner                       |
| Disk on a VM          | The provider's VM monitoring                                                         | 80% → team channel                |

## The morning checks (pilot and after)

1. `/health/ready` green; the uptime monitor shows no overnight failures.
2. Sentry: no new issue, or each new one has an owner.
3. Failed jobs: `GET /v1/jobs/failed` empty, or each entry explained.
4. Courier: **Courier → Stuck** short; yesterday's settlements fetched.
5. Last night's dump present at the second provider.
6. The worker's log since midnight: `kamal app logs $K --roles worker --since 24h --grep 'error'`.
