// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

/**
 * Reference lower third for tests and demos. No dependencies.
 *
 * Every pixel is a pure function of (data, schedule, time), which is what non-realtime
 * rendering needs: goToTime(t) can be called in any order and gives the same picture.
 * Realtime mode drives the same function from a clock.
 */

const IN_MS = 900
const OUT_MS = 700

const clamp = (v) => Math.max(0, Math.min(1, v))
const easeOut = (p) => 1 - Math.pow(1 - p, 3)
const easeIn = (p) => p * p * p
const seg = (p, a, b) => clamp((p - a) / (b - a)) // sub-range of an animation, 0..1

const STYLE = `
:host, .root { all: initial; }
.root { position: absolute; inset: 0; font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; }
.block { position: absolute; left: 7.5%; bottom: 11%; }
.bar {
	position: absolute; left: 0; top: 0; bottom: 0; width: 10px;
	background: #e8b31c;
}
.plate {
	margin-left: 18px; padding: 14px 34px 16px 24px;
	background: rgba(14, 22, 40, 0.92);
}
.name { color: #ffffff; font-size: 46px; font-weight: 700; line-height: 1.1; letter-spacing: 0.01em; white-space: nowrap; }
.title { color: #c9d3e6; font-size: 28px; font-weight: 400; line-height: 1.25; margin-top: 4px; white-space: nowrap; }
`

class LowerThird extends HTMLElement {
	constructor() {
		super()
		this.root = this.attachShadow({ mode: 'open' })
		this.data = {}
		this.schedule = []
		this.time = 0
		this.realtime = false
		this.liveEvents = [] // realtime: [{ at: performance.now(), type }]
	}

	async load({ data, renderType }) {
		this.realtime = renderType === 'realtime'
		this.root.innerHTML = `<style>${STYLE}</style>
			<div class="root"><div class="block">
				<div class="bar"></div>
				<div class="plate"><div class="name"></div><div class="title"></div></div>
			</div></div>`
		this.el = {
			block: this.root.querySelector('.block'),
			bar: this.root.querySelector('.bar'),
			plate: this.root.querySelector('.plate'),
			name: this.root.querySelector('.name'),
			title: this.root.querySelector('.title'),
		}
		this._setData(data || {})
		await document.fonts.ready
		this._draw(this._stateAt(0, []))
		if (this.realtime) this._tick()
	}

	async dispose() {
		cancelAnimationFrame(this.raf)
		this.root.innerHTML = ''
	}

	// ---- realtime actions
	async updateAction({ data }) {
		this._setData(data || {})
	}
	async playAction() {
		this.liveEvents.push({ at: performance.now(), type: 'playAction' })
		return { statusCode: 200, currentStep: 0 }
	}
	async stopAction() {
		this.liveEvents.push({ at: performance.now(), type: 'stopAction' })
	}
	async customAction() {}

	// ---- non-realtime
	async setActionsSchedule({ schedule }) {
		this.schedule = Array.isArray(schedule) ? [...schedule].sort((a, b) => a.timestamp - b.timestamp) : []
		this._draw(this._stateAt(this.time, this.schedule))
	}
	async goToTime({ timestamp }) {
		this.time = timestamp
		// Data updates scheduled before t apply.
		for (const e of this.schedule) if (e.action?.type === 'updateAction' && e.timestamp <= timestamp && e.action.params?.data) this._setData(e.action.params.data)
		this._draw(this._stateAt(timestamp, this.schedule))
	}

	_setData(d) {
		this.data = { ...this.data, ...d }
		if (!this.el) return
		this.el.name.textContent = this.data.name ?? ''
		this.el.title.textContent = this.data.title ?? ''
		this.el.title.style.display = this.data.title ? '' : 'none'
	}

	/** Phase at time t: { phase: 'off'|'in'|'out', p } from the last play/stop event at or before t. */
	_stateAt(t, events) {
		let last = null
		for (const e of events) if (e.timestamp <= t && (e.action?.type === 'playAction' || e.action?.type === 'stopAction')) last = e
		if (!last) return { phase: 'off', p: 0 }
		const dt = t - last.timestamp
		return last.action.type === 'playAction' ? { phase: 'in', p: clamp(dt / IN_MS) } : { phase: 'out', p: clamp(dt / OUT_MS) }
	}

	_draw({ phase, p }) {
		const { block, bar, plate, name, title } = this.el
		if (phase === 'off' || (phase === 'out' && p >= 1)) {
			block.style.visibility = 'hidden'
			return
		}
		block.style.visibility = 'visible'
		// In: bar grows, plate wipes open, text rises. Out: everything wipes away to the left.
		const barP = phase === 'in' ? easeOut(seg(p, 0, 0.35)) : 1
		const wipe = phase === 'in' ? easeOut(seg(p, 0.15, 0.75)) : 1 - easeIn(seg(p, 0.1, 1))
		const nameP = phase === 'in' ? easeOut(seg(p, 0.35, 0.85)) : 1 - easeIn(seg(p, 0, 0.6))
		const titleP = phase === 'in' ? easeOut(seg(p, 0.5, 1)) : 1 - easeIn(seg(p, 0, 0.5))
		const barOut = phase === 'out' ? 1 - easeIn(seg(p, 0.5, 1)) : 1

		bar.style.transform = `scaleY(${barP * barOut})`
		bar.style.transformOrigin = 'bottom'
		plate.style.clipPath = `inset(0 ${(1 - wipe) * 100}% 0 0)`
		name.style.transform = `translateY(${(1 - nameP) * 24}px)`
		name.style.opacity = String(nameP)
		title.style.transform = `translateY(${(1 - titleP) * 16}px)`
		title.style.opacity = String(titleP)
	}

	_tick() {
		const now = performance.now()
		const events = this.liveEvents.map((e) => ({ timestamp: e.at, action: { type: e.type } }))
		this._draw(this._stateAt(now, events))
		this.raf = requestAnimationFrame(() => this._tick())
	}
}

export default LowerThird
