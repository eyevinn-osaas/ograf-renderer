// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

/**
 * Test fixture: a realtime-only graphic (no goToTime), written the way many live templates are:
 * - playAction adds a class -> CSS transition slides the plate in (600 ms)
 * - setTimeout(400 ms) -> title line gets a CSS @keyframes fade-in (500 ms)
 * - requestAnimationFrame loop + performance.now() -> progress bar grows over 3 s
 * - stopAction -> CSS transition out (500 ms)
 * Rendered through ograf-nle's virtual clock.
 */
class RealtimeOnly extends HTMLElement {
	constructor() {
		super()
		this.root = this.attachShadow({ mode: 'open' })
	}
	async load({ data }) {
		this.root.innerHTML = `<style>
			.plate { position: absolute; left: 140px; bottom: 150px; width: 640px; padding: 18px 26px 22px; background: #6a1b9a; color: #fff;
				font: 700 46px/1.1 Arial, sans-serif; opacity: 0; transform: translateX(-60px); transition: opacity 600ms linear, transform 600ms linear; }
			.plate.in { opacity: 1; transform: translateX(0); }
			.plate.out { opacity: 0; transform: translateX(-60px); transition-duration: 500ms; }
			.title { font-size: 28px; font-weight: 400; margin-top: 6px; opacity: 0; }
			.title.show { animation: fade 500ms linear forwards; }
			@keyframes fade { from { opacity: 0; } to { opacity: 1; } }
			.bar { height: 8px; margin-top: 12px; background: #ffd54f; width: 0; }
		</style><div class="plate"><div class="name"></div><div class="title"></div><div class="bar"></div></div>`
		this.plate = this.root.querySelector('.plate')
		this.titleEl = this.root.querySelector('.title')
		this.bar = this.root.querySelector('.bar')
		this.root.querySelector('.name').textContent = data?.name ?? 'Realtime only'
		this.titleEl.textContent = data?.title ?? 'Live template'
	}
	async dispose() {
		cancelAnimationFrame(this.raf)
		clearTimeout(this.timer)
		this.root.innerHTML = ''
	}
	async updateAction() {}
	async customAction() {}
	async playAction() {
		this.plate.classList.remove('out')
		this.plate.classList.add('in')
		this.timer = setTimeout(() => this.titleEl.classList.add('show'), 400)
		const start = performance.now()
		const tick = () => {
			const p = Math.min(1, (performance.now() - start) / 3000)
			this.bar.style.width = `${Math.round(p * 588)}px`
			if (p < 1) this.raf = requestAnimationFrame(tick)
		}
		this.raf = requestAnimationFrame(tick)
		return { statusCode: 200, currentStep: 0 }
	}
	async stopAction() {
		this.plate.classList.add('out')
		// Like many live templates: resolve when the out-animation is done.
		await new Promise((r) => setTimeout(r, 500))
		return { statusCode: 200 }
	}
}

export default RealtimeOnly
