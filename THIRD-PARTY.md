<!--
SPDX-FileCopyrightText: 2026 Yle
SPDX-License-Identifier: CC-BY-4.0
-->

# Third-party components

## In this repository

| Component | Version | Licence | Where | Source |
|---|---|---|---|---|
| OGraf DevTool (portions of its renderer) | 2025 | MIT | `runtime/render.js` (adapted) | https://github.com/SuperFlyTV/ograf-devtool |
| OGraf DevTool "headline" sample graphic | 2025 | MIT | `fixtures/graphics/headline` (test fixture, own licence file) | https://github.com/SuperFlyTV/ograf-devtool |
| lottie-web | 5.12.2 | MIT | inside the headline fixture | https://github.com/airbnb/lottie-web |

## npm dependencies

| Package | Licence | Use |
|---|---|---|
| `puppeteer-core` | Apache-2.0 | drives headless Chromium over the DevTools protocol |
| `pngjs` | MIT | blank tail frames, interlace weaving, transparency checks |
| `puppeteer` (development only) | Apache-2.0 | downloads a Chrome for local development and tests; not in the Docker image |

Their own dependencies are MIT, Apache-2.0, ISC and BSD-3-Clause (`npx license-checker-rseidelsohn --production --summary`).

## In the Docker image (Debian packages, not in this repository)

The image is built from `node:22-bookworm-slim` and installs these Debian packages unmodified. Their licences and sources come with them under `/usr/share/doc/<package>/copyright`.

| Package | Licence (main) | Note |
|---|---|---|
| Node.js (base image) | MIT | |
| `chromium` | BSD-3-Clause and others | Chromium's bundled components keep their own licences |
| `ffmpeg` | LGPL-2.1+ / GPL-2+ | Debian builds FFmpeg with GPL components (for example x264), so the binaries in the image are GPL. The renderer only runs `ffmpeg` as a separate program; it does not link it. Whoever redistributes the image passes on the GPL's source offer, which Debian's source archive covers. |
| `tini` | MIT | init process |
| `fonts-liberation`, `fonts-noto-core`, `fonts-noto-cjk`, `fonts-noto-color-emoji` | SIL OFL 1.1 | fallback fonts for graphics that don't bring their own |
| `fonts-dejavu-core` | Bitstream Vera / public domain | |
