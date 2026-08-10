import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { renderCloudflaredConfig } from '../ops/authoritative-node/render-cloudflared-config.mjs'

const SERVICE_PATH = new URL('../ops/authoritative-node/ch-folio-authoritative-node.service', import.meta.url)
const INSTALL_PATH = new URL('../ops/authoritative-node/install-staging.sh', import.meta.url)
const NAMED_ACCEPTANCE_PATH = new URL('../.github/workflows/authoritative-node-named-staging.yml', import.meta.url)

test('systemd unit exposes Node authority on host IPv4 port 8080 for the existing Docker Tunnel', async () =>
{
    const unit = await readFile(SERVICE_PATH, 'utf8')

    assert.match(unit, /^WorkingDirectory=\/opt\/ch-folio-authoritative-staging\/authoritative-node$/mu)
    assert.match(unit, /^EnvironmentFile=\/etc\/ch-folio-authoritative-staging\.env$/mu)
    assert.match(unit, /^Environment=HOST=0\.0\.0\.0$/mu)
    assert.match(unit, /^Environment=PORT=8080$/mu)
    assert.match(unit, /^ExecStart=\/usr\/bin\/env npm start$/mu)
    assert.match(unit, /^Restart=on-failure$/mu)
    assert.doesNotMatch(unit, /AUTHORITATIVE_BENCHMARK_TOKEN=/u)
})

test('Tunnel renderer emits one staging hostname route and a final 404 catch-all without secrets', () =>
{
    const yaml = renderCloudflaredConfig({
        hostname: 'node-staging.testnb.me',
        tunnelId: '123e4567-e89b-42d3-a456-426614174000',
        credentialsFile: '/etc/cloudflared/123e4567-e89b-42d3-a456-426614174000.json',
    })

    assert.equal(yaml, [
        'tunnel: 123e4567-e89b-42d3-a456-426614174000',
        'credentials-file: /etc/cloudflared/123e4567-e89b-42d3-a456-426614174000.json',
        'ingress:',
        '  - hostname: node-staging.testnb.me',
        '    service: http://127.0.0.1:8080',
        '  - service: http_status:404',
        '',
    ].join('\n'))
    assert.doesNotMatch(yaml, /benchmark|token|secret/iu)
})

test('Tunnel renderer rejects unsafe hostnames, tunnel IDs, and relative credential paths', () =>
{
    const valid = {
        hostname: 'node-staging.testnb.me',
        tunnelId: '123e4567-e89b-42d3-a456-426614174000',
        credentialsFile: '/etc/cloudflared/tunnel.json',
    }

    assert.throws(() => renderCloudflaredConfig({ ...valid, hostname: 'https://bad.example' }), /hostname/u)
    assert.throws(() => renderCloudflaredConfig({ ...valid, hostname: 'bad host.example' }), /hostname/u)
    assert.throws(() => renderCloudflaredConfig({ ...valid, tunnelId: 'not-a-uuid' }), /tunnel/u)
    assert.throws(() => renderCloudflaredConfig({ ...valid, credentialsFile: './tunnel.json' }), /absolute/u)
})

test('staging installer is fail-closed and leaves the service stopped', async () =>
{
    const script = await readFile(INSTALL_PATH, 'utf8')

    assert.match(script, /EUID/u)
    assert.match(script, /node --version/u)
    assert.match(script, /Node\.js 24/u)
    assert.match(script, /UNIT_NAME=ch-folio-authoritative-node\.service/u)
    assert.match(script, /\/opt\/ch-folio-authoritative-staging/u)
    assert.match(script, /--exclude=.*\.git/u)
    assert.match(script, /--exclude=.*node_modules/u)
    assert.match(script, /npm ci/u)
    assert.match(script, /npm ci --prefix authoritative-node --ignore-scripts/u)
    assert.match(script, /systemctl daemon-reload/u)
    assert.match(script, /systemctl stop "\$\{UNIT_NAME\}"/u)
    assert.doesNotMatch(script, /systemctl (?:start|restart|enable --now) (?:"\$\{UNIT_NAME\}"|ch-folio-authoritative-node)/u)
})

test('public staging acceptance reuses hk-test existing Tunnel and keeps the eight-client ten-minute gate', async () =>
{
    const workflow = await readFile(NAMED_ACCEPTANCE_PATH, 'utf8')

    assert.match(workflow, /^\s*workflow_dispatch:\s*$/mu)
    assert.match(workflow, /STAGING_HOSTNAME:\s*hk-test\.testnb\.me/u)
    assert.match(workflow, /HOST=0\.0\.0\.0/u)
    assert.match(workflow, /PORT=8080/u)
    assert.match(workflow, /https:\/\/\$\{STAGING_HOSTNAME\}\/healthz/u)
    assert.match(workflow, /WSS_URL="wss:\/\/\$\{STAGING_HOSTNAME\}\/ws"/u)
    assert.match(workflow, /--clients=8/u)
    assert.match(workflow, /--seconds=600/u)
    assert.match(workflow, /node-authoritative-named-staging-acceptance/u)
    assert.doesNotMatch(workflow, /AUTHORITATIVE_STAGING_TUNNEL_TOKEN/u)
    assert.doesNotMatch(workflow, /cloudflared-linux-amd64/u)
    assert.doesNotMatch(workflow, /tunnel .*run .*--token/u)
    assert.doesNotMatch(workflow, /continue-on-error/u)
    assert.doesNotMatch(workflow, /VITE_MULTIPLAYER_PROTOCOL|VITE_SERVER_URL/u)
})
