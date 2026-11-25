# SPDX-FileCopyrightText: 2026 Yle
# SPDX-License-Identifier: Apache-2.0

# OGraf renderer: headless Chromium + FFmpeg + the render service.
#   docker build -t ograf-renderer .
#   docker run -p 8080:8080 -e OGRAF_API_TOKEN=change-me -v ograf-data:/data ograf-renderer

FROM node:22-bookworm-slim

# Chromium and FFmpeg from Debian (security updates through the base image), fonts for graphics
# that don't bring their own, tini as PID 1 so Chromium's child processes are reaped.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		chromium \
		ffmpeg \
		tini \
		ca-certificates \
		fonts-liberation \
		fonts-dejavu-core \
		fonts-noto-core \
		fonts-noto-cjk \
		fonts-noto-color-emoji \
		fontconfig \
	&& rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
	PUPPETEER_SKIP_DOWNLOAD=1 \
	OGRAF_CHROME=/usr/bin/chromium \
	OGRAF_GRAPHICS_DIR=/data/graphics \
	OGRAF_OUTPUT_DIR=/data/renders \
	PORT=8080

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY bin ./bin
COPY src ./src
COPY runtime ./runtime
COPY ui ./ui
COPY LICENSE NOTICE THIRD-PARTY.md ./
COPY LICENSES ./LICENSES

RUN mkdir -p /data/graphics /data/renders && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
	CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "bin/ograf-renderer.js", "serve"]
