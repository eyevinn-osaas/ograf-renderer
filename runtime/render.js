// SPDX-FileCopyrightText: 2026 Yle
// SPDX-FileCopyrightText: 2025 SuperFly.tv (portions adapted from OGraf DevTool)
// SPDX-License-Identifier: Apache-2.0 AND MIT

// OGraf runtime. Runs inside the render page.
// Adapted from SuperFlyTV/ograf-devtool (MIT): renderer/LayerHandler.js, renderer/ResourceProvider.js.
//
// Two modes:
// - non-realtime (graphics with supportsNonRealTime): the graphic seeks itself (setActionsSchedule + goToTime).
// - emulated (realtime-only graphics): the graphic runs on a virtual clock (virtual-time.js) that we
//   advance to each timestamp; scheduled actions are fired at their virtual time.

import { installVirtualTime } from './virtual-time.js'

let element = null
let elementName = null
let componentCounter = 0

// Keep the real animation-frame function: the virtual clock replaces window.requestAnimationFrame.
const realRaf = window.requestAnimationFrame.bind(window)
const nextPaint = () => new Promise((r) => realRaf(() => realRaf(r)))

async function loadModule(url) {
	const module = await import(url)
	if (!module.default) {
		const keys = Object.keys(module)
		throw new Error(
			`The Graphic must export its class as the default export${keys.length ? ` (found named exports: ${keys.join(', ')})` : ''}.`
		)
	}
	const name = `ograf-graphic-${componentCounter++}`
	customElements.define(name, module.default)
	return name
}

let currentSchedule = null
let lastTimestamp = -Infinity

// Emulation state
let vt = null // virtual clock
let loadArgs = null
let origin = 0 // virtual time at which the timeline's t = 0 starts (after load)
let actionIndex = 0
let frameMs = 1000 / 60

async function createElement({ data, width, height, frameRate, renderType }) {
	const stage = document.getElementById('stage')
	element = document.createElement(elementName)
	element.style.position = 'absolute'
	element.style.left = '0'
	element.style.top = '0'
	element.style.display = 'block'
	element.style.width = `${width}px`
	element.style.height = `${height}px`
	stage.appendChild(element)
	const loading = element.load({
		renderType,
		data,
		renderCharacteristics: { resolution: { width, height }, frameRate, _environment: 'ograf-renderer' },
	})
	await (vt ? vt.runWhile(loading) : loading)
	if (vt) {
		await vt.runWhile(subframesLoaded())
		// Live controllers send the data again with updateAction before playing; some templates
		// (e.g. SPX packs) only apply their text there. Harmless for the rest: nothing is on air yet.
		if (typeof element.updateAction === 'function') {
			try {
				await vt.runWhile(Promise.resolve(element.updateAction({ data, skipAnimation: true })))
			} catch (e) {
				console.warn('[emulated] initial updateAction failed', e)
			}
		}
		await vt.settle(10000)
	}
}

/**
 * Templates that wrap an HTML page in an iframe often return from load() before that page is ready.
 * Wait (real time, up to 10 s) until every nested iframe has finished loading.
 */
async function subframesLoaded(maxMs = 10000) {
	const start = vt.native.perfNow()
	const pending = () => {
		const frames = []
		for (const root of vt.roots()) frames.push(...root.querySelectorAll('iframe'))
		return frames.filter((f) => {
			try {
				const doc = f.contentDocument
				if (!doc) return false // cross-origin: can't wait for it
				const blank = f.getAttribute('src') && f.contentWindow.location.href === 'about:blank'
				return blank || doc.readyState !== 'complete'
			} catch {
				return false
			}
		})
	}
	while (pending().length && vt.native.perfNow() - start < maxMs) await new Promise((r) => vt.native.setTimeout(r, 10))
	if (window.__vtDebug) {
		for (const root of vt.roots())
			for (const f of root.querySelectorAll('iframe')) {
				try {
					console.log(`[vt] subframe ${f.contentWindow.location.href} clock=${f.contentWindow.__ografVirtualTime ? 'virtual' : 'NATIVE'} perf.now=${f.contentWindow.performance.now().toFixed(1)} rafPatched=${!String(f.contentWindow.requestAnimationFrame).includes('native code')}`)
				} catch (e) {
					console.log(`[vt] subframe not inspectable: ${e.message}`)
				}
			}
	}
	for (const root of vt.roots()) {
		for (const f of root.querySelectorAll('iframe')) {
			try {
				await f.contentDocument?.fonts?.ready
			} catch {}
		}
	}
}

