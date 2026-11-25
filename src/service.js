// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

// HTTP service: the render API (/api, API token), the web editor (/editor/, its own /editor-api with a
// session key) and the files graphics load in the editor's preview (/preview/<preview token>/).
// See docs/api.md and docs/editor.md.

import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FORMATS, getFormat, graphicSupportsFormat, unsupportedFormatMessage } from './core/formats.js'
import { planRender, normalizeSchedule } from './core/schedule.js'
import { serveFile } from './static-server.js'
import { GraphicsLibrary, HttpError } from './graphics.js'
import { JobManager } from './jobs.js'
import { SessionStore } from './sessions.js'
import { Webhooks, parseAllowList, urlAllowed } from './webhooks.js'
import { ENCODERS } from './encode.js'
import { listFiles, writeTar } from './tar.js'
import { renderStill, withTimeout } from './capture.js'
import { loadGraphic } from './render.js'
import { detectTiming, planTiming } from './timing.js'
import { renderMode, defaultData } from './core/manifest.js'
import { closeBrowser, getBrowser } from './browser.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UI_DIR = path.join(HERE, '..', 'ui')
const RUNTIME_DIR = path.join(HERE, '..', 'runtime')
const VERSION = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version

export function configFromEnv(env = process.env) {
	const int = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d)
	return {
		host: env.OGRAF_HOST || '0.0.0.0',
		port: int(env.PORT ?? env.OGRAF_PORT, 8080),
		graphicsDir: env.OGRAF_GRAPHICS_DIR || path.resolve('data/graphics'),
		outputDir: env.OGRAF_OUTPUT_DIR || path.resolve('data/renders'),
		token: env.OGRAF_API_TOKEN || '',
		concurrency: int(env.OGRAF_CONCURRENCY, 1),
		retentionHours: int(env.OGRAF_RETENTION_HOURS, 24),
		maxFrames: int(env.OGRAF_MAX_FRAMES, 25 * 60 * 10),
		maxUploadBytes: int(env.OGRAF_MAX_UPLOAD_MB, 200) * 1024 * 1024,
		allowUploads: !/^(0|false|no|off)$/i.test(env.OGRAF_ALLOW_UPLOADS ?? ''),
		corsOrigin: env.OGRAF_CORS_ORIGIN || '',
		publicUrl: (env.OGRAF_PUBLIC_URL || '').replace(/\/+$/, ''),
		webhookAllow: parseAllowList(env.OGRAF_WEBHOOK_ALLOW),
		webhookSecret: env.OGRAF_WEBHOOK_SECRET || '',
		editorOrigins: parseAllowList(env.OGRAF_EDITOR_ORIGINS),
		sessionHours: int(env.OGRAF_EDITOR_SESSION_HOURS, 4),
	}
}

const json = (res, status, body, headers = {}) => {
	const text = JSON.stringify(body, null, 2)
	res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers })
	res.end(text)
}

async function readBody(req, max) {
	const chunks = []
	let size = 0
	for await (const c of req) {
		size += c.length
		if (size > max) throw new HttpError(413, `Request body larger than ${Math.round(max / 1024 / 1024)} MB`)
		chunks.push(c)
	}
	return Buffer.concat(chunks)
}

async function readJson(req, max = 1024 * 1024) {
	const buf = await readBody(req, max)
	if (!buf.length) return {}
	try {
		return JSON.parse(buf.toString('utf8'))
	} catch {
		throw new HttpError(400, 'Body is not valid JSON')
	}
}

const fail = (m) => {
	throw new HttpError(400, m)
}

/** Duration in frames from durationFrames or duration (seconds); undefined when neither is given. */
function framesFrom(r, formatId) {
	if (r.durationFrames !== undefined) return r.durationFrames
	if (r.duration === undefined) return undefined
	if (!(Number(r.duration) > 0)) fail('duration: seconds, > 0')
	const fmt = getFormat(formatId)
	return Math.round((Number(r.duration) * fmt.frameRate[0]) / fmt.frameRate[1])
}

