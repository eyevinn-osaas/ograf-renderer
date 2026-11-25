// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

// The HTTP service end to end: upload, list, render, download, auth.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { startService, configFromEnv } from '../src/service.js'
import { makeZip } from './make-zip.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(here, '..', 'fixtures', 'graphics')
const TOKEN = 'test-token-123'

let service
let api

before(async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ograf-service-'))
	const graphicsDir = path.join(root, 'graphics')
	await fs.cp(path.join(FIXTURES, 'lower-third'), path.join(graphicsDir, 'news', 'lower-third'), { recursive: true })
	service = await startService({ ...configFromEnv({}), host: '127.0.0.1', port: 0, graphicsDir, outputDir: path.join(root, 'renders'), token: TOKEN, maxFrames: 500 })
	api = async (method, p, { body, token = TOKEN, raw = false, headers = {} } = {}) => {
		const res = await fetch(service.url + p, {
			method,
			headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers },
			body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
		})
		if (raw) return res
		return { status: res.status, body: await res.json() }
	}
})

after(() => service?.close())

const waitFor = async (id) => {
	for (let i = 0; i < 600; i++) {
		const { body } = await api('GET', `/api/renders/${id}`)
		if (!['queued', 'running'].includes(body.state)) return body
		await new Promise((r) => setTimeout(r, 100))
	}
	throw new Error('render did not finish')
}

test('health is open, the API needs the token', async () => {
	assert.equal((await api('GET', '/health', { token: null })).body.ok, true)
	assert.equal((await api('GET', '/api/graphics', { token: null })).status, 401)
	assert.equal((await api('GET', '/api/graphics', { token: 'wrong-token-123' })).status, 401)
	assert.equal((await api('GET', '/api/nothing')).status, 404)
})

test('graphics: list, upload a zip, remove', async () => {
	const { body: list } = await api('GET', '/api/graphics')
	assert.deepEqual(
		list.map((g) => g.ref),
		['news/lower-third']
	)
	assert.ok(list[0].formats.includes('1080x1920p25'))
	const files = {}
	for (const f of ['lower-third.ograf.json', 'graphic.mjs']) files[`lt/${f}`] = await fs.readFile(path.join(FIXTURES, 'lower-third', f))
	const up = await api('PUT', '/api/graphics/uploaded', { body: makeZip(files) })
	assert.equal(up.status, 200, JSON.stringify(up.body))
	assert.equal(up.body[0].ref, 'uploaded')
	assert.equal((await api('PUT', '/api/graphics/uploaded', { body: makeZip(files) })).status, 409)
	assert.equal((await api('DELETE', '/api/graphics/uploaded')).status, 200)
	assert.equal((await api('GET', '/api/graphics')).body.length, 1)
})

test('render: queue, progress, download frames, tar and video links', async () => {
	assert.equal((await api('POST', '/api/renders', { body: { graphic: 'nope', format: '1080p25', duration: 1 } })).status, 404)
	assert.equal((await api('POST', '/api/renders', { body: { graphic: 'news/lower-third', format: '1080p25' } })).status, 400)

	const { status, body: job } = await api('POST', '/api/renders', { body: { graphic: 'news/lower-third', format: '1080p25', duration: 2, data: { name: 'Jane Doe' } } })
	assert.equal(status, 202)
	assert.match(job.id, /^[0-9A-Z]{26}$/)
	const done = await waitFor(job.id)
	assert.equal(done.state, 'done', done.error)
	assert.equal(done.info.frames, 50)
	assert.equal(done.info.data.name, 'Jane Doe')
	assert.equal(done.info.data.title, undefined, 'data is taken as given')

	const png = PNG.sync.read(Buffer.from(await (await api('GET', `/api/renders/${job.id}/files/frames/000025.png`, { raw: true })).arrayBuffer()))
	assert.deepEqual([png.width, png.height], [1920, 1080])
	assert.equal((await api('GET', `/api/renders/${job.id}/files/../job.json`, { raw: true })).status, 404)
	assert.equal((await api('GET', `/api/renders/${job.id}/files/job.json`, { raw: true })).status, 404)

	const tar = Buffer.from(await (await api('GET', done.links.frames, { raw: true })).arrayBuffer())
	assert.equal(tar.toString('utf8', 0, 38), `${job.id}/render.json\0`.slice(0, 38))
	assert.ok(tar.length > 50 * 512)

	assert.ok((await api('GET', '/api/renders')).body.some((j) => j.id === job.id))
	assert.equal((await api('DELETE', `/api/renders/${job.id}`)).status, 200)
	assert.equal((await api('GET', `/api/renders/${job.id}`)).status, 404)
})

test('render: a vertical render of a 16:9-only graphic fails unless allowed', async () => {
	const m =path.join(service.library.root, 'news', 'lower-third', 'lower-third.ograf.json')
	const manifest = JSON.parse(await fs.readFile(m, 'utf8'))
	delete manifest.renderRequirements
	await fs.writeFile(m, JSON.stringify(manifest))
	const { body: job } = await api('POST', '/api/renders', { body: { graphic: 'news/lower-third', format: '1080x1920p25', durationFrames: 5 } })
	const done = await waitFor(job.id)
	assert.equal(done.state, 'failed')
	assert.match(done.error, /not made for 1080x1920p25/)
})

test('preview: one PNG at a time', async () => {
	const res = await api('POST', '/api/preview', { body: { graphic: 'news/lower-third', at: 1500 }, raw: true })
	assert.equal(res.status, 200)
	assert.equal(res.headers.get('content-type'), 'image/png')
	const png = PNG.sync.read(Buffer.from(await res.arrayBuffer()))
	assert.equal(png.width, 1920)
})
