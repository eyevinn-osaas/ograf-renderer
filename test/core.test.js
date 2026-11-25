// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

// Formats, scheduling, manifests and interlacing (shared with the OGraf NLE renderer).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PNG } from 'pngjs'
import { getFormat, sampleTimestamp, graphicSupportsFormat, supportedFormats, configuredFormats } from '../src/core/formats.js'
import { planRender } from '../src/core/schedule.js'
import { checkRenderable, defaultData, renderMode, splitGraphicRef } from '../src/core/manifest.js'
import { weaveFields } from '../src/core/interlace.js'
test('formats', () => {
	const i50 = getFormat('1080i50')
	assert.equal(i50.interlaced, true)
	assert.deepEqual(i50.sampleRate, [50, 1])
	const uhd = getFormat('2160p50')
	assert.equal(uhd.width, 3840)
	assert.equal(uhd.height, 2160)
	assert.equal(sampleTimestamp(3, [50, 1]), 60)
	assert.equal(sampleTimestamp(1, [30000, 1001]), 1001 / 30)
	assert.throws(() => getFormat('720p60'))
	const v = getFormat('1080x1920p50')
	assert.deepEqual([v.width, v.height, v.interlaced], [1080, 1920, false])
	assert.deepEqual([getFormat('1080x1080p25').width, getFormat('1080x1080p25').height], [1080, 1080])
})

test('social formats need a graphic that declares the size; 16:9 takes every graphic', () => {
	const none = { id: 'a' }
	const hd = { renderRequirements: [{ resolution: { width: { exact: 1920 }, height: { exact: 1080 } }, frameRate: { exact: 25 } }] }
	const vertical = { renderRequirements: [{ resolution: { width: { exact: 1080 }, height: { exact: 1920 } } }] }
	const flexible = { renderRequirements: [{ resolution: { width: { min: 600, max: 4000, ideal: 1920 } } }] }
	const onlyRate = { renderRequirements: [{ frameRate: { exact: 25 } }] }

	for (const m of [none, hd, vertical, flexible, onlyRate]) {
		assert.ok(graphicSupportsFormat(m, '1080i50'))
		assert.ok(graphicSupportsFormat(m, '2160p50'), 'frame-rate constraints are ignored')
	}
	assert.ok(!graphicSupportsFormat(none, '1080x1920p25'), 'no declaration: 16:9 only')
	assert.ok(!graphicSupportsFormat(hd, '1080x1080p25'))
	assert.ok(!graphicSupportsFormat(onlyRate, '1080x1920p25'), 'a requirement without a size is no declaration')
	assert.ok(graphicSupportsFormat(vertical, '1080x1920p50'))
	assert.ok(!graphicSupportsFormat(vertical, '1080x1080p25'))
	assert.ok(graphicSupportsFormat(flexible, '1080x1920p25'), 'a width range that fits counts')
	assert.ok(graphicSupportsFormat(flexible, '1080x1080p25'))
	assert.deepEqual(
		supportedFormats(vertical).filter((id) => id.startsWith('1080x')),
		['1080x1920p25', '1080x1920p50']
	)
})

test('config graphicFormats: shorthands, exact refs, folders and template packs', () => {
	const config = {
		graphicFormats: {
			'demo:graphics/Loopic/lower-third': ['square'],
			'demo:graphics/SPX/': ['square', '1080x1920p25', 'nonsense'],
			'demo:graphics/Other#ONE.ograf.json': 'vertical',
		},
	}
	assert.deepEqual(configuredFormats(config, 'demo:graphics/Loopic/lower-third'), ['1080x1080p25', '1080x1080p50'])
	assert.deepEqual(configuredFormats(config, 'demo:graphics/Loopic/lower-third2'), [], 'a name prefix is not a folder')
	assert.deepEqual(configuredFormats(config, 'demo:graphics/SPX/Template_Pack_1.4.0#NAME_LEFT.ograf.json'), ['1080x1080p25', '1080x1080p50', '1080x1920p25'])
	assert.deepEqual(configuredFormats(config, 'demo:graphics/Other#ONE.ograf.json'), ['1080x1920p25', '1080x1920p50'])
	assert.deepEqual(configuredFormats({}, 'demo:x'), [])

	const none = { id: 'vendor' }
	const extra = configuredFormats(config, 'demo:graphics/Loopic/lower-third')
	assert.ok(graphicSupportsFormat(none, '1080x1080p50', extra))
	assert.ok(!graphicSupportsFormat(none, '1080x1920p25', extra))
})

test('auto schedule ends out-animation on the last sample', () => {
	const manifest = { actionDurations: [{ type: 'stopAction', duration: 1100 }] }
	const plan = planRender(manifest, { format: '1080p50', durationFrames: 250 })
	assert.equal(plan.sampleCount, 250)
	assert.equal(plan.timestamps.at(-1), 4980)
	assert.deepEqual(
		plan.schedule.map((s) => [s.timestamp, s.action.type]),
		[
			[0, 'playAction'],
			[3880, 'stopAction'],
		]
	)
})

test('interlaced renders two samples per frame', () => {
	const plan = planRender({}, { format: '1080i50', durationFrames: 125 })
	assert.equal(plan.sampleCount, 250)
	assert.equal(plan.timestamps[1], 20)
	// default stop duration 1000ms
	assert.equal(plan.schedule[1].timestamp, 3980)
})