function checkSchedule(schedule) {
	if (schedule === 'auto' || Array.isArray(schedule)) return schedule
	if (typeof schedule !== 'object' || schedule === null) fail('schedule: "auto", { outFrame, steps } or a list of actions')
	try {
		normalizeSchedule(schedule)
	} catch (e) {
		fail(`schedule: ${e.message}`)
	}
	return schedule
}

function checkMetadata(m) {
	if (m === undefined || m === null) return null
	if (typeof m !== 'object' || Array.isArray(m)) fail('metadata: an object')
	if (JSON.stringify(m).length > 8192) fail('metadata: at most 8 KB of JSON')
	return m
}

/** Check a render request and return the normalised request. */
export function validateRenderRequest(body, { maxFrames }) {
	const r = body ?? {}
	if (typeof r.graphic !== 'string' || !r.graphic) fail('graphic: the graphic reference from GET /api/graphics')
	if (!FORMATS[r.format]) fail(`format: one of ${Object.keys(FORMATS).join(', ')}`)
	const durationFrames = framesFrom(r, r.format)
	if (!Number.isInteger(durationFrames) || durationFrames < 1) fail('durationFrames (whole frames) or duration (seconds) is required')
	if (durationFrames > maxFrames) fail(`At most ${maxFrames} frames per render`)
	if (r.data !== undefined && (typeof r.data !== 'object' || r.data === null || Array.isArray(r.data))) fail('data: an object')
	const tailFrames = r.tailFrames ?? 0
	if (!Number.isInteger(tailFrames) || tailFrames < 0 || durationFrames + tailFrames > maxFrames) fail('tailFrames: whole frames ≥ 0 (within the frame limit)')
	const encodes = r.encodes ?? []
	if (!Array.isArray(encodes) || !encodes.every((e) => ENCODERS[e])) fail(`encodes: a list of ${Object.keys(ENCODERS).join(', ')}`)
	const schedule = checkSchedule(r.schedule ?? 'auto')
	return { graphic: r.graphic, data: r.data, format: r.format, durationFrames, schedule, tailFrames, encodes: [...new Set(encodes)], allowAnyFormat: !!r.allowAnyFormat }
}

/** Files of a job that may be downloaded. */
const DOWNLOADABLE = /^(render\.json|graphic\.(mov|webm)|(frames|fields)\/\d{6}\.png)$/

/** Security headers for the editor's own pages: strict CSP, framing only by the configured applications. */
function editorHeaders(cfg) {
	const ancestors = ["'self'", ...cfg.editorOrigins.filter((o) => o !== '*' && !o.startsWith('*.'))].join(' ')
	return {
		'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${ancestors}`,
		'Referrer-Policy': 'no-referrer',
		'X-Content-Type-Options': 'nosniff',
	}
}

