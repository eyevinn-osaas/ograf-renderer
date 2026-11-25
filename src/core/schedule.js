// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

import { getFormat, sampleTimestamp } from './formats.js'
import { renderMode } from './manifest.js'

export const DEFAULT_ACTION_DURATION_MS = 1000

/** Look up a declared action duration from the manifest ("actionDurations"). */
export function actionDuration(manifest, type, customActionId) {
	const list = Array.isArray(manifest?.actionDurations) ? manifest.actionDurations : []
	const hit = list.find((d) => d.type === type && (type !== 'customAction' || d.customActionId === customActionId))
	return typeof hit?.duration === 'number' ? hit.duration : undefined
}

/**
 * The job's timing choice, normalised: { outFrame?: n, steps?: [n | null, …] }.
 * Accepts "auto" (everything automatic), { outFrame } and { outFrame?, steps }.
 */
export function normalizeSchedule(schedule) {
	if (schedule === 'auto' || schedule === undefined || schedule === null) return {}
	const ok = (v) => Number.isInteger(v) && v >= 0
	if (typeof schedule === 'object' && !Array.isArray(schedule)) {
		const out = {}
		if (schedule.outFrame !== undefined) {
			if (!ok(schedule.outFrame)) throw new Error(`Invalid outFrame ${schedule.outFrame}`)
			out.outFrame = schedule.outFrame
		}
		if (schedule.steps !== undefined) {
			if (!Array.isArray(schedule.steps) || !schedule.steps.every((s) => s === null || ok(s))) throw new Error('steps must be a list of frames')
			out.steps = schedule.steps
		}
		return out
	}
	throw new Error(`Unknown schedule ${JSON.stringify(schedule)}`)
}

/**
 * Compute what to render for a job.
 *
 * durationFrames is in timeline frames of the format (e.g. 25/s for 1080i50).
 *
 * schedule (the job's timing choice):
 *   "auto"            -> out-animation placed so it finishes on the last sample.
 *   { outFrame: n }   -> out-animation starts at timeline frame n (the "out marker").
 *   { steps: [n, …] } -> multi-step graphics (manifest stepCount > 1): step k+2 ("continue")
 *                        starts at frame steps[k]; missing entries are spaced evenly.
 *   array             -> custom action schedule, used verbatim (no out marker).
 *
 * timing (how the graphic reacts to time; from probeTiming, default "scheduled"):
 *   { mode: "scheduled" }  -> spec behaviour: the graphic follows setActionsSchedule.
 *   { mode: "self-timed", holdAt, outStart, outDuration }
 *        -> the graphic plays its own built-in timeline (in, then out straight after) and ignores
 *           the schedule. We remap time instead: play the in-animation, hold its last frame
 *           (holdAt) until the out marker, then continue from outStart.
 *
 * Returns { format, durationFrames, sampleCount, timestamps (graphic time per sample),
 *           schedule (sent to the graphic), outAt (timeline ms or null), outDuration, mode }.
 */
export function planRender(manifest, { format, durationFrames, schedule = 'auto' }, timing = { mode: 'scheduled' }) {
	const fmt = getFormat(format)
	if (!Number.isInteger(durationFrames) || durationFrames < 1) {
		throw new Error(`durationFrames must be a positive integer, got ${durationFrames}`)
	}
	const sampleCount = durationFrames * fmt.fieldsPerFrame
	const timelineTs = Array.from({ length: sampleCount }, (_, i) => sampleTimestamp(i, fmt.sampleRate))
	const lastTs = timelineTs[timelineTs.length - 1]

	if (Array.isArray(schedule)) {
		const actions = schedule
			.map((e) => ({ timestamp: e.timestamp, action: { type: e.action.type, params: e.action.params ?? {} } }))
			.sort((a, b) => a.timestamp - b.timestamp)
		return { format: fmt, durationFrames, sampleCount, timestamps: timelineTs, schedule: actions, outAt: null, outDuration: null, mode: 'custom', emulate: renderMode(manifest) === 'emulated' }
	}

	const selfTimed = timing?.mode === 'self-timed'
	const outDuration = selfTimed ? timing.outDuration : (actionDuration(manifest, 'stopAction') ?? DEFAULT_ACTION_DURATION_MS)
	const { outFrame, steps } = normalizeSchedule(schedule)
	const frameTs = (frame) => Math.min(sampleTimestamp(frame * fmt.fieldsPerFrame, fmt.sampleRate), lastTs)
	const outAt = outFrame === undefined ? Math.max(0, lastTs - outDuration) : frameTs(outFrame)

	if (!selfTimed) {
		// Multi-step graphics ("continue"): one more playAction per step. Without markers the steps
		// are spaced evenly between the start and the out marker.
		const stepCount = Number.isInteger(manifest?.stepCount) ? manifest.stepCount : 1
		let stepPlan = []
		if (stepCount > 1) {
			const n = stepCount - 1
			stepPlan = Array.from({ length: n }, (_, k) => {
				const custom = steps?.[k]
				return custom !== undefined && custom !== null
					? { step: k + 2, at: frameTs(custom), frame: custom, auto: false }
					: { step: k + 2, at: Math.round(((k + 1) * outAt) / stepCount), auto: true }
			})
		}
		return {
			format: fmt,
			durationFrames,
			sampleCount,
			timestamps: timelineTs,
			schedule: [
				{ timestamp: 0, action: { type: 'playAction', params: {} } },
				...stepPlan.map((s) => ({ timestamp: s.at, action: { type: 'playAction', params: { delta: 1 } } })),
				{ timestamp: outAt, action: { type: 'stopAction', params: {} } },
			].sort((a, b) => a.timestamp - b.timestamp),
			outAt,
			outDuration,
			steps: stepPlan,
			mode: 'scheduled',
			// Realtime-only graphic: the runtime runs it on a virtual clock and fires the schedule itself.
			emulate: renderMode(manifest) === 'emulated',
		}
	}

	// Self-timed: graphic time g(t). Hold the last in-frame until the out marker, then play the out segment.
	const { holdAt, outStart } = timing
	const timestamps = timelineTs.map((t) => (t < outAt ? Math.min(t, holdAt) : outStart + (t - outAt)))
	return {
		format: fmt,
		durationFrames,
		sampleCount,
		timestamps,
		// Only "start" the graphic. skipAnimation: its actions would otherwise play in real time
		// and block each seek; its picture comes from the timestamp anyway.
		schedule: [{ timestamp: 0, action: { type: 'playAction', params: { skipAnimation: true } } }],
		outAt,
		outDuration,
		mode: 'self-timed',
		emulate: false,
	}
}
