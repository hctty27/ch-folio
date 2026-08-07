import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { renderCloudflaredConfig } from '../ops/authoritative-node/render-cloudflared-config.mjs'

const SERVICE_PATH = new URL('../ops/authoritative-node/ch-folio-authoritative-node.service', import.meta.url)
const INSTALL_PATH = new URL('../ops/authoritative-node/install-staging.sh', import.meta.url)

test('systemd unit binds Node authority to loopback and loads only the host secret environment', async () =>
{
    const unit = await readFile(SERVICE_PATH, 'utf8')

    assert.match(unit, /^WorkingDirectory=\/opt\/ch-folio-authoritative-staging\/authoritative-node$/mu)
    assert.match(unit, /^EnvironmentFile=\/etc\/ch-folio-authoritative-staging\.env$/mu)
    assert.match(unit, /^Environment=HOST=127\.0\.0\.1$/mu)
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
    assert.match(script, /\/opt\/ch-folio-authoritative-staging/u)
    assert.match(script, /--exclude=.*\.git/u)
    assert.match(script, /--exclude=.*node_modules/u)
    assert.match(script, /npm ci/u)
    assert.match(script, /npm ci --prefix authoritative-node --ignore-scripts/u)
    assert.match(script, /systemctl daemon-reload/u)
    assert.match(script, /systemctl stop ch-folio-authoritative-node\.service/u)
    assert.doesNotMatch(script, /systemctl (?:start|restart|enable --now) ch-folio-authoritative-node/u)
})
