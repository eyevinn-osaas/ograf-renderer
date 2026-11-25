// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readManifest, checkRenderable, defaultData, splitGraphicRef } from './core/manifest.js'
import { getFormat, graphicSupportsFormat, unsupportedFormatMessage } from './core/formats.js'
import { planRender } from './core/schedule.js'
import { renderToDir, appendTail } from './capture.js'
import { detectTiming, planTiming } from './timing.js'
import { encode } from './encode.js'

export const RENDER_INFO_VERSION = 1

/** Load and check a graphic folder ("dir" or "dir#NAME.ograf.json" for template packs). */
export async function loadGraphic(graphicDir, manifestFile = null) {
	const { manifest, manifestFile: file } = await readManifest(graphicDir, manifestFile)
	const problems = checkRenderable(manifest)
	if (problems.length) throw new Error(`Graphic cannot be rendered: ${problems.join(' ')}`)
	return { manifest, manifestFile: file }
}

/** Duration in timeline frames from { durationFrames } or { duration } (seconds). */
export function durationFramesOf({ durationFrames, duration }, formatId) {
	if (durationFrames !== undefined) return Number(durationFrames)
	if (duration !== undefined) {
		const [num, den] = getFormat(formatId).frameRate
		return Math.round((Number(duration) * num) / den)
	}
	throw new Error('Give durationFrames or duration (seconds)')
}

/**
 * Render a graphic to outDir: frames/ (and fields/ for interlaced formats), the requested
 * encodes, and render.json describing the result.
 *
 * opts: { graphicDir, manifestFile?, data?, format, durationFrames | duration, schedule?,
 *         tailFrames?, encodes?: ['prores' | 'webm' | 'qtrle'], strictFormat?, onProgress, log, signal }
 */
export async function renderGraphic(opts) {
	const { graphicDir, manifestFile = null, format, schedule = 'auto', tailFrames = 0, encodes = [], strictFormat = false, onProgress = () => {}, log = () => {}, signal } = opts
	const fmt = getFormat(format)
	const { manifest, manifestFile: file } = await loadGraphic(graphicDir, manifestFile)
	if (strictFormat && !graphicSupportsFormat(manifest, format)) throw new Error(unsupportedFormatMessage(manifest, format))
	const data = opts.data ?? defaultData(manifest)
	const durationFrames = durationFramesOf(opts, format)
	if (!Number.isInteger(tailFrames) || tailFrames < 0) throw new Error('tailFrames must be a whole number ≥ 0')

	const outDir = path.resolve(opts.outDir)
	await fs.mkdir(outDir, { recursive: true })
	const t0 = Date.now()
	const timing = await detectTiming({ graphicDir, manifest, data, layout: fmt.layout, log })
	const plan = planRender(manifest, { format, durationFrames, schedule }, planTiming(timing))
	// Emulated graphics: a fixed wall-clock start, so the same request renders the same frames.
	const epochMs = opts.epochMs ?? Date.UTC(2026, 0, 1, 12, 0, 0)
	const result = await renderToDir({ graphicDir, manifest, data, plan, outDir, onProgress: (p) => onProgress({ stage: 'render', ...p }), log, signal, epochMs })
	await appendTail({ outDir, plan, tailFrames })

	const info = {
		version: RENDER_INFO_VERSION,
		graphic: { id: manifest.id, version: manifest.version, name: manifest.name, manifest: file },
		data,
		format: fmt.id,
		width: fmt.width,
		height: fmt.height,
		frameRate: fmt.frameRate,
		interlaced: fmt.interlaced,
		fieldOrder: fmt.interlaced ? fmt.fieldOrder : null,
		frames: result.frames + tailFrames,
		graphicFrames: result.frames,
		tailFrames,
		samples: result.samples,
		uniqueSamples: result.uniqueSamples,
		framesPattern: 'frames/%06d.png',
		fieldsPattern: fmt.interlaced ? 'fields/%06d.png' : null,
		schedule: plan.schedule,
		outAt: plan.outAt,
		timing,
		emulated: !!plan.emulate,
		alpha: 'straight',
		colorSpace: 'sRGB',
		encodes: {},
		renderedAt: new Date().toISOString(),
		renderedBy: os.hostname(),
		renderMs: 0,
	}
	for (const kind of encodes) {
		if (signal?.aborted) throw new Error('Render cancelled')
		info.encodes[kind] = await encode({ kind, outDir, info, signal, log, onProgress: (p) => onProgress({ stage: `encode:${kind}`, ...p }) })
	}
	info.renderMs = Date.now() - t0
	await fs.writeFile(path.join(outDir, 'render.json'), JSON.stringify(info, null, 2))
	return info
}

export { splitGraphicRef }
