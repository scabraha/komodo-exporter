# Komodo Prometheus Exporter

A lightweight Prometheus exporter for the [Komodo](https://komo.do) deployment
platform. Polls the Komodo Core API for resource state and Docker container
inventory, and exposes it as Prometheus metrics suitable for Grafana
dashboards.

Komodo doesn't ship Prometheus metrics out of the box. This exporter fills
that gap. It's written in TypeScript so it can use the official
[`komodo_client`](https://www.npmjs.com/package/komodo_client) npm package
directly — no hand-maintained type definitions to drift out of sync.

## Tiered polling

Three independent loops, similar to the tautulli exporter, so a slow inventory
poll never affects the up/down signal:

| Tier | Default interval | What runs | Why |
|------|------------------|-----------|-----|
| **fast** | `15s` | `GetServersSummary` + `ListServers`, `ListAllDockerContainers`, `ListAlerts` (open only) | Drives `komodo_up` and the per-container metrics. |
| **slow** | `300s` (5 min) | Summaries + lists for stacks, deployments, builds, repos, procedures, syncs | Inventory churns slowly; no need to poll often. |
| **meta** | `1800s` (30 min) | `GetVersion` + `GetCoreInfo` | Doesn't change without a Komodo Core upgrade. |

Each tier reports failures independently via
`komodo_exporter_poll_failures_total{tier=...,step=...}`, so a slow-tier blip
doesn't flip `komodo_up`.

## Metrics

### Inventory (refreshed every `SLOW_POLL_INTERVAL`)

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `komodo_stacks_total` | Gauge | — | Total stacks |
| `komodo_stacks_by_state` | Gauge | `state` | Stacks grouped by aggregate state (`running`/`stopped`/`down`/`unhealthy`/`unknown`) |
| `komodo_stack_state` | Gauge | `name`, `server_id`, `state` | `1` when the stack is currently in this state |
| `komodo_deployments_total` | Gauge | — | Total deployments |
| `komodo_deployments_by_state` | Gauge | `state` | Deployments grouped by state |
| `komodo_deployment_state` | Gauge | `name`, `server_id`, `image`, `state` | `1` when the deployment is currently in this state |
| `komodo_deployment_update_available` | Gauge | `name`, `server_id`, `image` | `1` if a newer image exists at the same tag |
| `komodo_builds_total` | Gauge | — | Total builds |
| `komodo_builds_by_state` | Gauge | `state` | Builds grouped by state (`ok`/`failed`/`building`/`unknown`) |
| `komodo_build_last_built_timestamp_seconds` | Gauge | `name` | Unix timestamp of the most recent build |
| `komodo_repos_total` | Gauge | — | Total repos |
| `komodo_repos_by_state` | Gauge | `state` | Repos grouped by state |
| `komodo_procedures_total` | Gauge | — | Total procedures |
| `komodo_procedures_by_state` | Gauge | `state` | Procedures grouped by state |
| `komodo_procedure_last_run_timestamp_seconds` | Gauge | `name` | Unix timestamp of the most recent successful procedure run |
| `komodo_syncs_total` | Gauge | — | Total resource syncs |
| `komodo_syncs_by_state` | Gauge | `state` | Resource syncs grouped by state |

### Servers, containers, alerts (refreshed every `FAST_POLL_INTERVAL`)

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `komodo_servers_total` | Gauge | — | Total servers known to Komodo |
| `komodo_servers_by_state` | Gauge | `state` | Servers grouped by health (`healthy`/`unhealthy`/`disabled`/`warning`) |
| `komodo_server_state` | Gauge | `name`, `region` | Per-server state. Value: `1`=Ok, `0`=Disabled, `-1`=NotOk |
| `komodo_container_state` | Gauge | `server_id`, `container`, `image`, `state` | `1` when the container is currently in this Docker state |
| `komodo_container_created_timestamp_seconds` | Gauge | `server_id`, `container`, `image` | Unix timestamp when the container was created. Use `time() - komodo_container_created_timestamp_seconds` for uptime. |
| `komodo_open_alerts` | Gauge | `level`, `type` | Open (unresolved) Komodo alerts grouped by severity (`OK`/`WARNING`/`CRITICAL`) and `AlertData` type |

### Meta (refreshed every `META_POLL_INTERVAL`)

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `komodo_core_version_info` | Gauge | `version`, `title` | Always `1`; carries the connected Komodo Core version and instance title |

### Self-monitoring

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `komodo_up` | Gauge | — | `1` if the exporter can reach Komodo (driven by the fast tier) |
| `komodo_exporter_poll_duration_seconds` | Gauge | `tier` | Wall-clock duration of the last poll for each tier |
| `komodo_exporter_poll_failures_total` | Counter | `tier`, `step` | Poll steps that ended in failure |
| `komodo_exporter_last_successful_poll_timestamp_seconds` | Gauge | `tier` | Unix timestamp of the most recent successful poll for each tier |

> Container uptime is computed in PromQL from the `created` timestamp returned
> by Komodo (one API call regardless of container count). For most workloads
> this is equivalent to "started at" — containers are typically recreated, not
> restarted in place.

## Quick Start

### Docker Compose

```yaml
services:
  komodo-exporter:
    image: ghcr.io/scabraha/komodo-exporter:latest
    container_name: komodo-exporter
    restart: unless-stopped
    env_file: .env
    ports:
      - 9105:9105
```

`.env`:

```env
KOMODO_URL=https://komo.example.com
KOMODO_API_KEY=your_komodo_api_key
KOMODO_API_SECRET=your_komodo_api_secret
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `KOMODO_URL` | Yes | — | Base URL of the Komodo Core instance (e.g. `https://komo.example.com`) |
| `KOMODO_API_KEY` | Yes | — | API key generated in Komodo |
| `KOMODO_API_SECRET` | Yes | — | API secret generated in Komodo |
| `EXPORTER_PORT` | No | `9105` | Port to listen on |
| `FAST_POLL_INTERVAL` | No | `15` | Seconds between fast-tier polls |
| `SLOW_POLL_INTERVAL` | No | `300` | Seconds between slow-tier polls |
| `META_POLL_INTERVAL` | No | `1800` | Seconds between meta-tier polls |
| `REQUEST_TIMEOUT` | No | `30` | HTTP request timeout (seconds) |
| `LOG_LEVEL` | No | `INFO` | Log level (`DEBUG`, `INFO`, `WARN`, `ERROR`) |
| `LOG_FORMAT` | No | `text` | `text` for human-readable lines, `json` for one JSON object per line (Loki/CloudWatch friendly) |

## Creating an API Key

1. Log in to Komodo as an admin user.
2. Open your profile → **Settings** → **API Keys**.
3. Create a new key with a descriptive name (e.g. `prometheus-exporter`).
4. Copy the **key** and **secret** — the secret is only shown once.

The key only needs read access to the resources you want to expose. The
exporter never calls `/write` or `/execute`.

## Cardinality notes

`komodo_container_state`, `komodo_container_created_timestamp_seconds`,
`komodo_deployment_state`, and `komodo_stack_state` carry per-resource labels.
For typical homelab/small-team Komodo deployments (tens of servers, hundreds
of containers) this is fine. If you run thousands of containers, consider
dropping the `image` label via Prometheus relabelling, or scraping less
frequently.

`komodo_open_alerts` carries the `AlertData.type` discriminator (e.g.
`ServerCpu`, `ContainerStateChange`). Komodo defines a fixed set of alert
types, so this label has bounded cardinality.

## Observability

The exporter publishes self-monitoring metrics so you can alert on it being
broken (not just on Komodo being broken):

```promql
# Komodo is unreachable for 5+ minutes
max_over_time(komodo_up[5m]) == 0

# Last successful fast poll was > 5 minutes ago
time() - komodo_exporter_last_successful_poll_timestamp_seconds{tier="fast"} > 300

# Sustained poll failures by tier
sum by (tier) (rate(komodo_exporter_poll_failures_total[10m])) > 0

# Any deployment has an image update available
max(komodo_deployment_update_available) > 0

# Container has been up for more than 30 days (might want to update)
(time() - komodo_container_created_timestamp_seconds) > 30 * 86400

# Any open critical Komodo alert
sum(komodo_open_alerts{level="CRITICAL"}) > 0

# A stack flipped out of `running`
komodo_stack_state{state="running"} == 0
```

Logs use a single-line text format by default; switch to JSON via
`LOG_FORMAT=json` for log aggregators. Set `LOG_LEVEL=DEBUG` to see per-call
HTTP timings against the Komodo API.

## Prometheus Scrape Config

```yaml
scrape_configs:
  - job_name: "komodo"
    static_configs:
      - targets: ["komodo-exporter:9105"]
```

## Building & Testing

```bash
# Install dependencies
npm install

# Run tests
npm test

# Typecheck without emitting
npm run typecheck

# Build to dist/
npm run build

# Run locally (requires KOMODO_URL/KOMODO_API_KEY/KOMODO_API_SECRET)
npm start

# Build container image
docker build -t komodo-exporter .
```

PRs are gated by [`.github/workflows/test.yml`](.github/workflows/test.yml),
which runs the test suite on Node 20 and Node 22.

## Releases

Releases are automated by [release-please](https://github.com/googleapis/release-please)
using [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` → minor bump
- `fix:` / `perf:` → patch bump
- `feat!:` or `BREAKING CHANGE:` footer → major bump

On each push to `main`, release-please opens or updates a release PR with the
new version and changelog. Merging it tags the release and publishes a
multi-arch (`linux/amd64`, `linux/arm64`) image to
`ghcr.io/scabraha/komodo-exporter` with tags `vX.Y.Z`, `X.Y`, `X`, and
`latest`.

## License

MIT
