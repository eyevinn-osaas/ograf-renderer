// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

/**
 * Two-step lower third (stepCount 2): step 1 shows the name, step 2 ("continue") adds the title
 * line, stop takes both out. Non-realtime: every goToTime(t) replays the schedule up to t, so any
 * timestamp in any order gives the same picture. Realtime: the same state machine on a clock.
 */
const IN_MS = 700
const STEP_MS = 500
const OUT_MS = 600

const clamp = (v) => Math.max(0, Math.min(1, v))
const ease = (p) => 1 - Math.pow(1 - clamp(p), 3)

class TwoStep extends HTMLElement {
	constructor() {
		super()
		this.root = this.attachShadow({ mode: 'open' })
		this.schedule = []
		this.data = {}
		this.live = [] // realtime events
	}

	async load({ data, renderType }) {
		this.data = { ...data }
		this.root.innerHTML = `<style>
			.wrap { position: absolute; left: 7%; bottom: 12%; font-family: 'Segoe UI', Arial, sans-serif; }
			.name { background: #12233f; color: #fff; font-size: 48px; font-weight: 700; padding: 12px 28px; border-left: 10px solid #18c29c; white-space: nowrap; }
			.title { margin-top: 6px; margin-left: 10px; background: #18c29c; color: #08151f; font-size: 30px; font-weight: 600; padding: 6px 22px; display: inline-block; white-space: nowrap; }
		</style><div class="wrap"><div class="name"></div><div class="title"></div></div>`
		this.el = { wrap: this.root.querySelector('.wrap'), name: this.root.querySelector('.name'), title: this.root.querySelector('.title') }
		this._text()
		this._draw(this._state(0, []))
		if (renderType === 'realtime') {
			const tick = () => {
				this._draw(this._state(performance.now(), this.live))
				this.raf = requestAnimationFrame(tick)
			}
			tick()
		}
	}
	async dispose() {
		cancelAnimationFrame(this.raf)
		this.root.innerHTML = ''
	}
	async updateAction({ data }) {
		this.data = { ...this.data, ...data }
		this._text()
	}
	async playAction(params = {}) {
		this.live.push({ timestamp: performance.now(), action: { type: 'playAction', params } })
		const step = this._state(performance.now(), this.live).step
		return { statusCode: 200, currentStep: step - 1 }
	}
	async stopAction() {
		this.live.push({ timestamp: performance.now(), action: { type: 'stopAction', params: {} } })
	}
	async customAction() {}
	async setActionsSchedule({ schedule }) {
		this.schedule = [...(schedule || [])].sort((a, b) => a.timestamp - b.timestamp)
	}
	async goToTime({ timestamp }) {
		this._draw(this._state(timestamp, this.schedule))
	}

	_text() {
		this.el.name.textContent = this.data.name ?? ''
		this.el.title.textContent = this.data.title ?? ''
	}

	/** Replay events up to t: current step (0 = off), when it started, and whether we are going out. */
	_state(t, events) {
		let step = 0
		let since = 0
		let out = null
		for (const e of events) {
			if (e.timestamp > t) break
			if (e.action?.type === 'playAction') {
				const p = e.action.params || {}
				step = Number.isInteger(p.goto) ? p.goto + 1 : Math.min(2, step + (Number.isInteger(p.delta) ? p.delta : 1))
				since = e.timestamp
				out = null
			} else if (e.action?.type === 'stopAction' && step > 0) out = e.timestamp
		}
		return { t, step, since, out }
	}

	_draw({ t, step, since, out }) {
		const { wrap, name, title } = this.el
		if (step === 0) {
			wrap.style.visibility = 'hidden'
			return
		}
		wrap.style.visibility = 'visible'
		const outP = out === null ? 0 : ease((t - out) / OUT_MS)
		// Step 1 timing: name comes in from the start of step 1.
		const nameP = step === 1 ? ease((t - since) / IN_MS) : 1
		const titleP = step >= 2 ? ease((t - since) / STEP_MS) : 0
		name.style.opacity = String(nameP * (1 - outP))
		name.style.transform = `translateX(${Math.round((1 - nameP) * -40 - outP * 40)}px)`
		title.style.opacity = String(titleP * (1 - outP))
		title.style.transform = `translateY(${Math.round((1 - titleP) * -12)}px)`
		if (outP >= 1) wrap.style.visibility = 'hidden'
	}
}

export default TwoStep
