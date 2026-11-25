// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

// Test helper: a zip from { name: string|Buffer }; deflated unless the name ends with ".stored".
// No CRCs (our reader doesn't check them).

import zlib from 'node:zlib'

export function makeZip(files) {
	const locals = []
	const central = []
	let offset = 0
	for (const [name, content] of Object.entries(files)) {
		const data = Buffer.isBuffer(content) ? content : Buffer.from(content)
		const stored = name.endsWith('.stored')
		const body = stored ? data : zlib.deflateRawSync(data)
		const nameBuf = Buffer.from(name, 'utf8')
		const lh = Buffer.alloc(30)
		lh.writeUInt32LE(0x04034b50, 0)
		lh.writeUInt16LE(20, 4)
		lh.writeUInt16LE(0x800, 6)
		lh.writeUInt16LE(stored ? 0 : 8, 8)
		lh.writeUInt32LE(body.length, 18)
		lh.writeUInt32LE(data.length, 22)
		lh.writeUInt16LE(nameBuf.length, 26)
		const ch = Buffer.alloc(46)
		ch.writeUInt32LE(0x02014b50, 0)
		ch.writeUInt16LE(20, 4)
		ch.writeUInt16LE(20, 6)
		ch.writeUInt16LE(0x800, 8)
		ch.writeUInt16LE(stored ? 0 : 8, 10)
		ch.writeUInt32LE(body.length, 20)
		ch.writeUInt32LE(data.length, 24)
		ch.writeUInt16LE(nameBuf.length, 28)
		ch.writeUInt32LE(offset, 42)
		locals.push(lh, nameBuf, body)
		central.push(ch, nameBuf)
		offset += 30 + nameBuf.length + body.length
	}
	const cd = Buffer.concat(central)
	const end = Buffer.alloc(22)
	end.writeUInt32LE(0x06054b50, 0)
	end.writeUInt16LE(Object.keys(files).length, 8)
	end.writeUInt16LE(Object.keys(files).length, 10)
	end.writeUInt32LE(cd.length, 12)
	end.writeUInt32LE(offset, 16)
	return Buffer.concat([...locals, cd, end])
}
