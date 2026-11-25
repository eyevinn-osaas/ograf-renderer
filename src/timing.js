// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs/promises'
import path from 'node:path'
import { renderMode } from './core/manifest.js'
import { probeVisibility } from './capture.js'

const IN_NAMES = ['start', 'in', 'intro', 'play', 'animin', 'anim-in']
const OUT_NAMES = ['stop', 'out', 'outro', 'end', 'animout', 'anim-out']

/** Lottie marker comments come as "stop", "name:stop" or '{"name":"stop"}'. */
function markerName(cm) {
	let s = String(cm ?? '').trim()
	try {
		const j = JSON.parse(s)
		if (j && typeof j === 'object' && j.name) s = String(j.name)
	} catch {}
	return s.replace(/^name:/i, '').trim().toLowerCase()
}

/**
 * Find in/out segments in a Lottie animation bundled with the graphic (Streamshapers, Lottie exports).
 * Returns { file, fr, inStart, inEnd, outStart, outEnd } in frames, or null.
 */
export async function readLottieSegments(graphicDir) {
	const candidates = []
	async function walk(dir, depth) {
		let entries = []
		try {
			entries = await fs.readdir(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const e of entries) {
			const p = path.join(dir, e.name)
			if (e.isDirectory() && depth < 3 && !e.name.startsWith('.')) await walk(p, depth + 1)
			else if (e.isFile() && e.name.toLowerCase().endsWith('.json') && !e.name.toLowerCase().endsWith('.ograf.json')) candidates.push(p)
		}
	}
	await walk(graphicDir, 0)
	for (const file of candidates) {
		const st = await fs.stat(file)
		if (st.size > 50 * 1024 * 1024) continue
		let j
		try {
			j = JSON.parse(await fs.readFile(file, 'utf8'))
		} catch {
			continue
		}
		if (!j || typeof j.fr !== 'number' || !Array.isArray(j.layers) || !Array.isArray(j.markers)) continue
		const marks = j.markers.map((m) => ({ name: markerName(m.cm), tm: m.tm, dr: m.dr ?? 0 }))
		const inM = marks.find((m) => IN_NAMES.includes(m.name))
		const outM = marks.find((m) => OUT_NAMES.includes(m.name))
		if (!inM || !outM) continue
		return { file, fr: j.fr, inStart: inM.tm, inEnd: inM.tm + inM.dr, outStart: outM.tm, outEnd: outM.tm + outM.dr }
	}
	return null
}

const cache = new Map()

/**
 * How does this graphic react to time? Cached per graphic version and main-file change time.
 *
 * Probe: render t=5 s twice, once with the stop scheduled far later and once already finished.
 * A graphic that follows the schedule shows two different pictures (visible / gone). A graphic that
 * plays its own built-in timeline shows the same picture both times, although it was visible at 0.5 s.
 *
 * Returns { mode: "scheduled" } or { mode: "self-timed", holdAt, outStart, outDuration, source }
 * or { mode: "self-timed-unknown", note } when it is self-timed but its segments can't be found.
 */
export async function detectTiming({ graphicDir, manifest, data, layout = [1920, 1080], log = () => {} }) {
	// Realtime-only graphics run on our virtual clock, which follows the schedule by construction.
	if (renderMode(manifest) === 'emulated') return { mode: 'emulated' }
	const main = path.join(graphicDir, manifest.main || 'graphic.mjs')
	const mtime = (await fs.stat(main).catch(() => null))?.mtimeMs ?? 0
	const key = `${path.resolve(graphicDir)}|${manifest.id}|${manifest.main}|${manifest.version}|${mtime}|${layout.join('x')}`
	if (cache.has(key)) return cache.get(key)

	const promise = (async () => {
		try {
			const [far, done] = await Promise.all([
				probeVisibility({ graphicDir, manifest, data, layout, schedule: sched(60000), timestamps: [500, 5000] }),
				probeVisibility({ graphicDir, manifest, data, layout, schedule: sched(500), timestamps: [5000] }),
			])
			const selfTimed = far[1].hash === done[0].hash && !far[0].empty
			log(`[timing] ${manifest.id}: early=${far[0].empty ? 'empty' : 'visible'} hold=${far[1].empty ? 'empty' : 'visible'} same-after-stop=${far[1].hash === done[0].hash} -> ${selfTimed ? 'self-timed' : 'scheduled'}`)
			if (!selfTimed) return { mode: 'scheduled' }
			const seg = await readLottieSegments(graphicDir)
			if (!seg) {
				return {
					mode: 'self-timed-unknown',
					note: 'This graphic plays its own timeline and ignores the out marker, and its in/out segments could not be found. It will render as it plays by itself.',
				}
			}
			const f = (n) => (n * 1000) / seg.fr
			return {
				mode: 'self-timed',
				holdAt: f(Math.max(seg.inStart, seg.inEnd - 1)),
				outStart: f(seg.outStart),
				outDuration: f(seg.outEnd - seg.outStart),
				source: `Lottie markers in ${path.relative(graphicDir, seg.file)}`,
			}
		} catch (e) {
			log(`[timing] probe failed for ${manifest.id}: ${e.message}`)
			return { mode: 'scheduled', note: `Timing probe failed: ${e.message}` }
		}
	})()
	cache.set(key, promise)
	return promise
}

const sched = (stopAt) => [
	{ timestamp: 0, action: { type: 'playAction', params: {} } },
	{ timestamp: stopAt, action: { type: 'stopAction', params: {} } },
]

/** Timing to pass to planRender: only the fully known self-timed mode changes the plan. */
export function planTiming(timing) {
	return timing?.mode === 'self-timed' ? timing : { mode: 'scheduled' }
}
