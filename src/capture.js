// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { sha256, linkOrCopy } from './core/util.js'
import { WeavePool } from './core/weave-pool.js'
import { startStaticServer } from './static-server.js'
import { newContext } from './browser.js'
import { CHILD_FRAME_BOOTSTRAP } from '../runtime/virtual-time.js'

const RUNTIME_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'runtime')

export const frameName = (i) => `${String(i).padStart(6, '0')}.png`
const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) })

/** Parallel pages per render: enough to keep the CPU busy without starving the machine. */
export function defaultParallelism() {
	if (process.env.OGRAF_PARALLEL) return Math.max(1, parseInt(process.env.OGRAF_PARALLEL, 10) || 1)
	return Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2)))
}

/**
 * Open the render page for a graphic in a new page of `context`, sized for the layout.
 * Returns { page, cdp, call(fn, arg), errors }.
 */
async function openRenderPage({ context, serverUrl, layout: [lw, lh], scale = 1, emulate = false, log = () => {}, signal }) {
	const page = await context.newPage()
	const errors = []
	page.on('console', (m) => log(`[graphic:${m.type()}] ${m.text()}`))
	page.on('pageerror', (e) => log(`[graphic:error] ${e.message}`))
	page.on('error', (e) => errors.push(`Render page crashed: ${e.message}`))
	// Graphics may not open windows or leave the local file server.
	page.on('popup', (p) => p.close().catch(() => {}))
	const cdp = await page.createCDPSession()
	// Same-origin child frames (templates wrapping an HTML page) join the virtual clock at document start.
	if (emulate) await page.evaluateOnNewDocument(CHILD_FRAME_BOOTSTRAP)
	// Straight over CDP: puppeteer's setViewport doesn't reliably apply deviceScaleFactor (UHD came out HD).
	await cdp.send('Emulation.setDeviceMetricsOverride', { width: lw, height: lh, deviceScaleFactor: scale, mobile: false })
	await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
	await page.goto(`${serverUrl}/runtime/render.html${process.env.OGRAF_VT_DEBUG ? '?vtdebug' : ''}`, { waitUntil: 'load' })
	const call = async (fn, arg) => {
		if (signal?.aborted) throw new Error('Render cancelled')
		if (errors.length) throw new Error(errors.join('; '))
		return page.evaluate((f, a) => window.__ograf[f](a), fn, arg ?? null)
	}
	const capture = async () => {
		const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false, optimizeForSpeed: true })
		return Buffer.from(data, 'base64')
	}
	return { page, call, capture }
}

/**
 * Render a planned graphic into outDir.
 *
 * Output:
 *   outDir/frames/000000.png …  timeline-rate frames (interlaced formats: woven)
 *   outDir/fields/000000.png …  interlaced formats only: the temporal samples (= p50 master)
 *
 * Samples are split into contiguous chunks rendered by parallel pages. This relies on the OGraf
 * non-realtime contract: goToTime(t) renders the state at t regardless of seek order.
 * Within a chunk, held (identical) frames are hard-linked to the previous file.
 */
