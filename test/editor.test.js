// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

// Editor sessions and webhooks end to end: an application opens a session, a (headless) browser uses
// the editor, the render runs, and the application's webhook receiver gets signed events.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startService, configFromEnv } from '../src/service.js'
import { getBrowser } from '../src/browser.js'
import { verifySignature, urlAllowed, parseAllowList, Webhooks } from '../src/webhooks.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(here, '..', 'fixtures', 'graphics')
const TOKEN = 'editor-test-token'
const SECRET = 'webhook-secret'
const APP = 'http://127.0.0.1:9' // the application's origin (nothing needs to listen there)

let service
let hookUrl
let receiver
const hooks = []

before(async () => {
	receiver = http.createServer((req, res) => {
		// The application's page: embeds the editor and records its messages.
		if (req.method === 'GET' && req.url.startsWith('/host?')) {
			const src = new URL(req.url, 'http://x').searchParams.get('editor')
			res.writeHead(200, { 'Content-Type': 'text/html' })
			res.end(`<!doctype html><script>window.msgs=[];addEventListener('message',e=>msgs.push({origin:e.origin,data:e.data}))</script><iframe id="ed" style="width:1200px;height:760px" src="${src.replace(/"/g, '')}"></iframe>`)
			return
		}
		if (req.method !== 'POST') return res.writeHead(404).end()
		let body = ''
		req.on('data', (d) => (body += d)).on('end', () => {
			hooks.push({ headers: req.headers, body, json: JSON.parse(body) })
			res.end('ok')
		})
	})
	await new Promise((r) => receiver.listen(0, '127.0.0.1', r))
	const hookOrigin = `http://127.0.0.1:${receiver.address().port}`
	hookUrl = `${hookOrigin}/ograf-hook`
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ograf-editor-'))
	service = await startService({
		...configFromEnv({}),
		host: '127.0.0.1',
		port: 0,
		graphicsDir: FIXTURES,
		outputDir: path.join(root, 'renders'),
		token: TOKEN,
		allowUploads: false,
		webhookAllow: [hookOrigin],
		webhookSecret: SECRET,
		editorOrigins: [APP, hookOrigin],
	})
	hostOrigin = hookOrigin
})
let hostOrigin

after(async () => {
	await service?.close()
	receiver?.close()
})