test('out marker places the out-animation start', () => {
	const plan = planRender({}, { format: '1080p25', durationFrames: 250, schedule: { outFrame: 100 } })
	assert.equal(plan.outAt, 4000)
	assert.equal(plan.schedule[1].timestamp, 4000)
	assert.equal(plan.schedule[1].action.type, 'stopAction')
	// interlaced: frame 100 = sample 200 = 4000 ms
	assert.equal(planRender({}, { format: '1080i50', durationFrames: 250, schedule: { outFrame: 100 } }).outAt, 4000)
	// beyond the clip: clamped to the last sample
	assert.equal(planRender({}, { format: '1080p25', durationFrames: 50, schedule: { outFrame: 999 } }).outAt, 1960)
	assert.throws(() => planRender({}, { format: '1080p25', durationFrames: 50, schedule: { outFrame: -1 } }))
})

test('multi-step graphics: continue markers', () => {
	const m = { stepCount: 3 }
	// No markers: steps 2 and 3 spaced evenly before the out-animation (auto out at 9960-1000).
	const auto = planRender(m, { format: '1080p25', durationFrames: 250 })
	assert.deepEqual(
		auto.schedule.map((s) => [s.timestamp, s.action.type, s.action.params.delta ?? null]),
		[
			[0, 'playAction', null],
			[2987, 'playAction', 1],
			[5973, 'playAction', 1],
			[8960, 'stopAction', null],
		]
	)
	assert.deepEqual(auto.steps.map((s) => [s.step, s.auto]), [[2, true], [3, true]])

	// Step 2 at frame 50 (2 s), step 3 still automatic, out marker at frame 200.
	const set = planRender(m, { format: '1080i50', durationFrames: 250, schedule: { outFrame: 200, steps: [50, null] } })
	assert.deepEqual(set.steps.map((s) => [s.step, s.at, s.auto]), [[2, 2000, false], [3, 5333, true]])
	assert.equal(set.outAt, 8000)

	// stepCount 1 ignores step markers.
	assert.equal(planRender({ stepCount: 1 }, { format: '1080p25', durationFrames: 50, schedule: { steps: [10] } }).schedule.length, 2)
	assert.throws(() => planRender(m, { format: '1080p25', durationFrames: 50, schedule: { steps: [-4] } }))
	// "auto" and {} mean the same
	assert.deepEqual(planRender(m, { format: '1080p25', durationFrames: 50, schedule: {} }).schedule, planRender(m, { format: '1080p25', durationFrames: 50 }).schedule)
})

test('self-timed graphics: hold the in-animation until the out marker', () => {
	// Like a Lottie with "start" 0-25 and "stop" 25-42 at 25 fps.
	const timing = { mode: 'self-timed', holdAt: 960, outStart: 1000, outDuration: 680 }
	const plan = planRender({}, { format: '1080p25', durationFrames: 250 }, timing)
	assert.equal(plan.mode, 'self-timed')
	assert.equal(plan.outAt, 9960 - 680)
	const at = (ms) => plan.timestamps[ms / 40]
	assert.equal(at(0), 0)
	assert.equal(at(480), 480) // in-animation plays normally
	assert.equal(at(2000), 960) // held on the last in-frame
	assert.equal(at(9000), 960)
	assert.equal(at(9280), 1000) // out marker: out segment starts
	assert.equal(at(9960), 1680) // ends on the last frame of the out segment
	assert.deepEqual(plan.schedule.map((s) => s.action.params.skipAnimation), [true])

	const marked = planRender({}, { format: '1080p25', durationFrames: 250, schedule: { outFrame: 100 } }, timing)
	assert.equal(marked.timestamps[99], 960)
	assert.equal(marked.timestamps[100], 1000)
	assert.equal(marked.timestamps[249], 1000 + (9960 - 4000))
})

test('short clip clamps stop to 0', () => {
	const plan = planRender({}, { format: '1080p25', durationFrames: 10 })
	assert.equal(plan.schedule[1].timestamp, 0)
})

test('custom schedule passes through sorted', () => {
	const plan = planRender({}, {
		format: '1080p25',
		durationFrames: 100,
		schedule: [
			{ timestamp: 2000, action: { type: 'stopAction' } },
			{ timestamp: 0, action: { type: 'playAction' } },
		],
	})
	assert.deepEqual(plan.schedule.map((s) => s.action.type), ['playAction', 'stopAction'])
})

test('manifest helpers', () => {
	assert.equal(checkRenderable({ main: 'g.mjs', supportsNonRealTime: true }).length, 0)
	assert.equal(checkRenderable({ main: 'g.mjs', supportsRealTime: true }).length, 0, 'realtime-only graphics are emulated')
	assert.equal(renderMode({ supportsRealTime: true }), 'emulated')
	assert.equal(renderMode({ supportsNonRealTime: true, supportsRealTime: true }), 'non-realtime')
	assert.equal(checkRenderable({ main: 'g.mjs', supportsRealTime: false, supportsNonRealTime: false }).length, 1)
	assert.deepEqual(splitGraphicRef('lib:SPX/Pack#TITLE.ograf.json'), { ref: 'lib:SPX/Pack', manifestFile: 'TITLE.ograf.json' })
	assert.deepEqual(splitGraphicRef('lib:x'), { ref: 'lib:x', manifestFile: null })
	assert.deepEqual(defaultData({ schema: { properties: { a: { default: 1 }, b: {} } } }), { a: 1 })
})

test('weaveFields interleaves rows by field order', () => {
	const mk = (v) => {
		const p = new PNG({ width: 2, height: 4 })
		p.data.fill(v)
		return PNG.sync.write(p)
	}
	const rowVals = (buf) => {
		const p = PNG.sync.read(buf)
		return Array.from({ length: p.height }, (_, y) => p.data[y * p.width * 4])
	}
	assert.deepEqual(rowVals(weaveFields(mk(10), mk(200), 'upper')), [10, 200, 10, 200])
	assert.deepEqual(rowVals(weaveFields(mk(10), mk(200), 'lower')), [200, 10, 200, 10])
})
