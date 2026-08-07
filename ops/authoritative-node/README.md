# Node authoritative staging operations

This directory is for the non-production multiplayer protocol-v2 staging server only. It does not change production Pages variables, production routing, or protocol v1.

## Runtime layout

- Install root: `/opt/ch-folio-authoritative-staging`
- Node service: `ch-folio-authoritative-node.service`
- Node bind address: `127.0.0.1:8080`
- Secret environment file: `/etc/ch-folio-authoritative-staging.env`
- Tunnel config: `/etc/cloudflared/ch-folio-authoritative-staging.yml`

The Node process performs the production 600-tick physics warmup before it starts listening for HTTP/WebSocket traffic. A warmup failure is a startup failure.

## Required deployment inputs

Set these only in the deployment shell or secret store; do not commit them:

- `AUTHORITATIVE_STAGING_HOSTNAME`
- `AUTHORITATIVE_STAGING_TUNNEL_ID`
- `AUTHORITATIVE_STAGING_TUNNEL_CREDENTIALS_FILE`
- `AUTHORITATIVE_BENCHMARK_TOKEN` (at least 32 characters)

The benchmark token must never be placed in the public hostname, URL query string, Tunnel YAML, systemd unit, repository, or CI log.

## Install candidate

Run from the exact staging checkout:

```bash
sudo ops/authoritative-node/install-staging.sh
```

The installer requires Node.js 24, copies the checkout to `/opt/ch-folio-authoritative-staging`, performs clean root and Node installs, installs the systemd unit, runs `systemctl daemon-reload`, and deliberately leaves the service stopped.

Create or replace the host-only secret file without echoing the value to logs:

```bash
sudo install -m 0600 /dev/null /etc/ch-folio-authoritative-staging.env
# Write exactly one line: AUTHORITATIVE_BENCHMARK_TOKEN=<secret>
```

## Node health preflight

Start Node only after installation and secret provisioning:

```bash
sudo systemctl start ch-folio-authoritative-node.service
curl --fail --silent --show-error http://127.0.0.1:8080/healthz
sudo systemctl status ch-folio-authoritative-node.service --no-pager
```

A failed loopback health check blocks Tunnel exposure.

## Render and validate the Tunnel config

Render from validated runtime inputs:

```bash
sudo install -d -m 0755 /etc/cloudflared
node ops/authoritative-node/render-cloudflared-config.mjs \
  | sudo tee /etc/cloudflared/ch-folio-authoritative-staging.yml >/dev/null
```

Validate the exact config before starting or restarting `cloudflared`:

```bash
cloudflared --config /etc/cloudflared/ch-folio-authoritative-staging.yml tunnel ingress validate
```

The rendered ingress always contains exactly one public hostname route to `http://127.0.0.1:8080` and a final `http_status:404` catch-all.

Before installing a cloudflared system service, inspect the host for an existing service and do not overwrite an unrelated Tunnel. When a dedicated service is appropriate, use the explicit config path:

```bash
sudo cloudflared --config /etc/cloudflared/ch-folio-authoritative-staging.yml service install
sudo systemctl restart cloudflared
```

Do not restart the Tunnel during smoke or the 600-second benchmark because existing long-lived WebSocket connections would be interrupted.

## Public validation

After public HTTPS `/healthz` succeeds, run the protocol smoke with the benchmark token inherited from the environment:

```bash
npm run smoke:authoritative-node-staging -- \
  --url="wss://${AUTHORITATIVE_STAGING_HOSTNAME}/ws"
```

Then run exactly eight clients for exactly 600 seconds:

```bash
AUTHORITATIVE_BENCHMARK_URL="wss://${AUTHORITATIVE_STAGING_HOSTNAME}/ws" \
AUTHORITATIVE_BENCHMARK_ROOM="node-staging-600s" \
AUTHORITATIVE_BENCHMARK_COMMIT="$(git rev-parse HEAD)" \
npm run benchmark:authoritative:node
```

Any service restart, Tunnel restart, disconnect, persistent backlog/divergence, scheduler overload, queue depth above three, p95 above 8 ms, p99 above 12 ms, or maximum tick above 16.67 ms blocks Task 19.
