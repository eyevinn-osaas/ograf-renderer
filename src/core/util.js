// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** ULID: sortable 26-char id (48-bit ms time + 80 random bits). */
export function ulid(now = Date.now()) {
	let t = ''
	let n = now
	for (let i = 0; i < 10; i++) {
		t = B32[n % 32] + t
		n = Math.floor(n / 32)
	}
	const rnd = crypto.randomBytes(16)
	let r = ''
	for (let i = 0; i < 16; i++) r += B32[rnd[i] % 32]
	return t + r
}

/** JSON.stringify with sorted keys, for hashing. */
export function stableStringify(v) {
	if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
	if (v && typeof v === 'object') {
		return `{${Object.keys(v)
			.sort()
			.filter((k) => v[k] !== undefined)
			.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
			.join(',')}}`
	}
	return JSON.stringify(v)
}

export function sha256(buf) {
	return crypto.createHash('sha256').update(buf).digest('hex')
}

/** Write a file atomically (temp file + rename) so readers never see partial content. */
export async function writeFileAtomic(file, content) {
	const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
	await fs.writeFile(tmp, content)
	await renameRetry(tmp, file)
}

/** fs.rename with retries: Windows/SMB can transiently fail with EPERM/EBUSY when a reader has the file open. */
export async function renameRetry(from, to, tries = 10) {
	for (let i = 0; ; i++) {
		try {
			return await fs.rename(from, to)
		} catch (e) {
			if (i >= tries || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e
			await new Promise((r) => setTimeout(r, 50 * (i + 1)))
		}
	}
}

/** Hard-link if possible (saves disk for held frames), else copy (e.g. filesystems without link support). */
export async function linkOrCopy(src, dst) {
	try {
		await fs.link(src, dst)
	} catch {
		await fs.copyFile(src, dst)
	}
}
