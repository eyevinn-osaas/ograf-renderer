// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

// Stream a folder's files as an uncompressed tar (ustar), without a temporary archive on disk.
// PNG frames are already compressed, so a plain tar is as small as a zip would be.

import fs from 'node:fs'
import path from 'node:path'

function header(name, size, mtime) {
	if (Buffer.byteLength(name) > 100) throw new Error(`tar: name too long: ${name}`)
	const h = Buffer.alloc(512)
	const put = (s, off, len) => h.write(s, off, len, 'utf8')
	const oct = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0'
	put(name, 0, 100)
	put(oct(0o644, 8), 100, 8)
	put(oct(0, 8), 108, 8)
	put(oct(0, 8), 116, 8)
	put(oct(size, 12), 124, 12)
	put(oct(Math.floor(mtime / 1000), 12), 136, 12)
	put('        ', 148, 8) // checksum placeholder: spaces
	put('0', 156, 1)
	put('ustar\0', 257, 6)
	put('00', 263, 2)
	let sum = 0
	for (const b of h) sum += b
	put(oct(sum, 7) + ' ', 148, 8)
	return h
}

/** Files under dir (relative, "/"-separated), in order, limited to the given top-level entries. */
export async function listFiles(dir, include) {
	const out = []
	async function walk(rel) {
		const entries = await fs.promises.readdir(path.join(dir, rel), { withFileTypes: true })
		entries.sort((a, b) => a.name.localeCompare(b.name))
		for (const e of entries) {
			const r = rel ? `${rel}/${e.name}` : e.name
			if (e.isDirectory()) await walk(r)
			else if (e.isFile()) out.push(r)
		}
	}
	for (const top of include) {
		const st = await fs.promises.stat(path.join(dir, top)).catch(() => null)
		if (st?.isDirectory()) await walk(top)
		else if (st?.isFile()) out.push(top)
	}
	return out
}

/** Write a tar of `files` (relative to dir) to a writable stream. */
export async function writeTar(dir, files, out, prefix = '') {
	const write = (buf) => (out.write(buf) ? Promise.resolve() : new Promise((r) => out.once('drain', r)))
	for (const rel of files) {
		if (out.destroyed) return
		const file = path.join(dir, rel)
		const st = await fs.promises.stat(file)
		await write(header(prefix + rel, st.size, st.mtimeMs))
		for await (const chunk of fs.createReadStream(file)) await write(chunk)
		const pad = (512 - (st.size % 512)) % 512
		if (pad) await write(Buffer.alloc(pad))
	}
	await write(Buffer.alloc(1024))
	out.end()
}
