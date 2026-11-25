// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

// Service pieces that need no browser: request validation, graphics uploads, tar streaming.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { validateRenderRequest } from '../src/service.js'
import { GraphicsLibrary } from '../src/graphics.js'
import { listFiles, writeTar } from '../src/tar.js'
import { chromeArgs } from '../src/browser.js'
import { makeZip } from './make-zip.js'

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'ograf-unit-'))
const MANIFEST = JSON.stringify({ id: 'x', name: 'X', main: 'graphic.mjs', supportsNonRealTime: true })

test('render requests: defaults, seconds to frames, limits', () => {
	const r = validateRenderRequest({ graphic: 'g', format: '1080i50', duration: 5 }, { maxFrames: 1000 })
	assert.deepEqual(r, { graphic: 'g', data: undefined, format: '1080i50', durationFrames: 125, schedule: 'auto', tailFrames: 0, encodes: [], allowAnyFormat: false })
	assert.equal(validateRenderRequest({ graphic: 'g', format: '1080p50', durationFrames: 10, encodes: ['webm', 'webm'] }, { maxFrames: 1000 }).encodes.length, 1)
	const bad = [
		{ format: '1080p25', durationFrames: 10 },
		{ graphic: 'g', format: '720p', durationFrames: 10 },
		{ graphic: 'g', format: '1080p25' },
		{ graphic: 'g', format: '1080p25', durationFrames: 1.5 },
		{ graphic: 'g', format: '1080p25', durationFrames: 2000 },
		{ graphic: 'g', format: '1080p25', durationFrames: 10, encodes: ['gif'] },
		{ graphic: 'g', format: '1080p25', durationFrames: 10, data: [1] },
		{ graphic: 'g', format: '1080p25', durationFrames: 10, tailFrames: 995 },
	]
	for (const b of bad) assert.throws(() => validateRenderRequest(b, { maxFrames: 1000 }), (e) => e.status === 400, JSON.stringify(b))
})

test('graphics library: install from zip (top folder stripped), list, refs stay inside', async () => {
	const lib = new GraphicsLibrary(await tmp())
	await lib.install('lt', makeZip({ 'lower/lt.ograf.json': MANIFEST, 'lower/graphic.mjs': 'export default class extends HTMLElement {}' }))
	const list = await lib.list()
	assert.deepEqual(
		list.map((g) => [g.ref, g.id, g.renderMode]),
		[['lt', 'x', 'non-realtime']]
	)
	assert.ok((await lib.resolve('lt')).graphicDir.endsWith(`${path.sep}lt`))
	await assert.rejects(lib.install('lt', makeZip({ 'lt.ograf.json': MANIFEST })), (e) => e.status === 409)
	await lib.install('lt', makeZip({ 'lt.ograf.json': MANIFEST, 'graphic.mjs': '' }), { replace: true })

	for (const ref of ['../etc', '/etc', 'C:/Windows', 'lt/../..', '', 'missing']) await assert.rejects(lib.resolve(ref), (e) => [400, 404].includes(e.status), ref)
	await assert.rejects(lib.install('../evil', makeZip({ 'a.ograf.json': MANIFEST })), (e) => e.status === 400)
	await assert.rejects(lib.install('evil', makeZip({ '../a.ograf.json': MANIFEST })), (e) => e.status === 400)
	await assert.rejects(lib.install('nomanifest', makeZip({ 'graphic.mjs': '' })), /No \*\.ograf\.json/)
	await assert.rejects(lib.install('notzip', Buffer.from('hello')), (e) => e.status === 400)
	await lib.remove('lt')
	assert.deepEqual(await lib.list(), [])
})

test('tar: ustar headers, padding, end blocks', async () => {
	const dir = await tmp()
	await fs.mkdir(path.join(dir, 'frames'))
	await fs.writeFile(path.join(dir, 'frames', '000000.png'), Buffer.alloc(700, 1))
	await fs.writeFile(path.join(dir, 'render.json'), '{}')
	const files = await listFiles(dir, ['render.json', 'frames', 'missing'])
	assert.deepEqual(files, ['render.json', 'frames/000000.png'])
	const out = new PassThrough()
	const chunks = []
	out.on('data', (c) => chunks.push(c))
	await writeTar(dir, files, out, 'job/')
	const tar = Buffer.concat(chunks)
	assert.equal(tar.length, 512 + 512 + 512 + 1024 + 1024) // header+data(2→512), header+data(700→1024), end
	assert.equal(tar.toString('utf8', 0, 16), 'job/render.json\0')
	assert.equal(tar.toString('utf8', 257, 262), 'ustar')
	assert.equal(parseInt(tar.toString('utf8', 1024 + 124, 1024 + 135), 8), 700)
	// checksum: sum of header bytes with the checksum field as spaces
	const h = Buffer.from(tar.subarray(1024, 1536))
	const stored = parseInt(h.toString('utf8', 148, 154), 8)
	h.fill(0x20, 148, 156)
	assert.equal(stored, h.reduce((s, b) => s + b, 0))
})

test('chromium: no network beyond the local server unless allowed', () => {
	const prev = process.env.OGRAF_NETWORK
	try {
		delete process.env.OGRAF_NETWORK
		assert.ok(chromeArgs().some((a) => a.startsWith('--proxy-server=')))
		assert.ok(chromeArgs().includes('--proxy-bypass-list=<-loopback>;127.0.0.1;localhost'), 'link-local (cloud metadata) not bypassed')
		process.env.OGRAF_NETWORK = 'allow'
		assert.ok(!chromeArgs().some((a) => a.startsWith('--proxy-server=')))
	} finally {
		if (prev === undefined) delete process.env.OGRAF_NETWORK
		else process.env.OGRAF_NETWORK = prev
	}
})
