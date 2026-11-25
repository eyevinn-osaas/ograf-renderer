// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.avif': 'image/avif',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
	'.wasm': 'application/wasm',
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
	'.mp3': 'audio/mpeg',
	'.wav': 'audio/wav',
}

const inside = (file, root) => file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep)

/**
 * Serve `rel` (URL-decoded, '/'-separated) from `dir`, refusing anything outside it, also through
 * links: a junction or symlink inside a graphic folder must not reach the rest of the disk.
 */
export function serveFile(res, dir, rel) {
	const root = path.resolve(dir)
	const file = path.resolve(root, '.' + path.sep + rel)
	if (!inside(file, root)) {
		res.writeHead(403).end()
		return
	}
	Promise.all([fs.promises.realpath(file), fs.promises.realpath(root)])
		.then(([real, realRoot]) => {
			if (!inside(real, realRoot)) {
				res.writeHead(403).end()
				return
			}
			fs.stat(real, (err, st) => {
				if (err || !st.isFile()) {
					res.writeHead(404).end()
					return
				}
				res.writeHead(200, {
					'Content-Type': MIME[path.extname(real).toLowerCase()] || 'application/octet-stream',
					'Content-Length': st.size,
					'Cache-Control': 'no-store',
				})
				fs.createReadStream(real).pipe(res)
			})
		})
		.catch(() => res.writeHead(404).end())
}

/**
 * Minimal static server bound to 127.0.0.1 on a random port.
 * mounts: { "/runtime/": "<dir>", "/graphic/": "<dir>" }
 * resolve(pathname): optional, for folders known only later: [dir, rel] or null.
 * Serves files only (GET), and only to requests addressed to this server (no DNS rebinding).
 */
export function startStaticServer(mounts, { resolve: resolveDynamic = null } = {}) {
	const roots = Object.entries(mounts)
	let port = 0
	const server = http.createServer((req, res) => {
		const host = String(req.headers.host || '')
		if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
			res.writeHead(421).end()
			return
		}
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			res.writeHead(405).end()
			return
		}
		let pathname
		try {
			pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname)
		} catch {
			res.writeHead(400).end()
			return
		}
		if (pathname === '/favicon.ico') return res.writeHead(204).end() // Chromium asks for one; none needed
		const hit = roots.find(([prefix]) => pathname.startsWith(prefix))
		if (hit) return serveFile(res, hit[1], pathname.slice(hit[0].length))
		const dyn = resolveDynamic?.(pathname)
		if (dyn) return serveFile(res, dyn[0], dyn[1])
		res.writeHead(404).end()
	})
	return new Promise((resolve, reject) => {
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => {
			port = server.address().port
			resolve({
				url: `http://127.0.0.1:${port}`,
				// Drop keep-alive sockets from render pages, otherwise close() can wait on them.
				close: () =>
					new Promise((r) => {
						server.close(r)
						server.closeAllConnections()
					}),
			})
		})
	})
}
