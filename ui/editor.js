// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

// The web editor: pick a graphic, fill it in, set the timing, preview it, and send it for rendering.
// Opened by an application with an editor session (docs/editor.md). The session key comes in the URL
// fragment (never sent to servers or in referrers) and is the editor's only credential.

import { buildForm } from './form.js'

const $ = (id) => document.getElementById(id)

// ---------------------------------------------------------------- Session key

const KEY_STORE = 'ograf.editor.session'
const sessionKey = (() => {
	const fromHash = new URLSearchParams(location.hash.slice(1)).get('s')
	if (fromHash) {
		try {
			sessionStorage.setItem(KEY_STORE, fromHash) // survives a reload of this tab
		} catch {}
		history.replaceState(null, '', location.pathname + location.search) // out of the address bar
		return fromHash
	}
	try {
		return sessionStorage.getItem(KEY_STORE)
	} catch {
		return null
	}
})()

async function api(method, path, body) {
	const res = await fetch(`/editor-api/${path}`, {
		method,
		headers: { Authorization: `Session ${sessionKey}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
		body: body !== undefined ? JSON.stringify(body) : undefined,
	})
	const json = await res.json().catch(() => ({}))
	if (!res.ok) throw Object.assign(new Error(json.error || `${res.status} ${res.statusText}`), { status: res.status })
	return json
}

const state = {
	session: null,
	graphics: [],
	graphic: null, // entry from the graphics list
	format: null,
	durationFrames: 250,
	schedule: 'auto',
	plan: null,
	sample: 0,
	playing: false,
	form: null,
	busy: false,
}

// ---------------------------------------------------------------- Telling the application

/** postMessage to the window that opened or embeds the editor, only to the origin the session names. */
function notify(event, extra = {}) {
	const s = state.session
	const target = window.opener || (window.parent !== window ? window.parent : null)
	if (!target || !s?.appOrigin) return
	try {
		target.postMessage({ type: 'ograf:editor', event, sessionId: s.id, ...extra }, s.appOrigin)
	} catch {}
}

function goBack(params) {
	const s = state.session
	if (!s?.returnUrl) return false
	const u = new URL(s.returnUrl)
	u.searchParams.set('ografSession', s.id)
	for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v)
	try {
		sessionStorage.removeItem(KEY_STORE)
	} catch {}
	location.assign(u.href)
	return true
}

// ---------------------------------------------------------------- Preview

/**
 * Graphics are third-party code. They run in sandboxed iframes without allow-same-origin, so they
 * have an opaque origin: no access to this page, its session key or the API. We talk by messages,
 * and recognise the frames by their window, since their origin is "null".
 */
const frameCalls = new Map()
const frameReady = new Map()
let nextCallId = 1
window.addEventListener('message', (e) => {
	if (!e.data || typeof e.data !== 'object') return
	if (e.data.ograf === 'ready') {
		frameReady.get(e.source)?.()
		return
	}
	const call = e.data.ograf === 'result' && frameCalls.get(e.data.id)
	if (!call || call.source !== e.source) return
	frameCalls.delete(e.data.id)
	if (e.data.error) call.reject(new Error(e.data.error))
	else call.resolve(e.data.result)
})

function callFrame(frame, method, ...args) {
	const w = frame?.contentWindow
	if (!w) return Promise.resolve()
	const id = nextCallId++
	return new Promise((resolve, reject) => {
		frameCalls.set(id, { resolve, reject, source: w })
		w.postMessage({ ograf: 'call', id, method, args }, '*') // an opaque origin can't be named
	})
}

/** Double-buffered iframes running the same runtime as the renderer. */
class Preview {
	constructor(container) {
		this.container = container
		this.active = null
		this.gen = 0
		this.seeking = false
		this.pendingTs = null
	}

	async load({ mainUrl, data, frameRate, schedule, timestamp, emulate }) {
		const gen = ++this.gen
		const frame = document.createElement('iframe')
		frame.setAttribute('sandbox', 'allow-scripts')
		frame.referrerPolicy = 'no-referrer'
		frame.src = `${state.session.previewBase}runtime/render.html`
		this.container.append(frame)
		this._applyScale(frame)
		try {
			await new Promise((resolve, reject) => {
				const t = setTimeout(() => reject(new Error('the preview did not start')), 15000)
				frameReady.set(frame.contentWindow, () => (clearTimeout(t), resolve()))
			})
			frameReady.delete(frame.contentWindow)
			const [width, height] = layoutSize()
			await callFrame(frame, 'load', { mainUrl, data, width, height, frameRate, emulate, sampleRate: frameRate })
			await callFrame(frame, 'setSchedule', schedule)
			await callFrame(frame, 'seek', timestamp)
		} catch (e) {
			frame.remove()
			if (gen === this.gen) throw e
			return
		}
		if (gen !== this.gen) {
			frame.remove()
			return
		}
		const old = this.active
		this.active = frame
		frame.classList.add('active')
		if (old) {
			callFrame(old, 'dispose').catch(() => {})
			old.remove()
		}
	}

	/** Seek, coalescing rapid requests (scrubbing) to the latest timestamp. */
	async seek(ts) {
		if (!this.active) return
		if (this.seeking) {
			this.pendingTs = ts
			return
		}
		this.seeking = true
		try {
			let next = ts
			while (next !== null) {
				this.pendingTs = null
				if (this.active) await callFrame(this.active, 'seek', next)
				next = this.pendingTs
			}
		} catch (e) {
			showBanner(`Graphic error while seeking: ${e.message}`, true)
		} finally {
			this.seeking = false
		}
	}

	setScale(scale) {
		this.scale = scale
		for (const f of this.container.querySelectorAll('iframe')) this._applyScale(f)
	}

	_applyScale(f) {
		const [w, h] = layoutSize()
		f.style.width = `${w}px`
		f.style.height = `${h}px`
		f.style.transform = `scale(${this.scale || 0.5})`
	}
}

const preview = new Preview($('frames'))

const fmtInfo = () => state.session?.formats.find((f) => f.id === state.format)
/** CSS size the graphic is laid out in: 1920×1080, or 1080×1920 / 1080×1080 for social formats. */
const layoutSize = () => fmtInfo()?.layout ?? [1920, 1080]

function layoutViewport() {
	const [w, h] = layoutSize()
	const stage = $('stage').getBoundingClientRect()
	const scale = Math.max(0.05, Math.min(stage.width / w, stage.height / h))
	$('viewport').style.width = `${Math.floor(w * scale)}px`
	$('viewport').style.height = `${Math.floor(h * scale)}px`
	$('safe').setAttribute('viewBox', `0 0 ${w} ${h}`)
	const [sx, sy] = [w * 0.035, h * 0.035]
	const [tx, ty] = [w * 0.05, h * 0.05]
	const rects = $('safe').querySelectorAll('rect')
	rects[0].setAttribute('x', sx), rects[0].setAttribute('y', sy), rects[0].setAttribute('width', w - 2 * sx), rects[0].setAttribute('height', h - 2 * sy)
	rects[1].setAttribute('x', tx), rects[1].setAttribute('y', ty), rects[1].setAttribute('width', w - 2 * tx), rects[1].setAttribute('height', h - 2 * ty)
	preview.setScale(scale)
}
new ResizeObserver(layoutViewport).observe($('stage'))

// ---------------------------------------------------------------- Time

const sampleRate = () => state.plan?.format.sampleRate ?? [25, 1]
/** Graphic time for sample i: exactly what the renderer seeks to (self-timed graphics are remapped). */
const sampleTs = (i) => {
	if (state.plan?.timestamps) return state.plan.timestamps[Math.max(0, Math.min(i, state.plan.timestamps.length - 1))]
	const [n, d] = sampleRate()
	return (i * 1000 * d) / n
}
const fieldsPerFrame = () => (state.plan?.format.interlaced ? 2 : 1)
const timelineFps = () => {
	const [n, d] = state.plan?.format.frameRate ?? fmtInfo()?.frameRate ?? [25, 1]
	return n / d
}

function timecode(frames, fps) {
	const f = Math.round(fps)
	const pad = (n) => String(n).padStart(2, '0')
	const s = Math.floor(frames / f)
	return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(frames % f)}`
}

function updateTimeDisplay() {
	const interlaced = state.plan?.format.interlaced
	const frame = interlaced ? Math.floor(state.sample / 2) : state.sample
	const field = interlaced ? `.${(state.sample % 2) + 1}` : ''
	const total = state.plan ? state.plan.durationFrames : 0
	$('tc').textContent = `${timecode(frame, timelineFps())}${field} / ${timecode(total, timelineFps())}`
	$('scrub').value = String(state.sample)
}

async function seekSample(i) {
	if (!state.plan) return
	state.sample = Math.max(0, Math.min(state.plan.sampleCount - 1, i))
	updateTimeDisplay()
	await preview.seek(sampleTs(state.sample))
}

// ---------------------------------------------------------------- Transport

function setPlaying(on) {
	state.playing = on && !!state.plan
	$('play').textContent = state.playing ? '❚❚' : '▶'
	if (!state.playing) return
	if (state.sample >= state.plan.sampleCount - 1) state.sample = 0
	const startSample = state.sample
	const t0 = performance.now()
	const [n, d] = sampleRate()
	const tick = async () => {
		if (!state.playing) return
		const i = startSample + Math.floor(((performance.now() - t0) / 1000) * (n / d))
		if (i >= state.plan.sampleCount) {
			await seekSample(state.plan.sampleCount - 1)
			setPlaying(false)
			return
		}
		await seekSample(i)
		requestAnimationFrame(tick)
	}
	requestAnimationFrame(tick)
}

$('play').onclick = () => setPlaying(!state.playing)
$('toStart').onclick = () => (setPlaying(false), seekSample(0))
$('toEnd').onclick = () => (setPlaying(false), seekSample(Infinity))
$('stepBack').onclick = () => (setPlaying(false), seekSample(state.sample - 1))
$('stepFwd').onclick = () => (setPlaying(false), seekSample(state.sample + 1))
$('scrub').oninput = (e) => (setPlaying(false), seekSample(parseInt(e.target.value, 10)))

document.addEventListener('keydown', (e) => {
	if (!$('picker').hidden) {
		if (e.key === 'Escape' && state.graphic) closePicker()
		return
	}
	if (!$('finished').hidden || e.target?.closest?.('input, textarea, select')) return
	if (e.key === ' ') (e.preventDefault(), setPlaying(!state.playing))
	else if (e.key === 'ArrowLeft') (setPlaying(false), seekSample(state.sample - (e.shiftKey ? 10 : 1)))
	else if (e.key === 'ArrowRight') (setPlaying(false), seekSample(state.sample + (e.shiftKey ? 10 : 1)))
	else if (e.key === 'Home') (setPlaying(false), seekSample(0))
	else if (e.key === 'End') (setPlaying(false), seekSample(Infinity))
	else if ((e.key === 'o' || e.key === 'O') && !e.ctrlKey && !e.metaKey && !$('setOut').disabled) {
		setPlaying(false)
		setOutFrame(Math.floor(state.sample / fieldsPerFrame()))
	} else if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey && !$('setStep').hidden) {
		setPlaying(false)
		setNearestStep()
	}
})

const remember = (k, v) => {
	try {
		localStorage.setItem(k, v)
	} catch {}
}
const recall = (k) => {
	try {
		return localStorage.getItem(k)
	} catch {
		return null
	}
}
$('bg').onchange = (e) => {
	$('viewport').className = `viewport bg-${e.target.value}`
	remember('ograf.bg', e.target.value)
}
$('safeToggle').onchange = (e) => {
	$('safe').style.display = e.target.checked ? '' : 'none' // SVG elements ignore the .hidden property
	remember('ograf.safe', e.target.checked ? '1' : '0')
}

// ---------------------------------------------------------------- UI state

function showBanner(msg, error = false) {
	const b = $('banner')
	b.hidden = !msg
	b.textContent = msg || ''
	b.classList.toggle('error', error)
	layoutViewport()
}

function setStatus(msg, kind = '') {
	$('status').textContent = msg || ''
	$('status').className = `status ${kind}`
}

const currentData = () => (state.form ? state.form.getValue() : {})

function updateSaveButton() {
	$('save').disabled = state.busy || !state.graphic || !state.plan
}

function renderHeader() {
	const g = state.graphic
	$('graphicName').textContent = g ? g.name || g.id : 'No graphic selected'
	$('graphicMeta').textContent = g ? [g.version && `v${g.version}`, g.folder].filter(Boolean).join(' · ') : ''
	$('titlePill').textContent = state.session?.title || ''
	const f = fmtInfo()
	$('formatPill').textContent = f ? `${f.id} · ${f.width}×${f.height}` : ''
	$('durationPill').textContent = `${state.durationFrames} frames · ${(state.durationFrames / timelineFps()).toFixed(2)} s`
}

function buildContentForm(data) {
	let timer = null
	state.form = buildForm(state.graphic?.schema, data, () => {
		clearTimeout(timer)
		timer = setTimeout(reloadPreview, 350)
	})
	$('form').replaceChildren(state.form.el)
}

function renderOutputSettings() {
	const s = state.session
	$('format').replaceChildren(
		...s.formats.map((f) => {
			const o = document.createElement('option')
			o.value = f.id
			o.textContent = `${f.id} — ${f.width}×${f.height}${f.interlaced ? ' interlaced' : ''}`
			o.disabled = !!state.graphic && !s.allowAnyFormat && !(state.graphic.formats ?? []).includes(f.id)
			return o
		})
	)
	$('format').value = state.format
	$('format').disabled = s.formats.length < 2
	$('duration').value = String(state.durationFrames)
	$('duration').disabled = !!s.lockDuration
	$('duration').title = s.lockDuration ? 'The length is set by the application' : ''
	$('durationTc').textContent = timecode(state.durationFrames, timelineFps())
	layoutViewport()
}

$('format').onchange = async (e) => {
	state.format = e.target.value
	layoutViewport()
	renderHeader()
	await replan()
}
$('duration').onchange = async (e) => {
	const v = parseInt(e.target.value, 10)
	if (!(v > 0)) return (e.target.value = String(state.durationFrames))
	state.durationFrames = v
	const s = sched()
	const reset = []
	if (s.outFrame >= v) {
		delete s.outFrame
		reset.push('out marker')
	}
	if (s.steps?.some((f) => f !== null && f >= v)) {
		s.steps = s.steps.map((f) => (f !== null && f >= v ? null : f))
		reset.push('step markers')
	}
	if (reset.length) {
		setSched(s)
		setStatus(`The ${reset.join(' and ')} were after the new end, so they are back on Auto.`, 'dirty')
	}
	$('durationTc').textContent = timecode(v, timelineFps())
	renderHeader()
	await replan()
}

// ---------------------------------------------------------------- Out marker

const hasCustomSchedule = () => Array.isArray(state.schedule)
/** The timing choice as an object ({ outFrame?, steps? }); "auto" = {}. */
const sched = () => (state.schedule && typeof state.schedule === 'object' && !Array.isArray(state.schedule) ? { ...state.schedule } : {})
function setSched(s) {
	if (s.steps && s.steps.every((v) => v === null || v === undefined)) delete s.steps
	state.schedule = Object.keys(s).length ? s : 'auto'
}

function renderOutMarker() {
	const plan = state.plan
	const auto = sched().outFrame === undefined
	$('outAuto').checked = auto
	$('outAuto').disabled = $('outFrame').disabled = $('setOut').disabled = hasCustomSchedule() || !plan
	if (!plan || plan.outAt == null) {
		$('outMarker').hidden = true
		$('outTc').textContent = ''
		$('scheduleInfo').textContent = ''
		return
	}
	const outFrame = frameOf(plan.outAt)
	$('outFrame').value = String(outFrame)
	$('outFrame').readOnly = auto
	$('outTc').textContent = timecode(outFrame, timelineFps())
	const pct = plan.sampleCount > 1 ? (outFrame * fieldsPerFrame()) / (plan.sampleCount - 1) : 0
	$('outMarker').hidden = false
	$('outMarker').style.left = `calc(8px + (100% - 16px) * ${pct.toFixed(5)} - 1px)`
	$('outMarker').title = `Out-animation starts at ${timecode(outFrame, timelineFps())}${auto ? ' (auto)' : ''}`
	$('outMarker').classList.toggle('auto', auto)
	$('scheduleInfo').textContent = `Out at ${timecode(outFrame, timelineFps())} (${auto ? 'auto' : 'marker'}), out-animation ${(plan.outDuration / 1000).toFixed(2)} s`
}

async function setOutFrame(frame) {
	const s = sched()
	if (frame === 'auto') delete s.outFrame
	else s.outFrame = Math.max(0, Math.min(state.durationFrames - 1, frame))
	setSched(s)
	await replan()
}

$('outAuto').onchange = (e) => setOutFrame(e.target.checked ? 'auto' : parseInt($('outFrame').value, 10) || 0)
$('outFrame').onchange = (e) => {
	const v = parseInt(e.target.value, 10)
	if (Number.isInteger(v) && v >= 0) setOutFrame(v)
}
$('setOut').onclick = () => setOutFrame(Math.floor(state.sample / fieldsPerFrame()))

// ---------------------------------------------------------------- Step markers ("continue")

const stepCount = () => state.plan?.stepCount ?? 1
const frameOf = (ms) => {
	const [n, d] = state.plan.format.frameRate
	return Math.round((ms / 1000) * (n / d))
}

function renderStepMarkers() {
	const plan = state.plan
	const steps = plan?.steps || []
	const show = !!plan && stepCount() > 1 && !hasCustomSchedule() && plan.mode !== 'self-timed'
	$('stepsField').hidden = !show
	$('setStep').hidden = !show
	$('stepMarkers').replaceChildren()
	if (!show) return $('stepRows').replaceChildren()
	const rows = steps.map((s, k) => {
		const frame = frameOf(s.at)
		const row = document.createElement('div')
		row.className = 'row step-row'
		const label = Object.assign(document.createElement('span'), { className: 'step-label', textContent: `Step ${s.step}` })
		const num = Object.assign(document.createElement('input'), { type: 'number', min: 0, step: 1, value: String(frame), readOnly: s.auto })
		const tc = Object.assign(document.createElement('span'), { className: 'muted small', textContent: timecode(frame, timelineFps()) })
		const autoLabel = Object.assign(document.createElement('label'), { className: 'checkbox inline' })
		const auto = Object.assign(document.createElement('input'), { type: 'checkbox', checked: s.auto })
		autoLabel.append(auto, ' Auto')
		row.append(label, num, tc, autoLabel)
		num.onchange = () => {
			const v = parseInt(num.value, 10)
			if (Number.isInteger(v) && v >= 0) setStepFrame(k, v)
		}
		auto.onchange = () => setStepFrame(k, auto.checked ? null : frame)

		const m = document.createElement('div')
		m.className = 'step-marker' + (s.auto ? ' auto' : '')
		const pct = plan.sampleCount > 1 ? (frame * fieldsPerFrame()) / (plan.sampleCount - 1) : 0
		m.style.left = `calc(8px + (100% - 16px) * ${pct.toFixed(5)} - 1px)`
		m.title = `Step ${s.step} (continue) at ${timecode(frame, timelineFps())}${s.auto ? ' (auto)' : ''}`
		m.append(Object.assign(document.createElement('span'), { textContent: String(s.step) }))
		$('stepMarkers').append(m)
		return row
	})
	$('stepRows').replaceChildren(...rows)
}

async function setStepFrame(index, frame) {
	const s = sched()
	const steps = Array.from({ length: stepCount() - 1 }, (_, k) => s.steps?.[k] ?? null)
	steps[index] = frame === null ? null : Math.max(0, Math.min(state.durationFrames - 1, frame))
	s.steps = steps
	setSched(s)
	await replan()
}

/** C / "Set continue": move the step marker nearest the playhead to the playhead. */
async function setNearestStep() {
	const steps = state.plan?.steps || []
	if (!steps.length) return
	const frame = Math.floor(state.sample / fieldsPerFrame())
	let best = 0
	for (let k = 1; k < steps.length; k++) if (Math.abs(frameOf(steps[k].at) - frame) < Math.abs(frameOf(steps[best].at) - frame)) best = k
	await setStepFrame(best, frame)
}
$('setStep').onclick = () => setNearestStep()

// ---------------------------------------------------------------- Graphic, plan, preview

const graphicUrl = (g, file) => `${location.origin}${state.session.previewBase}g/${encodeURIComponent(g.folder)}/${file.split('/').map(encodeURIComponent).join('/')}`

async function selectGraphic(ref, { data, fromPicker = false } = {}) {
	const g = state.graphics.find((x) => x.ref === ref)
	if (!g) {
		showBanner(`The graphic "${ref}" is not in the library any more. Choose another one.`, true)
		return openPicker()
	}
	const prev = state.graphic ? currentData() : null
	state.graphic = g
	// Switching graphics keeps the values of fields with the same name.
	const keep = {}
	if (prev) for (const k of Object.keys(g.schema?.properties ?? {})) if (k in prev) keep[k] = prev[k]
	buildContentForm(data ?? keep)
	if (fromPicker) state.schedule = 'auto' // markers belong to the previous graphic's animation
	// A format this graphic isn't made for: move to the first one it is made for.
	if (!state.session.allowAnyFormat && !(g.formats ?? []).includes(state.format)) {
		const ok = state.session.formats.find((f) => g.formats?.includes(f.id))
		if (ok) {
			setStatus(`${g.name} isn't made for ${state.format}: switched to ${ok.id}.`, 'dirty')
			state.format = ok.id
		} else showBanner(`${g.name} isn't made for any format this editor offers.`, true)
	}
	renderOutputSettings()
	renderHeader()
	await replan({ toHold: true })
}

/** A sample where the graphic is fully on screen: 2 s in, or just before the out marker if that is earlier. */
function holdSample() {
	const p = state.plan
	const [n, d] = p.format.sampleRate
	const t = Math.max(0, Math.min(2000, (p.outAt ?? Infinity) - 300))
	return Math.min(p.sampleCount - 1, Math.round((t * n) / d / 1000))
}

function timingNote() {
	const t = state.plan?.timing
	if (t?.mode === 'self-timed') return 'Compatibility mode: this graphic plays its own in and out animation and ignores the OGraf schedule. It is held between them so it fits the length, and the out marker works as usual.'
	if (t?.mode === 'self-timed-unknown') return t.note
	if (state.plan?.emulate) return 'Emulated: this graphic only supports live (real-time) playout. It runs on a virtual clock in the render, so every frame is exact; scrubbing backwards here replays it from the start.'
	return ''
}

async function replan({ toHold = false } = {}) {
	if (!state.graphic) return updateSaveButton()
	$('loading').hidden = false
	state.plan = null
	updateSaveButton()
	try {
		state.plan = await api('POST', 'plan', { graphic: state.graphic.ref, format: state.format, durationFrames: state.durationFrames, schedule: state.schedule, data: currentData() })
	} catch (e) {
		$('loading').hidden = true
		showBanner(e.message, true)
		renderOutMarker()
		renderStepMarkers()
		return
	}
	showBanner('')
	$('scrub').max = String(state.plan.sampleCount - 1)
	renderOutMarker()
	renderStepMarkers()
	updateSaveButton()
	if (toHold) state.sample = holdSample()
	if (state.sample >= state.plan.sampleCount) state.sample = state.plan.sampleCount - 1
	await reloadPreview()
}

async function reloadPreview() {
	if (!state.graphic || !state.plan) return
	const [n, d] = state.plan.format.sampleRate
	$('loading').hidden = false
	try {
		await preview.load({
			mainUrl: graphicUrl(state.graphic, state.graphic.main),
			data: currentData(),
			frameRate: n / d,
			schedule: state.plan.schedule,
			timestamp: sampleTs(state.sample),
			emulate: !!state.plan.emulate,
		})
		showBanner(timingNote(), state.plan?.timing?.mode === 'self-timed-unknown')
	} catch (e) {
		showBanner(`The graphic failed to load: ${e.message}`, true)
	} finally {
		$('loading').hidden = true
	}
	updateTimeDisplay()
}

// ---------------------------------------------------------------- Picker

const el = (tag, cls, text) => {
	const e = document.createElement(tag)
	if (cls) e.className = cls
	if (text !== undefined) e.textContent = text
	return e
}

function openPicker() {
	$('picker').hidden = false
	$('pickerClose').hidden = !state.graphic
	renderPicker()
	$('pickerSearch').focus()
}
function closePicker() {
	$('picker').hidden = true
}
$('graphicBtn').onclick = openPicker
$('pickerClose').onclick = closePicker
$('pickerSearch').oninput = renderPicker

function renderPicker() {
	const q = $('pickerSearch').value.trim().toLowerCase()
	const items = state.graphics.filter((g) => !g.error && (!q || `${g.name} ${g.description ?? ''} ${g.id} ${g.ref}`.toLowerCase().includes(q)))
	if (!items.length) {
		$('pickerCards').replaceChildren(el('p', 'cards-empty', state.graphics.length ? 'No graphic matches the search.' : 'The library has no graphics yet.'))
		return
	}
	const cards = el('div', 'cards')
	for (const g of items) {
		const fits = state.session.allowAnyFormat || state.session.formats.some((f) => g.formats?.includes(f.id))
		const card = el('button', 'card' + (g.ref === state.graphic?.ref ? ' selected' : ''))
		card.type = 'button'
		card.disabled = !fits
		const thumb = el('div', 'thumb')
		if (g.thumbnail) {
			const img = el('img')
			img.alt = ''
			img.loading = 'lazy'
			img.src = graphicUrl(g, g.thumbnail)
			img.onerror = () => img.replaceWith(el('span', '', 'OGraf'))
			thumb.append(img)
		} else thumb.append(el('span', '', 'OGraf'))
		const body = el('div', 'card-body')
		body.append(el('div', 'card-title', g.name || g.id), el('div', 'card-folder', g.ref))
		if (g.description) body.append(el('div', 'card-desc', g.description))
		if (!fits) body.append(el('div', 'card-problem', 'Not made for the formats offered here'))
		else if (g.renderMode === 'emulated') body.append(el('div', 'card-desc', 'Live graphic (rendered on a virtual clock)'))
		card.append(thumb, body)
		card.onclick = async () => {
			closePicker()
			await selectGraphic(g.ref, { fromPicker: true })
		}
		cards.append(card)
	}
	$('pickerCards').replaceChildren(cards)
}

// ---------------------------------------------------------------- Save, cancel, done

function showFinished(title, text, { progress = false, closable = true } = {}) {
	setPlaying(false)
	$('finished').hidden = false
	$('finishedTitle').textContent = title
	$('finishedText').textContent = text
	$('progress').hidden = !progress
	// A window the application opened can close itself; an embedded editor is closed by the application.
	$('finishedClose').hidden = !(closable && window.opener)
}
$('finishedClose').onclick = () => window.close()

async function followRender() {
	for (;;) {
		let r
		try {
			r = await api('GET', 'render')
		} catch {
			return
		}
		const p = r.progress
		if (p?.total) $('progressBar').style.width = `${Math.round((100 * p.done) / p.total)}%`
		if (r.state === 'done') return showFinished('Rendered', `${r.frames} frames are ready in your application.`)
		if (r.state === 'failed') return showFinished('The render failed', r.error || '')
		if (r.state === 'cancelled') return showFinished('The render was cancelled', '')
		$('finishedText').textContent = r.state === 'queued' ? 'Waiting for the renderer… You can close this window: the render goes on without it.' : `Rendering${p?.stage?.startsWith('encode') ? ' (video file)' : ''}… You can close this window: the render goes on without it.`
		await new Promise((res) => setTimeout(res, 1000))
	}
}

$('save').onclick = async () => {
	if (!state.graphic || state.busy) return
	state.busy = true
	updateSaveButton()
	setStatus('Sending…')
	try {
		const r = await api('POST', 'submit', { graphic: state.graphic.ref, data: currentData(), format: state.format, durationFrames: state.durationFrames, schedule: state.schedule })
		state.session.state = 'submitted'
		setStatus('')
		notify('submitted', { renderId: r.renderId })
		if (goBack({ ografRender: r.renderId })) return
		showFinished('Sent for rendering', 'Waiting for the renderer…', { progress: true })
		followRender()
	} catch (e) {
		setStatus(e.message, 'error')
		state.busy = false
		updateSaveButton()
	}
}

$('cancel').onclick = async () => {
	try {
		await api('POST', 'cancel')
	} catch {}
	notify('cancelled')
	if (goBack({ ografCancelled: '1' })) return
	if (window.opener) return window.close()
	showFinished('Closed', 'Nothing was rendered.', { closable: false })
}

// ---------------------------------------------------------------- Start

async function init() {
	const bg = recall('ograf.bg')
	if (bg && [...$('bg').options].some((o) => o.value === bg)) $('bg').value = bg
	$('viewport').className = `viewport bg-${$('bg').value}`
	$('safeToggle').checked = recall('ograf.safe') === '1'
	$('safe').style.display = $('safeToggle').checked ? '' : 'none'

	if (!sessionKey) return showFinished('No editor session', 'Open the editor from your application.', { closable: false })
	try {
		state.session = await api('GET', 'session')
	} catch (e) {
		return showFinished('This editor link does not work', e.message, { closable: false })
	}
	const s = state.session
	if (s.state === 'submitted') {
		showFinished('Sent for rendering', 'Waiting for the renderer…', { progress: true })
		return followRender()
	}
	if (s.state === 'cancelled') return showFinished('Closed', 'Nothing was rendered.', { closable: false })

	state.format = s.format
	state.durationFrames = s.durationFrames
	state.schedule = s.schedule ?? 'auto'
	renderOutputSettings()
	renderHeader()
	try {
		state.graphics = await api('GET', 'graphics')
	} catch (e) {
		showBanner(`Can't list the graphics: ${e.message}`, true)
	}
	notify('ready')
	if (s.graphic) await selectGraphic(s.graphic, { data: s.data ?? undefined }) // keeps the session's schedule
	else openPicker()
}

init()
