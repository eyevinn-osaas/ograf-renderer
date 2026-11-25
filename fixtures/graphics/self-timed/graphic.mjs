// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

/**
 * Test fixture: a graphic with its own built-in timeline that IGNORES the OGraf schedule, like some
 * Lottie exports. goToTime(t) shows frame t of a 1.52 s animation: in 0-1.0 s, out 1.0-1.52 s.
 * Its segments are declared as Lottie markers in lib/timeline.json ("start", "stop").
 * Like those exports it also runs scheduled actions through a forward-only cursor.
 */
const FR = 25
const IN_END = 25 // frames
const OUT_END = 38

class SelfTimed extends HTMLElement {
	constructor() {
		super()
		this.root = this.attachShadow({ mode: 'open' })
		this.schedule = []
		this.cursor = 0
		this.started = false
	}
	async load({ data }) {
		this.root.innerHTML = `<style>
			.box { position: absolute; left: 160px; bottom: 140px; padding: 18px 30px; background: #0d6efd; color: #fff;
				font: 700 44px/1.1 Arial, sans-serif; transform-origin: left center; }
		</style><div class="box"></div>`
		this.box = this.root.querySelector('.box')
		this.box.textContent = data?.text ?? 'Self-timed'
		this._draw(0)
	}
	async dispose() {
		this.root.innerHTML = ''
	}
	async playAction() {
		this.started = true
	}
	async stopAction() {}
	async updateAction({ data }) {
		if (data?.text !== undefined) this.box.textContent = data.text
	}
	async customAction() {}
	async setActionsSchedule({ schedule }) {
		this.schedule = schedule || []
		this.cursor = 0
		this.started = false
	}
	async goToTime({ timestamp }) {
		while (this.cursor < this.schedule.length && this.schedule[this.cursor].timestamp <= timestamp) {
			const a = this.schedule[this.cursor].action
			await this[a.type]?.(a.params || {})
			this.cursor++
		}
		this._draw(Math.min(OUT_END - 1, Math.round((timestamp / 1000) * FR)))
	}
	_draw(frame) {
		if (!this.started || frame >= OUT_END - 1) {
			this.box.style.opacity = '0'
			return
		}
		const p = frame < IN_END ? frame / (IN_END - 1) : 1 - (frame - IN_END) / (OUT_END - 1 - IN_END)
		this.box.style.opacity = String(Math.max(0, Math.min(1, p)))
		this.box.style.transform = `scaleX(${0.6 + 0.4 * Math.max(0, Math.min(1, p))})`
	}
}

export default SelfTimed
