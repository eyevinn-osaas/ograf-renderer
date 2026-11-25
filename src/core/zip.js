// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

// A small zip reader (stored and deflated entries, no ZIP64, no encryption): enough for SPX's
// .spxpack exports without a dependency.

import zlib from 'node:zlib'

const EOCD = 0x06054b50
const CDH = 0x02014b50
const LFH = 0x04034b50

// Limits against zip bombs (a small file that unpacks to gigabytes): far above any real SPX pack.
export const ZIP_LIMITS = { entryBytes: 512 * 1024 * 1024, totalBytes: 2 * 1024 * 1024 * 1024, entries: 20000 }

/**
 * Open a zip held in a Buffer. Returns { names, has(name), size(name), read(name) -> Buffer,
 * readText(name) -> string }. Names use "/"; folder entries end with "/".
 */
export function readZip(buf) {
	if (!Buffer.isBuffer(buf)) throw new TypeError('readZip needs a Buffer')
	// End of central directory: within the last 64 KiB + 22 bytes (the comment is up to 64 KiB).
	let eocd = -1
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
		if (buf.readUInt32LE(i) === EOCD) {
			eocd = i
			break
		}
	}
	if (eocd < 0) throw new Error('Not a zip file (no end of central directory)')
	const count = buf.readUInt16LE(eocd + 10)
	const cdSize = buf.readUInt32LE(eocd + 12)
	const cdOffset = buf.readUInt32LE(eocd + 16)
	if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported')
	if (cdOffset + cdSize > buf.length) throw new Error('Damaged zip file (central directory out of range)')
	if (count > ZIP_LIMITS.entries) throw new Error(`Too many files in the zip (${count})`)

	const entries = new Map()
	let unpacked = 0 // bytes handed out so far
	let p = cdOffset
	for (let n = 0; n < count; n++) {
		if (buf.readUInt32LE(p) !== CDH) throw new Error('Damaged zip file (bad central directory entry)')
		const flags = buf.readUInt16LE(p + 8)
		const method = buf.readUInt16LE(p + 10)
		const compressedSize = buf.readUInt32LE(p + 20)
		const size = buf.readUInt32LE(p + 24)
		const nameLen = buf.readUInt16LE(p + 28)
		const extraLen = buf.readUInt16LE(p + 30)
		const commentLen = buf.readUInt16LE(p + 32)
		const localOffset = buf.readUInt32LE(p + 42)
		// Bit 11: UTF-8 names. Others are CP437 in theory; SPX writes ASCII/UTF-8 either way.
		const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen).replace(/\\/g, '/')
		entries.set(name, { name, flags, method, compressedSize, size, localOffset })
		p += 46 + nameLen + extraLen + commentLen
	}

	function read(name) {
		const e = entries.get(name)
		if (!e) throw new Error(`Not in the zip: ${name}`)
		if (e.flags & 1) throw new Error(`Encrypted zip entry: ${name}`)
		const lp = e.localOffset
		if (buf.readUInt32LE(lp) !== LFH) throw new Error(`Damaged zip file (bad local header for ${name})`)
		const start = lp + 30 + buf.readUInt16LE(lp + 26) + buf.readUInt16LE(lp + 28)
		const raw = buf.subarray(start, start + e.compressedSize)
		// The declared size can lie: inflate never more than it (and the limit), then check.
		const max = Math.min(e.size, ZIP_LIMITS.entryBytes)
		if (e.size > ZIP_LIMITS.entryBytes || unpacked + e.size > ZIP_LIMITS.totalBytes) throw new Error(`Zip entry too large: ${name}`)
		let out
		if (e.method === 0) out = Buffer.from(raw)
		else if (e.method === 8) {
			try {
				out = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, max) })
			} catch (err) {
				if (err.code === 'ERR_BUFFER_TOO_LARGE') throw new Error(`Zip entry larger than it says: ${name}`)
				throw err
			}
		} else throw new Error(`Unsupported compression (method ${e.method}) for ${name}`)
		if (out.length !== e.size) throw new Error(`Damaged zip file (wrong size for ${name})`)
		unpacked += out.length
		return out
	}

	return {
		names: [...entries.keys()],
		has: (name) => entries.has(name),
		size: (name) => entries.get(name)?.size,
		read,
		readText: (name) => read(name).toString('utf8').replace(/^﻿/, ''),
	}
}