export async function renderToDir({ graphicDir, manifest, data, plan, outDir, onProgress = () => {}, log = () => {}, signal, parallel = defaultParallelism(), epochMs }) {
	const fmt = plan.format
	const samplesDir = path.join(outDir, fmt.interlaced ? 'fields' : 'frames')
	const framesDir = path.join(outDir, 'frames')
	await fs.mkdir(samplesDir, { recursive: true })
	await fs.mkdir(framesDir, { recursive: true })

	const total = plan.sampleCount + (fmt.interlaced ? plan.durationFrames : 0)
	let done = 0
	const tick = () => onProgress({ done: ++done, total })

	// Chunk boundaries fall on frame boundaries so each field pair stays within one chunk.
	const step = fmt.fieldsPerFrame
	const frames = plan.sampleCount / step
	// No point splitting tiny renders. Emulated (realtime-only) graphics always use one page: a page
	// that jumps straight into the middle of a live template's animation can differ slightly from
	// continuous playback, which would show as a jump at the chunk boundary.
	const n = plan.emulate ? 1 : Math.max(1, Math.min(parallel, Math.ceil(frames / 25)))
	const chunks = []
	for (let c = 0; c < n; c++) {
		const a = Math.floor((c * frames) / n) * step
		const b = Math.floor(((c + 1) * frames) / n) * step
		if (b > a) chunks.push([a, b])
	}

	const server = await startStaticServer({ '/runtime/': RUNTIME_DIR, '/graphic/': graphicDir })
	const context = await newContext()
	const pool = fmt.interlaced ? new WeavePool() : null
	const abort = new AbortController()
	const onAbort = () => abort.abort()
	signal?.addEventListener('abort', onAbort)
	const t0 = performance.now()
	try {
		const results = await Promise.all(
			chunks.map(([a, b], idx) =>
				renderChunk({ context, server, manifest, data, plan, epochMs, a, b, samplesDir, framesDir, pool, tick, log: (m) => log(`[p${idx}] ${m}`), signal: abort.signal }).catch((e) => {
					abort.abort() // stop sibling pages
					throw e
				})
			)
		)
		const unique = results.reduce((s, r) => s + r.unique, 0)
		const ms = performance.now() - t0
		log(`[timing] ${plan.sampleCount} samples in ${(ms / 1000).toFixed(1)}s with ${chunks.length} page(s): ${(ms / plan.sampleCount).toFixed(1)} ms/sample`)
		return { samples: plan.sampleCount, frames: plan.durationFrames, uniqueSamples: unique, pages: chunks.length }
	} finally {
		signal?.removeEventListener('abort', onAbort)
		await pool?.close()
		await context.close().catch(() => {})
		await server.close()
	}
}

async function renderChunk({ context, server, manifest, data, plan, epochMs, a, b, samplesDir, framesDir, pool, tick, log, signal }) {
	const fmt = plan.format
	const [lw, lh] = fmt.layout
	const frameTasks = []
	const { page, call, capture } = await openRenderPage({ context, serverUrl: server.url, layout: fmt.layout, scale: fmt.scale, emulate: plan.emulate, log, signal })
	try {
		const [num, den] = fmt.sampleRate
		await call('load', {
			mainUrl: `${server.url}/graphic/${manifest.main}`,
			data,
			width: lw,
			height: lh,
			frameRate: num / den,
			emulate: !!plan.emulate,
			epochMs,
			sampleRate: num / den,
		})
		await call('setSchedule', plan.schedule)

		let prevHash = null
		let prevFile = null
		let prevPair = null
		let unique = 0
		const files = {}
		const hashes = {}

		for (let i = a; i < b; i++) {
			await call('seek', plan.timestamps[i])
			const buf = await capture()
			if (i === a) {
				const sz = pngSize(buf)
				if (sz.width !== fmt.width || sz.height !== fmt.height) throw new Error(`Captured ${sz.width}x${sz.height}, expected ${fmt.width}x${fmt.height}`)
			}
			const hash = sha256(buf)
			const file = path.join(samplesDir, frameName(i))
			if (hash === prevHash) await linkOrCopy(prevFile, file)
			else {
				await fs.writeFile(file, buf)
				unique++
			}
			prevHash = hash
			prevFile = file
			files[i] = file
			hashes[i] = hash
			tick()

			// Interlaced: weave frame f from samples 2f, 2f+1 on the worker pool while capture continues.
			if (fmt.interlaced && i % 2 === 1) {
				const f = (i - 1) / 2
				const s0 = i - 1
				const pair = `${hashes[s0]}:${hashes[i]}`
				const out = path.join(framesDir, frameName(f))
				let task
				if (pair === prevPair) {
					const prevOut = path.join(framesDir, frameName(f - 1))
					task = frameTasks.at(-1).then(() => linkOrCopy(prevOut, out))
				} else if (hashes[s0] === hashes[i]) task = linkOrCopy(files[s0], out) // identical fields: woven == sample
				else task = pool.weave(files[s0], files[i], out, fmt.fieldOrder)
				prevPair = pair
				frameTasks.push(task.then(tick))
			}
		}
		await Promise.all(frameTasks)
		// A graphic's dispose() must never hold up a finished render.
		await withTimeout(call('dispose'), 2000).catch((e) => log(`[teardown] dispose: ${e.message}`))
		return { unique }
	} finally {
		await Promise.allSettled(frameTasks)
		await page.close().catch(() => {})
	}
}