export async function startService(cfg = configFromEnv(), { log = () => {} } = {}) {
	const library = new GraphicsLibrary(cfg.graphicsDir)
	await fs.mkdir(cfg.graphicsDir, { recursive: true })
	const webhooks = new Webhooks({ allow: cfg.webhookAllow, secret: cfg.webhookSecret, log, ...(cfg.webhookRetryDelaysMs ? { retryDelaysMs: cfg.webhookRetryDelaysMs } : {}) })
	const sessions = new SessionStore({ root: path.join(cfg.outputDir, '.sessions'), ttlHours: cfg.sessionHours, log })

	const publicJob = (j) => {
		const { _onSettled, ...rest } = j
		const base = `/api/renders/${j.id}`
		return {
			...rest,
			links:
				j.state === 'done'
					? {
							self: base,
							frames: `${base}/frames.tar`,
							firstFrame: `${base}/files/frames/000000.png`,
							info: `${base}/files/render.json`,
							...Object.fromEntries(Object.entries(j.info?.encodes ?? {}).map(([k, v]) => [k, `${base}/files/${v.file}`])),
						}
					: { self: base },
		}
	}

	const jobs = new JobManager({
		root: cfg.outputDir,
		library,
		concurrency: cfg.concurrency,
		retentionHours: cfg.retentionHours,
		log,
		onFinished: (job) => webhooks.send(job.callbackUrl, `render.${job.state}`, { render: publicJob(job), sessionId: job.sessionId, metadata: job.metadata }),
	})
	await jobs.init()
	await sessions.init()

	/** What the graphic looks like over time for these settings: the editor's timeline. */
	async function plan(body) {
		const { graphicDir, manifestFile } = await library.resolve(body.graphic)
		const { manifest } = await loadGraphic(graphicDir, manifestFile)
		if (!FORMATS[body.format]) fail('Unknown format')
		if (!body.allowAnyFormat && !graphicSupportsFormat(manifest, body.format)) fail(unsupportedFormatMessage(manifest, body.format))
		const durationFrames = framesFrom(body, body.format)
		if (!Number.isInteger(durationFrames) || durationFrames < 1 || durationFrames > cfg.maxFrames) fail(`durationFrames: 1 to ${cfg.maxFrames}`)
		const schedule = checkSchedule(body.schedule ?? 'auto')
		const timing = await detectTiming({ graphicDir, manifest, data: body.data ?? defaultData(manifest), layout: getFormat(body.format).layout, log })
		let p
		try {
			p = planRender(manifest, { format: body.format, durationFrames, schedule }, planTiming(timing))
		} catch (e) {
			fail(e.message)
		}
		const f = p.format
		return {
			format: { id: f.id, layout: f.layout, frameRate: f.frameRate, sampleRate: f.sampleRate, interlaced: f.interlaced },
			durationFrames: p.durationFrames,
			sampleCount: p.sampleCount,
			schedule: p.schedule,
			// Graphic time per sample: the preview seeks to exactly what the renderer captures.
			timestamps: p.timestamps,
			outAt: p.outAt,
			outDuration: p.outDuration,
			steps: p.steps || [],
			stepCount: Number.isInteger(manifest.stepCount) ? manifest.stepCount : 1,
			mode: p.mode,
			emulate: !!p.emulate,
			timing,
		}
	}

	// ------------------------------------------------------------------ editor sessions

	async function createSession(b, req) {
		let base = {}
		if (b.fromRender !== undefined) {
			const job = jobs.get(String(b.fromRender))
			if (!job) throw new HttpError(404, 'fromRender: no such render')
			const r = job.request
			base = { graphic: r.graphic, data: r.data ?? job.info?.data, format: r.format, durationFrames: r.durationFrames, schedule: r.schedule, tailFrames: r.tailFrames, encodes: r.encodes }
		}
		const s = { ...base, ...b }
		const formats = s.formats === undefined ? null : s.formats
		if (formats !== null && (!Array.isArray(formats) || !formats.length || !formats.every((f) => FORMATS[f]))) fail('formats: a non-empty list of format ids')
		const format = s.format ?? formats?.[0] ?? '1080p25'
		if (!FORMATS[format]) fail(`format: one of ${Object.keys(FORMATS).join(', ')}`)
		if (formats && !formats.includes(format)) fail('format must be one of formats')
		const durationFrames = framesFrom(s, format) ?? Math.round((10 * getFormat(format).frameRate[0]) / getFormat(format).frameRate[1])
		if (!Number.isInteger(durationFrames) || durationFrames < 1 || durationFrames > cfg.maxFrames) fail(`durationFrames: 1 to ${cfg.maxFrames}`)
		if (s.graphic !== undefined && s.graphic !== null) await library.resolve(s.graphic)
		if (s.data !== undefined && s.data !== null && (typeof s.data !== 'object' || Array.isArray(s.data))) fail('data: an object')
		const encodes = s.encodes ?? []
		if (!Array.isArray(encodes) || !encodes.every((e) => ENCODERS[e])) fail(`encodes: a list of ${Object.keys(ENCODERS).join(', ')}`)
		const tailFrames = s.tailFrames ?? 0
		if (!Number.isInteger(tailFrames) || tailFrames < 0) fail('tailFrames: whole frames ≥ 0')
		if (s.appOrigin !== undefined && (typeof s.appOrigin !== 'string' || !urlAllowed(s.appOrigin, cfg.editorOrigins) || new URL(s.appOrigin).origin !== s.appOrigin)) {
			fail('appOrigin: an origin listed in OGRAF_EDITOR_ORIGINS')
		}
		if (s.returnUrl !== undefined && (typeof s.returnUrl !== 'string' || !urlAllowed(s.returnUrl, cfg.editorOrigins))) fail('returnUrl: must be on an origin listed in OGRAF_EDITOR_ORIGINS')
		if (s.title !== undefined && (typeof s.title !== 'string' || s.title.length > 200)) fail('title: text, at most 200 characters')
		const { session, key } = await sessions.create({
			title: s.title ?? null,
			graphic: s.graphic ?? null,
			data: s.data ?? null,
			format,
			formats,
			durationFrames,
			lockDuration: !!s.lockDuration,
			schedule: checkSchedule(s.schedule ?? 'auto'),
			encodes: [...new Set(encodes)],
			tailFrames,
			allowAnyFormat: !!s.allowAnyFormat,
			callbackUrl: webhooks.check(s.callbackUrl),
			metadata: checkMetadata(s.metadata),
			appOrigin: s.appOrigin ?? null,
			returnUrl: s.returnUrl ?? null,
		})
		const editorPath = `/editor/#s=${key}`
		const origin = cfg.publicUrl || `http://${req.headers.host}`
		return [201, { ...publicSession(session), editorUrl: `${origin}${editorPath}`, editorPath }]
	}

	const publicSession = (s) => ({
		id: s.id,
		state: Date.parse(s.expiresAt) <= Date.now() && s.state === 'open' ? 'expired' : s.state,
		renderId: s.renderId,
		title: s.title,
		createdAt: s.createdAt,
		expiresAt: s.expiresAt,
		metadata: s.metadata,
	})

	/** What the editor page gets: its starting point and limits, never the callback or metadata. */
	const editorView = (s) => ({
		id: s.id,
		state: s.state,
		renderId: s.renderId,
		title: s.title,
		graphic: s.graphic,
		data: s.data,
		format: s.format,
		formats: (s.formats ?? Object.keys(FORMATS)).map((id) => getFormat(id)),
		durationFrames: s.durationFrames,
		lockDuration: s.lockDuration,
		schedule: s.schedule,
		allowAnyFormat: s.allowAnyFormat,
		appOrigin: s.appOrigin,
		returnUrl: s.returnUrl,
		expiresAt: s.expiresAt,
		previewBase: `/preview/${s.previewToken}/`,
	})

	const sessionOf = (req) => {
		const m = /^Session\s+(\S+)$/i.exec(req.headers.authorization || '')
		const s = m && sessions.byKey(m[1])
		if (!s) throw new HttpError(401, 'This editor link has expired or is not valid. Open the editor again from your application.')
		return s
	}

	// ------------------------------------------------------------------ routes

	const authorised = (req) => {
		if (!cfg.token) return true
		const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')
		if (!m) return false
		const a = Buffer.from(m[1].trim())
		const b = Buffer.from(cfg.token)
		return a.length === b.length && crypto.timingSafeEqual(a, b)
	}

	const OPEN = { open: true }
	const SESSION = { open: true, session: true }

	const routes = [
		['GET', /^\/health$/, async () => ({ ok: true, version: VERSION, running: jobs.running, queued: jobs.queue.length }), OPEN],
		['GET', /^\/favicon\.ico$/, async (_req, _m, _url, res) => (res.writeHead(204).end(), undefined), OPEN],
		['GET', /^\/api\/formats$/, async () => Object.keys(FORMATS).map((id) => getFormat(id))],
		['GET', /^\/api\/encodes$/, async () => Object.keys(ENCODERS)],
		['GET', /^\/api\/graphics$/, async () => library.list()],
		[
			'PUT',
			/^\/api\/graphics\/([^/]+)$/,
			async (req, m, url) => {
				if (!cfg.allowUploads) throw new HttpError(403, 'Uploads are turned off (OGRAF_ALLOW_UPLOADS)')
				const body = await readBody(req, cfg.maxUploadBytes)
				return library.install(decodeURIComponent(m[1]), body, { replace: url.searchParams.get('replace') === 'true' })
			},
		],
		[
			'DELETE',
			/^\/api\/graphics\/([^/]+)$/,
			async (_req, m) => {
				if (!cfg.allowUploads) throw new HttpError(403, 'Uploads are turned off (OGRAF_ALLOW_UPLOADS)')
				await library.remove(decodeURIComponent(m[1]))
				return { deleted: true }
			},
		],
		['POST', /^\/api\/plan$/, async (req) => plan(await readJson(req))],
		[
			'POST',
			/^\/api\/preview$/,
			async (req, _m, _url, res) => {
				const b = await readJson(req)
				if (typeof b.graphic !== 'string') throw new HttpError(400, 'graphic is required')
				const fmt = getFormat(FORMATS[b.format] ? b.format : '1080p25')
				const at = Number.isFinite(b.at) ? Math.max(0, b.at) : 2000
				const { graphicDir, manifestFile } = await library.resolve(b.graphic)
				const { manifest } = await loadGraphic(graphicDir, manifestFile)
				const png = await withTimeout(
					renderStill({
						graphicDir,
						manifest,
						data: b.data ?? defaultData(manifest),
						schedule: [{ timestamp: 0, action: { type: 'playAction', params: {} } }],
						ts: at,
						layout: fmt.layout,
						scale: b.fullSize ? fmt.scale : 1,
						emulate: renderMode(manifest) === 'emulated',
					}),
					60_000
				)
				res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'no-store' })
				res.end(png)
				return undefined
			},
		],
		['GET', /^\/api\/renders$/, async () => jobs.list().map(publicJob)],
		[
			'POST',
			/^\/api\/renders$/,
			async (req) => {
				const body = await readJson(req)
				const request = validateRenderRequest(body, cfg)
				const callbackUrl = webhooks.check(body.callbackUrl)
				const metadata = checkMetadata(body.metadata)
				await library.resolve(request.graphic) // 404 now rather than a failed job later
				return [202, publicJob(await jobs.submit(request, { callbackUrl, metadata }))]
			},
		],
		['GET', /^\/api\/renders\/([^/]+)$/, async (_req, m) => publicJob(must(jobs.get(m[1])))],
		['POST', /^\/api\/renders\/([^/]+)\/cancel$/, async (_req, m) => publicJob(must(await jobs.cancel(m[1])))],
		[
			'DELETE',
			/^\/api\/renders\/([^/]+)$/,
			async (_req, m) => {
				must(jobs.get(m[1]))
				await jobs.remove(m[1])
				return { deleted: true }
			},
		],
		[
			'GET',
			/^\/api\/renders\/([^/]+)\/frames\.tar$/,
			async (_req, m, url, res) => {
				const job = must(jobs.get(m[1]))
				if (job.state !== 'done') throw new HttpError(409, `Render is ${job.state}`)
				const dir = jobs.dir(job.id)
				const files = await listFiles(dir, ['render.json', 'frames', ...(url.searchParams.get('fields') === 'true' ? ['fields'] : [])])
				res.writeHead(200, { 'Content-Type': 'application/x-tar', 'Content-Disposition': `attachment; filename="${job.id}.tar"`, 'Cache-Control': 'no-store' })
				await writeTar(dir, files, res, `${job.id}/`)
				return undefined
			},
		],
		[
			'GET',
			/^\/api\/renders\/([^/]+)\/files\/(.+)$/,
			async (_req, m, _url, res) => {
				const job = must(jobs.get(m[1]))
				const rel = decodeURIComponent(m[2])
				if (!DOWNLOADABLE.test(rel)) throw new HttpError(404, 'No such file')
				if (job.state !== 'done') throw new HttpError(409, `Render is ${job.state}`)
				serveFile(res, jobs.dir(job.id), rel)
				return undefined
			},
		],

		// Editor sessions (the application, with the API token)
		['POST', /^\/api\/editor-sessions$/, async (req) => createSession(await readJson(req), req)],
		[
			'GET',
			/^\/api\/editor-sessions\/([^/]+)$/,
			async (_req, m) => {
				const s = sessions.get(m[1])
				if (!s) throw new HttpError(404, 'No such editor session')
				return publicSession(s)
			},
		],
		[
			'DELETE',
			/^\/api\/editor-sessions\/([^/]+)$/,
			async (_req, m) => {
				const s = sessions.get(m[1])
				if (!s) throw new HttpError(404, 'No such editor session')
				await sessions.remove(s)
				return { deleted: true }
			},
		],

		// The editor page and its API (session key)
		['GET', /^\/editor$/, async (_req, _m, _url, res) => (res.writeHead(301, { Location: '/editor/' }).end(), undefined), OPEN],
		[
			'GET',
			/^\/editor\/([A-Za-z0-9._-]*)$/,
			async (_req, m, _url, res) => {
				for (const [k, v] of Object.entries(editorHeaders(cfg))) res.setHeader(k, v)
				serveFile(res, UI_DIR, m[1] || 'editor.html')
				return undefined
			},
			OPEN,
		],
		['GET', /^\/editor-api\/session$/, async (req) => editorView(sessionOf(req)), SESSION],
		['GET', /^\/editor-api\/graphics$/, async (req) => (sessionOf(req), library.list()), SESSION],
		[
			'POST',
			/^\/editor-api\/plan$/,
			async (req) => {
				const s = sessionOf(req)
				return plan({ ...(await readJson(req)), allowAnyFormat: s.allowAnyFormat })
			},
			SESSION,
		],
		[
			'POST',
			/^\/editor-api\/submit$/,
			async (req) => {
				const s = sessionOf(req)
				if (s.state !== 'open') throw new HttpError(409, s.state === 'submitted' ? 'This graphic was already sent for rendering.' : 'This editor was closed.')
				const b = await readJson(req)
				if (s.formats && !s.formats.includes(b.format)) fail(`format: one of ${s.formats.join(', ')}`)
				if (s.lockDuration && b.durationFrames !== s.durationFrames) fail(`The length is fixed at ${s.durationFrames} frames`)
				const request = validateRenderRequest({ graphic: b.graphic, data: b.data, format: b.format, durationFrames: b.durationFrames, schedule: b.schedule, encodes: s.encodes, tailFrames: s.tailFrames, allowAnyFormat: s.allowAnyFormat }, cfg)
				await library.resolve(request.graphic)
				const job = await jobs.submit(request, { callbackUrl: s.callbackUrl, metadata: s.metadata, sessionId: s.id })
				await sessions.update(s, { state: 'submitted', renderId: job.id, submittedAt: new Date().toISOString() })
				return [202, { sessionId: s.id, renderId: job.id, state: job.state }]
			},
			SESSION,
		],
		[
			'POST',
			/^\/editor-api\/cancel$/,
			async (req) => {
				const s = sessionOf(req)
				if (s.state !== 'open') return { sessionId: s.id, state: s.state }
				await sessions.update(s, { state: 'cancelled', cancelledAt: new Date().toISOString() })
				webhooks.send(s.callbackUrl, 'editor.cancelled', { session: publicSession(s), sessionId: s.id, metadata: s.metadata })
				return { sessionId: s.id, state: s.state }
			},
			SESSION,
		],
		[
			'GET',
			/^\/editor-api\/render$/,
			async (req) => {
				const s = sessionOf(req)
				const job = s.renderId && jobs.get(s.renderId)
				if (!job) throw new HttpError(404, 'Nothing rendered yet')
				return { id: job.id, state: job.state, progress: job.progress, error: job.error, frames: job.info?.frames ?? null }
			},
			SESSION,
		],

		// Files for the preview frames (third-party graphic code, opaque origin): a preview token, CORS for "null"
		[
			'GET',
			/^\/preview\/([A-Za-z0-9_-]{20,})\/runtime\/([A-Za-z0-9._-]+)$/,
			async (_req, m, _url, res) => {
				if (!sessions.byPreviewToken(m[1])) throw new HttpError(404, 'Not found')
				res.setHeader('Access-Control-Allow-Origin', '*')
				serveFile(res, RUNTIME_DIR, m[2])
				return undefined
			},
			OPEN,
		],
		[
			'GET',
			/^\/preview\/([A-Za-z0-9_-]{20,})\/g\/([^/]+)\/(.+)$/,
			async (_req, m, _url, res) => {
				if (!sessions.byPreviewToken(m[1])) throw new HttpError(404, 'Not found')
				const { graphicDir } = await library.resolve(decodeURIComponent(m[2]))
				res.setHeader('Access-Control-Allow-Origin', '*')
				serveFile(res, graphicDir, decodeURIComponent(m[3]))
				return undefined
			},
			OPEN,
		],
	]

	const server = http.createServer(async (req, res) => {
		const t0 = Date.now()
		let url
		try {
			url = new URL(req.url, 'http://x')
		} catch {
			return json(res, 400, { error: 'Bad URL' })
		}
		if (cfg.corsOrigin && url.pathname.startsWith('/api/')) {
			res.setHeader('Access-Control-Allow-Origin', cfg.corsOrigin)
			res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
			res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
			if (req.method === 'OPTIONS') return res.writeHead(204).end()
		}
		try {
			const candidates = routes.filter(([, re]) => re.test(url.pathname))
			if (!candidates.length) throw new HttpError(404, 'Not found')
			const route = candidates.find(([method]) => method === req.method || (method === 'GET' && req.method === 'HEAD'))
			if (!route) throw new HttpError(405, 'Method not allowed')
			const [, re, handler, opts] = route
			if (!opts?.open && !authorised(req)) throw new HttpError(401, 'Missing or wrong bearer token')
			const result = await handler(req, re.exec(url.pathname), url, res)
			if (result === undefined) return
			const [status, body] = Array.isArray(result) && typeof result[0] === 'number' ? result : [200, result]
			json(res, status, body)
		} catch (e) {
			const status = e.status || 500
			if (status >= 500) log(`[http] ${req.method} ${url.pathname}: ${e.stack || e.message}`)
			if (!res.headersSent) json(res, status, { error: e.message })
			else res.destroy()
		} finally {
			// Paths only: preview URLs carry their token in the path, so it is shortened in the log.
			if (url.pathname !== '/health') log(`[http] ${req.method} ${url.pathname.replace(/^\/preview\/[^/]{8}[^/]*/, (p) => `${p.slice(0, 17)}…`)} ${res.statusCode} ${Date.now() - t0}ms`)
		}
	})
	server.requestTimeout = 0 // uploads and tar downloads can take a while
	await new Promise((resolve, reject) => {
		server.once('error', reject)
		server.listen(cfg.port, cfg.host, resolve)
	})
	const addr = server.address()
	getBrowser().catch((e) => log(`[browser] ${e.message}`)) // start Chromium now: fail fast, first render faster
	return {
		url: `http://${addr.address === '0.0.0.0' || addr.address === '::' ? '127.0.0.1' : addr.address}:${addr.port}`,
		port: addr.port,
		jobs,
		library,
		sessions,
		webhooks,
		async close() {
			webhooks.close()
			sessions.close()
			await jobs.close()
			await new Promise((r) => {
				server.close(r)
				server.closeAllConnections()
			})
			await closeBrowser()
		},
	}
}

function must(job) {
	if (!job) throw new HttpError(404, 'No such render')
	return job
}
