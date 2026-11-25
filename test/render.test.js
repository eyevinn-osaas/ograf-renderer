// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

// Integration tests: run the real renderer (headless Chromium) on the fixture graphics through the CLI.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(here, '..', 'bin', 'ograf-renderer.js')
const FIXTURES = path.join(here, '..', 'fixtures', 'graphics')
const HAVE_FFMPEG = spawnSync(process.env.OGRAF_FFMPEG || 'ffmpeg', ['-version']).status === 0

export function ogr(...args) {
	return new Promise((resolve, reject) => {
		const p = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
		let out = ''
		let err = ''
		p.stdout.on('data', (d) => (out += d))
		p.stderr.on('data', (d) => (err += d))
		p.on('exit', (code) => {
			const events = out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
			const last = events.at(-1)
			if (code !== 0) reject(new Error(`exit ${code}: ${last?.message ?? err}`))
			else resolve(last)
		})
	})
}

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'ograf-render-'))
const read = async (p) => PNG.sync.read(await fs.readFile(p))
const maxAlpha = (png) => {
	let m = 0
	for (let i = 3; i < png.data.length; i += 4) if (png.data[i] > m) m = png.data[i]
	return m
}
const pngs = async (dir) => (await fs.readdir(dir)).filter((f) => f.endsWith('.png')).sort()
const frameOf = (out) => (i) => read(path.join(out, 'frames', `${String(i).padStart(6, '0')}.png`))

test('1080p25: transparent in/out, opaque hold, correct size, render.json', async () => {
	const out = await tmp()
	const r = await ogr('render', '--graphic', path.join(FIXTURES, 'lower-third'), '--out', out, '--format', '1080p25', '--duration', '75')
	assert.equal(r.event, 'done')
	const files = await pngs(path.join(out, 'frames'))
	assert.equal(files.length, 75)
	const frame = frameOf(out)
	const first = await frame(0)
	assert.deepEqual([first.width, first.height], [1920, 1080])
	assert.equal(maxAlpha(first), 0, 'first frame is fully transparent')
	assert.equal(maxAlpha(await frame(37)), 255, 'hold has opaque pixels')
	assert.equal(maxAlpha(await frame(74)), 0, 'out-animation finishes on the last frame')
	const info = JSON.parse(await fs.readFile(path.join(out, 'render.json'), 'utf8'))
	assert.deepEqual([info.format, info.frames, info.graphic.id], ['1080p25', 75, 'ograf-nle-lower-third'])
})

test('2160p25: rendered at twice the layout', async () => {
	const out = await tmp()
	await ogr('render', '--graphic', path.join(FIXTURES, 'lower-third'), '--out', out, '--format', '2160p25', '--seconds', '2')
	const files = await pngs(path.join(out, 'frames'))
	assert.equal(files.length, 50)
	const mid = await frameOf(out)(25) // 1.0 s: in the hold (out-animation starts at 1.26 s)
	assert.deepEqual([mid.width, mid.height], [3840, 2160])
	assert.equal(maxAlpha(mid), 255)
})

test('social formats: vertical and square render at their size', async () => {
	for (const [format, w, h] of [
		['1080x1920p25', 1080, 1920],
		['1080x1080p50', 1080, 1080],
	]) {
		const out = await tmp()
		await ogr('render', '--graphic', path.join(FIXTURES, 'lower-third'), '--out', out, '--format', format, '--duration', '50')
		const mid = await frameOf(out)(25)
		assert.deepEqual([mid.width, mid.height], [w, h], format)
		assert.equal(maxAlpha(mid), 255, `${format}: the graphic is visible`)
	}
})