/**
 * Append tailFrames fully transparent frames after the graphic (and their fields for interlaced
 * formats), numbered on from the last one. One file, the rest hard links.
 */
export async function appendTail({ outDir, plan, tailFrames }) {
	if (!(tailFrames > 0)) return
	const fmt = plan.format
	const blank = PNG.sync.write(new PNG({ width: fmt.width, height: fmt.height })) // zero-filled: transparent black
	const write = async (dir, from, count) => {
		const first = path.join(dir, frameName(from))
		await fs.writeFile(first, blank)
		for (let i = 1; i < count; i++) await linkOrCopy(first, path.join(dir, frameName(from + i)))
	}
	await write(path.join(outDir, 'frames'), plan.durationFrames, tailFrames)
	if (fmt.interlaced) await write(path.join(outDir, 'fields'), plan.sampleCount, tailFrames * fmt.fieldsPerFrame)
}

/**
 * Render a few timestamps at the format's layout (scale 1) and report, per timestamp, a hash and
 * whether the frame is fully transparent. Used to find out how a graphic reacts to time (see timing.js).
 */
export async function probeVisibility({ graphicDir, manifest, data, schedule, timestamps, layout = [1920, 1080], seekTimeoutMs = 8000 }) {
	const [width, height] = layout
	const server = await startStaticServer({ '/runtime/': RUNTIME_DIR, '/graphic/': graphicDir })
	const context = await newContext()
	try {
		const { call, capture } = await openRenderPage({ context, serverUrl: server.url, layout })
		await withTimeout(call('load', { mainUrl: `${server.url}/graphic/${manifest.main}`, data, width, height, frameRate: 25 }), 20000)
		await withTimeout(call('setSchedule', schedule), seekTimeoutMs)
		const out = []
		for (const ts of timestamps) {
			await withTimeout(call('seek', ts), seekTimeoutMs)
			const buf = await capture()
			out.push({ ts, hash: sha256(buf), empty: isTransparent(buf) })
		}
		return out
	} finally {
		await context.close().catch(() => {})
		await server.close()
	}
}

/** Render one frame of a graphic at timestamp ts (ms) and return the PNG: thumbnails and previews. */
export async function renderStill({ graphicDir, manifest, data, schedule, ts, layout = [1920, 1080], scale = 1, emulate = false }) {
	const [width, height] = layout
	const server = await startStaticServer({ '/runtime/': RUNTIME_DIR, '/graphic/': graphicDir })
	const context = await newContext()
	try {
		const { call, capture } = await openRenderPage({ context, serverUrl: server.url, layout, scale, emulate })
		await withTimeout(call('load', { mainUrl: `${server.url}/graphic/${manifest.main}`, data, width, height, frameRate: 25, emulate, sampleRate: 25 }), 20000)
		await withTimeout(call('setSchedule', schedule), 8000)
		await withTimeout(call('seek', ts), 30000)
		return await capture()
	} finally {
		await context.close().catch(() => {})
		await server.close()
	}
}

function isTransparent(pngBuf) {
	const img = PNG.sync.read(pngBuf)
	for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== 0) return false
	return true
}

export function withTimeout(promise, ms) {
	let t
	return Promise.race([promise, new Promise((_, rej) => (t = setTimeout(() => rej(new Error(`timeout after ${ms} ms`)), ms)))]).finally(() => clearTimeout(t))
}