const api = async (method, p, body, auth = `Bearer ${TOKEN}`) => {
	const res = await fetch(service.url + p, { method, headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
	return { status: res.status, body: await res.json().catch(() => null) }
}
const waitFor = async (fn, ms = 60_000) => {
	const t0 = Date.now()
	for (;;) {
		const v = await fn()
		if (v) return v
		if (Date.now() - t0 > ms) throw new Error('timed out')
		await new Promise((r) => setTimeout(r, 100))
	}
}

async function openEditor(editorPath) {
	const page = await (await getBrowser()).newPage()
	await page.setViewport({ width: 1300, height: 800 })
	const errors = []
	page.on('pageerror', (e) => errors.push(e.message))
	await page.goto(service.url + editorPath)
	return { page, errors }
}

test('webhook allow list', () => {
	const allow = parseAllowList('https://app.example.com, http://openlive:3000 *.yle.fi')
	assert.ok(urlAllowed('https://app.example.com/hook', allow))
	assert.ok(urlAllowed('http://openlive:3000/x', allow))
	assert.ok(urlAllowed('https://render.yle.fi/x', allow))
	assert.ok(!urlAllowed('http://render.yle.fi/x', allow), 'host patterns need https')
	assert.ok(!urlAllowed('https://app.example.com.evil.net/', allow))
	assert.ok(!urlAllowed('http://169.254.169.254/', allow))
	assert.ok(!urlAllowed('https://user:pw@app.example.com/', allow))
	assert.ok(!urlAllowed('file:///etc/passwd', allow))
	assert.throws(() => new Webhooks({ allow: [] }).check('https://x.example/'), /turned off/)
})

test('sessions: the application needs the token; settings are checked', async () => {
	assert.equal((await api('POST', '/api/editor-sessions', {}, 'Bearer nope')).status, 401)
	assert.equal((await api('POST', '/api/editor-sessions', { callbackUrl: 'http://169.254.169.254/' })).status, 400)
	assert.equal((await api('POST', '/api/editor-sessions', { appOrigin: 'https://evil.example' })).status, 400)
	assert.equal((await api('POST', '/api/editor-sessions', { returnUrl: 'https://evil.example/back' })).status, 400)
	assert.equal((await api('POST', '/api/editor-sessions', { graphic: 'missing' })).status, 404)
	assert.equal((await api('POST', '/api/editor-sessions', { formats: ['720p'] })).status, 400)
	const ok = await api('POST', '/api/editor-sessions', {})
	assert.equal(ok.status, 201)
	assert.match(ok.body.editorPath, /^\/editor\/#s=[A-Za-z0-9_-]{40,}$/)
	assert.equal(ok.body.state, 'open')
})

test('editor API: only with a valid session key; preview files only with the preview token', async () => {
	assert.equal((await api('GET', '/editor-api/session', undefined, 'Session nope')).status, 401)
	assert.equal((await api('GET', '/editor-api/session', undefined, `Bearer ${TOKEN}`)).status, 401)
	const { body } = await api('POST', '/api/editor-sessions', {})
	const key = body.editorPath.split('#s=')[1]
	const view = await api('GET', '/editor-api/session', undefined, `Session ${key}`)
	assert.equal(view.status, 200)
	assert.equal(view.body.callbackUrl, undefined, 'the browser never sees the callback')
	const ok = await fetch(`${service.url}${view.body.previewBase}g/lower-third/graphic.mjs`)
	assert.equal(ok.status, 200)
	assert.equal(ok.headers.get('access-control-allow-origin'), '*')
	assert.equal((await fetch(`${service.url}/preview/${'x'.repeat(43)}/g/lower-third/graphic.mjs`)).status, 404)
	assert.equal((await fetch(`${service.url}${view.body.previewBase}g/..%2F..%2Fsrc/service.js`)).status, 400)
	const page = await fetch(`${service.url}/editor/`)
	assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'self' http:\/\/127\.0\.0\.1:9/)
})

test('editor: prefilled, Save & Render, signed webhook, single use', async () => {
	const { status, body: session } = await api('POST', '/api/editor-sessions', {
		graphic: 'lower-third',
		data: { name: 'From the app', title: 'Prefilled' },
		formats: ['1080p25', '1080i50'],
		duration: 2,
		lockDuration: true,
		callbackUrl: hookUrl,
		metadata: { clipId: 'abc' },
		appOrigin: APP,
	})
	assert.equal(status, 201)
	const { page, errors } = await openEditor(session.editorPath)
	try {
		await page.waitForFunction(() => !document.getElementById('save').disabled, { timeout: 60_000 })
		assert.equal(new URL(page.url()).hash, '', 'the key leaves the address bar')
		assert.equal(await page.$eval('#form input', (i) => i.value), 'From the app')
		assert.equal(await page.$eval('#duration', (i) => i.disabled), true)
		assert.deepEqual(await page.$$eval('#format option', (os) => os.map((o) => o.value)), ['1080p25', '1080i50'])
		// Edit a field, then render.
		await page.$eval('#form input', (i) => {
			i.value = 'Edited in the editor'
			i.dispatchEvent(new Event('input'))
		})
		await page.click('#save')
		await page.waitForFunction(() => document.getElementById('finishedTitle').textContent === 'Rendered', { timeout: 120_000 })
		assert.deepEqual(errors, [])
	} finally {
		await page.close()
	}

	const hook = await waitFor(() => hooks.find((h) => h.json.sessionId === session.id))
	assert.equal(hook.headers['x-ograf-event'], 'render.done')
	assert.ok(verifySignature(SECRET, hook.body, hook.headers['x-ograf-signature']))
	assert.ok(!verifySignature('wrong', hook.body, hook.headers['x-ograf-signature']))
	assert.deepEqual(hook.json.metadata, { clipId: 'abc' })
	assert.equal(hook.json.render.state, 'done')
	assert.equal(hook.json.render.info.data.name, 'Edited in the editor')
	assert.equal(hook.json.render.info.frames, 50)
	assert.ok(hook.json.render.links.frames)

	const s = await api('GET', `/api/editor-sessions/${session.id}`)
	assert.equal(s.body.state, 'submitted')
	assert.equal(s.body.renderId, hook.json.render.id)
	const key = session.editorPath.split('#s=')[1]
	const again = await api('POST', '/editor-api/submit', { graphic: 'lower-third', format: '1080p25', durationFrames: 50 }, `Session ${key}`)
	assert.equal(again.status, 409, 'one render per session')
})

test('editor: the session limits hold on the server too', async () => {
	const { body } = await api('POST', '/api/editor-sessions', { formats: ['1080p25'], duration: 2, lockDuration: true })
	const key = body.editorPath.split('#s=')[1]
	const auth = `Session ${key}`
	assert.equal((await api('POST', '/editor-api/submit', { graphic: 'lower-third', format: '2160p25', durationFrames: 50 }, auth)).status, 400)
	assert.equal((await api('POST', '/editor-api/submit', { graphic: 'lower-third', format: '1080p25', durationFrames: 99 }, auth)).status, 400)
})

test('editor: Cancel sends editor.cancelled', async () => {
	const { body: session } = await api('POST', '/api/editor-sessions', { callbackUrl: hookUrl, metadata: { n: 2 } })
	const { page } = await openEditor(session.editorPath)
	try {
		await page.waitForSelector('#picker:not([hidden])', { timeout: 30_000 }) // no graphic given: the picker opens
		await page.keyboard.press('Escape') // nothing chosen yet: stays open
		assert.equal(await page.$eval('#picker', (p) => p.hidden), false)
		await page.$eval('#cancel', (b) => b.click())
		await page.waitForFunction(() => document.getElementById('finishedTitle').textContent === 'Closed')
	} finally {
		await page.close()
	}
	const hook = await waitFor(() => hooks.find((h) => h.json.sessionId === session.id))
	assert.equal(hook.json.event, 'editor.cancelled')
	assert.deepEqual(hook.json.metadata, { n: 2 })
	assert.equal((await api('GET', `/api/editor-sessions/${session.id}`)).body.state, 'cancelled')
})

test('editor: graphics with their own files (Lottie) and live graphics preview without errors', async () => {
	for (const graphic of ['headline', 'realtime-only', 'two-step']) {
		const { body } = await api('POST', '/api/editor-sessions', { graphic })
		const { page, errors } = await openEditor(body.editorPath)
		try {
			await page.waitForFunction(() => !document.getElementById('save').disabled && document.getElementById('loading').hidden, { timeout: 60_000 })
			const banner = await page.$eval('#banner', (b) => (b.hidden ? '' : b.className + ' ' + b.textContent))
			assert.ok(!banner.includes('error'), `${graphic}: ${banner}`)
			assert.equal(await page.$eval('#frames', (f) => f.querySelectorAll('iframe.active').length), 1, graphic)
			if (graphic === 'two-step') assert.equal(await page.$eval('#stepsField', (f) => f.hidden), false)
			assert.deepEqual(errors, [], graphic)
		} finally {
			await page.close()
		}
	}
})

test('editor embedded in the application: ready and submitted messages to the app origin only', async () => {
	const { body: session } = await api('POST', '/api/editor-sessions', { graphic: 'lower-third', duration: 1, appOrigin: hostOrigin })
	const page = await (await getBrowser()).newPage()
	try {
		await page.goto(`${hostOrigin}/host?editor=${encodeURIComponent(service.url + session.editorPath)}`)
		const frame = await waitFor(async () => {
			const f = page.frames().find((x) => x.url().startsWith(`${service.url}/editor/`))
			return f && (await f.$('#save').then((b) => b?.evaluate((x) => !x.disabled)).catch(() => false)) && f
		})
		await frame.$eval('#save', (b) => b.click())
		const msgs = await waitFor(async () => {
			const m = await page.evaluate(() => window.msgs)
			return m.some((x) => x.data.event === 'submitted') && m
		})
		const editorMsgs = msgs.filter((m) => m.data?.type === 'ograf:editor')
		assert.deepEqual(
			editorMsgs.map((m) => m.data.event),
			['ready', 'submitted']
		)
		assert.ok(editorMsgs.every((m) => m.origin === service.url && m.data.sessionId === session.id))
		assert.match(editorMsgs[1].data.renderId, /^[0-9A-Z]{26}$/)
	} finally {
		await page.close()
	}
})

test('POST /api/renders takes a callbackUrl too', async () => {
	assert.equal((await api('POST', '/api/renders', { graphic: 'lower-third', format: '1080p25', durationFrames: 5, callbackUrl: 'https://not-allowed.example/' })).status, 400)
	const { body } = await api('POST', '/api/renders', { graphic: 'lower-third', format: '1080p25', durationFrames: 5, callbackUrl: hookUrl, metadata: { direct: true } })
	const hook = await waitFor(() => hooks.find((h) => h.json.render?.id === body.id))
	assert.equal(hook.json.event, 'render.done')
	assert.deepEqual(hook.json.metadata, { direct: true })
})