test('1080i50: fields + woven frames, rows from correct field', async () => {
	const out = await tmp()
	await ogr('render', '--graphic', path.join(FIXTURES, 'headline'), '--out', out, '--format', '1080i50', '--duration', '20')
	const fields = await pngs(path.join(out, 'fields'))
	const frames = await pngs(path.join(out, 'frames'))
	assert.equal(fields.length, 40)
	assert.equal(frames.length, 20)
	let sawMotion = false
	for (let f = 0; f < frames.length; f++) {
		const [a, b, w] = await Promise.all([read(path.join(out, 'fields', fields[2 * f])), read(path.join(out, 'fields', fields[2 * f + 1])), read(path.join(out, 'frames', frames[f]))])
		const stride = a.width * 4
		for (let y = 0; y < a.height; y++) {
			const src = y % 2 === 0 ? a : b // upper field first
			assert.ok(w.data.subarray(y * stride, (y + 1) * stride).equals(src.data.subarray(y * stride, (y + 1) * stride)), `frame ${f} row ${y}`)
		}
		if (!a.data.equals(b.data)) sawMotion = true
	}
	assert.ok(sawMotion, 'fields differ during animation')
})

test('self-timed graphic: detected, held until the out marker', async () => {
	const g = path.join(FIXTURES, 'self-timed')
	const probe = await ogr('probe', '--graphic', g)
	assert.equal(probe.timing.mode, 'self-timed')
	assert.equal(probe.timing.holdAt, 960)
	assert.equal(probe.timing.outStart, 1000)

	const out = await tmp()
	const r = await ogr('render', '--graphic', g, '--out', out, '--format', '1080p25', '--duration', '100', '--out-frame', '60')
	assert.equal(r.outAt, 2400)
	const frame = frameOf(out)
	assert.equal(maxAlpha(await frame(0)), 0)
	assert.equal(maxAlpha(await frame(50)), 255, 'held on screen long after its own 1.5 s timeline')
	assert.equal(maxAlpha(await frame(59)), 255, 'still on screen just before the out marker')
	assert.ok(maxAlpha(await frame(65)) < 255, 'fading out after the marker')
	assert.equal(maxAlpha(await frame(99)), 0, 'gone at the end')
})

test('scheduled graphic: out marker moves the out-animation; tail frames are transparent', async () => {
	const out = await tmp()
	const r = await ogr('render', '--graphic', path.join(FIXTURES, 'lower-third'), '--out', out, '--format', '1080p25', '--duration', '100', '--out-frame', '40', '--tail', '10')
	assert.equal(r.outAt, 1600)
	assert.deepEqual([r.frames, r.graphicFrames, r.tailFrames], [110, 100, 10])
	const frame = frameOf(out)
	assert.equal(maxAlpha(await frame(39)), 255)
	assert.equal(maxAlpha(await frame(70)), 0, 'out-animation (0.7 s) finished well before the end')
	assert.equal(maxAlpha(await frame(109)), 0)
})

test('two-step graphic: continue at the step marker', async () => {
	const out = await tmp()
	const r = await ogr('render', '--graphic', path.join(FIXTURES, 'two-step'), '--out', out, '--format', '1080p25', '--duration', '100', '--steps', '50')
	assert.deepEqual(
		r.schedule.map((s) => [s.timestamp, s.action.type, s.action.params.delta ?? null]),
		[
			[0, 'playAction', null],
			[2000, 'playAction', 1],
			[3360, 'stopAction', null],
		]
	)
	const titleRows = async (i) => {
		const png = await frameOf(out)(i)
		let max = 0
		for (let y = 905; y < 945; y++) for (let x = 140; x < 500; x++) max = Math.max(max, png.data[(y * png.width + x) * 4 + 3])
		return max
	}
	assert.equal(await titleRows(45), 0, 'no title line before the step marker')
	assert.equal(await titleRows(70), 255, 'title line after "continue"')
})

