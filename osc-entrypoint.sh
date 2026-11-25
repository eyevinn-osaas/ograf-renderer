#!/bin/bash
# SPDX-FileCopyrightText: 2026 Eyevinn Technology AB
# SPDX-License-Identifier: Apache-2.0

# Entrypoint for Eyevinn Open Source Cloud (OSC).
#  - PORT is read by the service itself (default 8080).
#  - OSC_HOSTNAME becomes OGRAF_PUBLIC_URL (used in editor links), unless that is set.
#  - The graphics library and the renders live on the persistent volume at /data.
#  - Runs the service as the unprivileged node user, with tini as PID 1.
set -e

export PORT="${PORT:-8080}"

if [ -z "${OGRAF_PUBLIC_URL:-}" ] && [ -n "${OSC_HOSTNAME:-}" ]; then
	export OGRAF_PUBLIC_URL="https://${OSC_HOSTNAME}"
fi

# The API is reachable from the internet on OSC and graphics are third-party code that the
# service runs in Chromium, so an open API is refused.
if [ -z "${OGRAF_API_TOKEN:-}" ]; then
	echo "[osc-entrypoint] OGRAF_API_TOKEN is not set. Refusing to start with an open API." >&2
	exit 1
fi

# Kubernetes has no /.dockerenv, which is what the service looks for to turn Chromium's own
# sandbox off. The sandbox needs user namespaces that the platform does not allow, so say it here.
export OGRAF_CHROME_SANDBOX="${OGRAF_CHROME_SANDBOX:-0}"

export OGRAF_GRAPHICS_DIR="${OGRAF_GRAPHICS_DIR:-/data/graphics}"
export OGRAF_OUTPUT_DIR="${OGRAF_OUTPUT_DIR:-/data/renders}"

if [ "$(id -u)" = "0" ]; then
	# A freshly mounted volume is owned by root.
	mkdir -p "$OGRAF_GRAPHICS_DIR" "$OGRAF_OUTPUT_DIR"
	chown node:node "$OGRAF_GRAPHICS_DIR" "$OGRAF_OUTPUT_DIR"
	[ -d /data ] && chown node:node /data
	export HOME=/home/node
	exec setpriv --reuid=node --regid=node --init-groups /usr/bin/tini -- "$@"
fi

mkdir -p "$OGRAF_GRAPHICS_DIR" "$OGRAF_OUTPUT_DIR"
exec /usr/bin/tini -- "$@"