/**
 * Fire scheduled actions due at or before timeline time t (emulated mode). The actions themselves are
 * not awaited (virtual time can't move while we wait), but resources they start loading are.
 */
async function fireDueActions(t) {
	let fired = false
	while (currentSchedule && actionIndex < currentSchedule.length && currentSchedule[actionIndex].timestamp <= t) {
		fired = true
		const { type, params } = currentSchedule[actionIndex].action || {}
		actionIndex++
		const fn = element?.[type]
		if (typeof fn !== 'function') continue
		try {
			Promise.resolve(fn.call(element, params || {})).catch((e) => console.error(`[emulated] ${type} failed`, e))
		} catch (e) {
			console.error(`[emulated] ${type} failed`, e)
		}
	}
	if (fired) {
		for (let i = 0; i < 4; i++) await Promise.resolve()
		await vt.settle()
	}
}

window.__ograf = {
	/**
	 * emulate: run a realtime-only graphic on the virtual clock.
	 * sampleRate: output samples per second; animation frames are run on a grid that hits every sample.
	 */
	async load({ mainUrl, data, width, height, frameRate, emulate = false, epochMs, sampleRate }) {
		const stage = document.getElementById('stage')
		stage.style.width = `${width}px`
		stage.style.height = `${height}px`

		if (emulate) {
			if (new URLSearchParams(location.search).has('vtdebug')) window.__vtDebug = true
			vt = installVirtualTime({ epochMs })
			const interval = 1000 / (sampleRate || frameRate || 50)
			frameMs = interval / Math.ceil(interval / (1000 / 60) - 1e-9)
		}
		elementName = await loadModule(mainUrl)
		loadArgs = { data, width, height, frameRate, renderType: emulate ? 'realtime' : 'non-realtime' }
		await createElement(loadArgs)
		if (vt) {
			vt.markOrigin()
			origin = vt.now
		}
		await document.fonts.ready
		await nextPaint()
		return true
	},

	async setSchedule(schedule) {
		currentSchedule = [...(schedule || [])].sort((a, b) => a.timestamp - b.timestamp)
		lastTimestamp = -Infinity
		actionIndex = 0
		if (vt) return true
		if (typeof element?.setActionsSchedule !== 'function') throw new Error('Graphic has no setActionsSchedule()')
		await element.setActionsSchedule({ schedule: currentSchedule })
		return true
	},

	async seek(timestamp) {
		if (vt) {
			// Going back in time: rebuild the graphic and replay from the start.
			if (timestamp < lastTimestamp) {
				try {
					await element?.dispose?.({})
				} catch {}
				element?.remove()
				vt.reset()
				actionIndex = 0
				await createElement(loadArgs)
				vt.markOrigin()
				origin = vt.now
			}
			lastTimestamp = timestamp
			await vt.advanceTo(origin + timestamp, { frameMs, origin, beforeFrame: (abs) => fireDueActions(abs - origin) })
			await document.fonts.ready
			await nextPaint()
			return true
		}

		if (typeof element?.goToTime !== 'function') throw new Error('Graphic has no goToTime()')
		// Some graphics run scheduled actions with a cursor that only moves forward. Seeking back
		// (scrubbing) would then show a stale state; giving them the schedule again resets it.
		// Harmless for graphics that follow the spec.
		if (timestamp < lastTimestamp && currentSchedule) await element.setActionsSchedule({ schedule: currentSchedule })
		lastTimestamp = timestamp
		await element.goToTime({ timestamp })
		await document.fonts.ready
		await nextPaint()
		return true
	},

	async dispose() {
		try {
			await element?.dispose?.({})
		} finally {
			element?.remove()
			element = null
		}
		return true
	},
}

window.__ografReady = true

// The editor's preview runs this page on another origin than the editor (graphics are untrusted code
// and must not reach the editor or its API): calls arrive as messages from the parent window only.
if (window.parent !== window) {
	const METHODS = new Set(['load', 'setSchedule', 'seek', 'dispose'])
	window.addEventListener('message', async (e) => {
		const m = e.data
		if (e.source !== window.parent || !m || m.ograf !== 'call' || !METHODS.has(m.method)) return
		try {
			const result = await window.__ograf[m.method](...(Array.isArray(m.args) ? m.args : []))
			window.parent.postMessage({ ograf: 'result', id: m.id, result }, e.origin)
		} catch (err) {
			window.parent.postMessage({ ograf: 'result', id: m.id, error: String(err?.message || err) }, e.origin)
		}
	})
	window.parent.postMessage({ ograf: 'ready' }, '*') // no data: the parent checks which frame sent it
}