test('realtime-only graphic: virtual clock, deterministic, follows the schedule', async () => {
	const g = path.join(FIXTURES, 'realtime-only')
	const [outA, outB] = [await tmp(), await tmp()]
	const r = await ogr('render', '--graphic', g, '--out', outA, '--format', '1080p25', '--duration', '125', '--out-frame', '100')
	assert.equal(r.timing.mode, 'emulated')
	await ogr('render', '--graphic', g, '--out', outB, '--format', '1080p25', '--duration', '125', '--out-frame', '100')
	for (const f of await pngs(path.join(outA, 'frames'))) {
		const [a, b] = await Promise.all([fs.readFile(path.join(outA, 'frames', f)), fs.readFile(path.join(outB, 'frames', f))])
		assert.ok(a.equals(b), `frame ${f} identical in both renders`)
	}
	const frame = frameOf(outA)
	// Progress bar (rAF + performance.now, 0 -> 588 px over 3 s) measured on its row.
	const barWidth = async (i) => {
		const png = await frame(i)
		let w = 0
		for (let y = 0; y < png.height; y++) {
			let run = 0
			for (let x = 0; x < png.width; x++) {
				const o = (y * png.width + x) * 4
				run = png.data[o] > 240 && png.data[o + 1] > 200 && png.data[o + 2] < 120 && png.data[o + 3] === 255 ? run + 1 : 0
				w = Math.max(w, run)
			}
		}
		return w
	}
	const [w25, w50] = [await barWidth(25), await barWidth(50)]
	assert.ok(Math.abs(w25 - 196) <= 3, `bar at 1.0 s is a third (${w25})`)
	assert.ok(Math.abs(w50 - 392) <= 3, `bar at 2.0 s is two thirds (${w50})`)
	assert.equal(maxAlpha(await frame(60)), 255, 'on screen in the hold')
	assert.equal(maxAlpha(await frame(124)), 0, 'out-transition (0.5 s) after the out marker at 4 s is finished')
})

test('rejects graphics that support neither real-time nor non-real-time', async () => {
	const dir = await tmp()
	await fs.cp(path.join(FIXTURES, 'lower-third'), dir, { recursive: true })
	const mf = path.join(dir, 'lower-third.ograf.json')
	const m = JSON.parse(await fs.readFile(mf, 'utf8'))
	m.supportsNonRealTime = false
	m.supportsRealTime = false
	await fs.writeFile(mf, JSON.stringify(m))
	await assert.rejects(ogr('render', '--graphic', dir, '--out', await tmp(), '--format', '1080p25', '--duration', '5'), /neither real-time nor non-real-time/)
})

test('encodes: ProRes 4444 and VP9 with alpha', { skip: !HAVE_FFMPEG && 'FFmpeg not found' }, async () => {
	const out = await tmp()
	const r = await ogr('render', '--graphic', path.join(FIXTURES, 'lower-third'), '--out', out, '--format', '1080i50', '--duration', '25', '--encode', 'prores,webm')
	assert.equal(r.encodes.prores.file, 'graphic.mov')
	assert.equal(r.encodes.webm.file, 'graphic.webm')
	const probe = (file) => {
		const p = spawnSync(process.env.OGRAF_FFPROBE || 'ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', path.join(out, file)], { encoding: 'utf8' })
		return p.status === 0 ? JSON.parse(p.stdout).streams[0] : null
	}
	const mov = probe('graphic.mov')
	if (mov) {
		assert.deepEqual([mov.codec_name, mov.pix_fmt.slice(0, 8), mov.width], ['prores', 'yuva444p', 1920])
		assert.equal(mov.nb_frames, '25')
		const f = spawnSync(process.env.OGRAF_FFPROBE || 'ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'frame=interlaced_frame,top_field_first', '-read_intervals', '%+#1', '-of', 'csv=p=0', path.join(out, 'graphic.mov')], { encoding: 'utf8' })
		assert.equal(f.stdout.trim(), '1,1', 'interlaced, top field first')
	}
	const webm = probe('graphic.webm')
	if (webm) assert.equal(webm.codec_name, 'vp9')
})
