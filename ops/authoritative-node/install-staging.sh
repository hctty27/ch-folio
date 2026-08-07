#!/usr/bin/env bash
set -euo pipefail

INSTALL_ROOT=/opt/ch-folio-authoritative-staging
ENV_FILE=/etc/ch-folio-authoritative-staging.env
UNIT_NAME=ch-folio-authoritative-node.service
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

if [[ "${EUID}" -ne 0 ]]; then
  echo "install-staging.sh must run as root" >&2
  exit 1
fi

for command in node npm rsync install systemctl; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "required command is missing: ${command}" >&2
    exit 1
  fi
done

NODE_VERSION="$(node --version)"
if [[ ! "${NODE_VERSION}" =~ ^v24\. ]]; then
  echo "Node.js 24 is required; found ${NODE_VERSION}" >&2
  exit 1
fi

if ! id github-runner >/dev/null 2>&1; then
  echo "required service user github-runner does not exist" >&2
  exit 1
fi

systemctl stop "${UNIT_NAME}" 2>/dev/null || true
rm -rf "${INSTALL_ROOT}"
install -d -m 0755 -o github-runner -g github-runner "${INSTALL_ROOT}"

rsync -a --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='authoritative-node/node_modules' \
  --exclude='multiplayer-worker/node_modules' \
  --exclude='dist' \
  --exclude='.wrangler' \
  "${SOURCE_ROOT}/" "${INSTALL_ROOT}/"

cd "${INSTALL_ROOT}"
npm ci
npm ci --prefix authoritative-node --ignore-scripts

chown -R github-runner:github-runner "${INSTALL_ROOT}"
install -D -m 0644 \
  "${INSTALL_ROOT}/ops/authoritative-node/${UNIT_NAME}" \
  "/etc/systemd/system/${UNIT_NAME}"

if [[ ! -e "${ENV_FILE}" ]]; then
  install -m 0600 /dev/null "${ENV_FILE}"
else
  chown root:root "${ENV_FILE}"
  chmod 0600 "${ENV_FILE}"
fi

systemctl daemon-reload
systemctl stop "${UNIT_NAME}" 2>/dev/null || true

echo "Installed ${UNIT_NAME} at ${INSTALL_ROOT}; service remains stopped pending health preflight."
