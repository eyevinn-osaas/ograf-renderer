#!/bin/sh
# SPDX-FileCopyrightText: 2026 Yle
# SPDX-License-Identifier: Apache-2.0

# Run the tests inside the Docker image, against its Chromium, FFmpeg and fonts:
#   docker run --rm -v "$PWD:/src:ro" --tmpfs /tmp --shm-size=1g ograf-renderer sh /src/tools/test-in-image.sh
# The checkout is copied next to the image's own node_modules (no npm install, no network needed).
set -e
work=$(mktemp -d)
cp -r /src/bin /src/src /src/runtime /src/ui /src/fixtures /src/test /src/package.json "$work/"
ln -s /app/node_modules "$work/node_modules"
cd "$work"
node --test --test-reporter=spec --test-concurrency=1 test/core.test.js test/unit.test.js test/render.test.js test/service.test.js test/editor.test.js
