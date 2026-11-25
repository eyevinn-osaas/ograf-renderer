// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

/**
 * Virtual clock for realtime-only OGraf graphics.
 *
 * Such graphics animate with the browser's clock (requestAnimationFrame, timers, Date,
 * performance.now, CSS animations). To render them frame-accurately we replace that clock in the
 * page: time only moves when we advance it, so each output frame shows exactly the state at its
 * timestamp, faster or slower than real time.
 *
 * - Date / Date.now / performance.now   -> virtual time
 * - requestAnimationFrame               -> runs on a fixed grid of virtual frame times
 * - setTimeout / setInterval            -> fire at their virtual due time
 * - Math.random                          -> seeded (same pictures on every render)
 * - CSS animations/transitions, Web Animations -> paused and set to the virtual time
 *
 * Same-origin child frames (templates that wrap an HTML page in an iframe) join the same clock:
 * the host injects CHILD_FRAME_BOOTSTRAP at the start of every new document, which calls
 * window.parent.__ografVirtualTime.attachChild(window) before the child's own scripts run.
 *
 * install() must run before the graphic's module is imported.
 */

/** Runs at document start in every frame (via the DevTools protocol). */
export const CHILD_FRAME_BOOTSTRAP = `(() => { try { const p = window.parent; if (p && p !== window && p.__ografVirtualTime) p.__ografVirtualTime.attachChild(window) } catch (e) {} })()`
// (attachChild also runs for a frame's later documents: see patchWindow.)

export function installVirtualTime({ epochMs = Date.UTC(2026, 0, 1, 12, 0, 0), seed = 0x4f475246 } = {}) {
	const native = {
		perfNow: performance.now.bind(performance),
		raf: window.requestAnimationFrame.bind(window),
		setTimeout: window.setTimeout.bind(window),
	}

	let now = 0 // virtual ms since the clock started
	let nextId = 1
	const timers = new Map() // id -> { due, fn, args, interval }
	const frames = new Map() // id -> callback
	const tracked = new WeakMap() // Animation -> virtual start
	const trackedList = new Set()
	const docs = new Set() // documents whose animations we drive
	const shadowRoots = new Set()

	let s = seed >>> 0
	const random = () => {
		s = (s + 0x6d2b79f5) >>> 0
		let t = Math.imul(s ^ (s >>> 15), 1 | s)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}

	const addTimer = (fn, delay, args, interval, win) => {
		const id = nextId++
		const d = Math.max(0, Number(delay) || 0)
		timers.set(id, { due: now + d, fn: typeof fn === 'function' ? fn : new win.Function(String(fn)), args, interval: interval ? Math.max(1, d) : 0 })
		return id
	}

	/** Replace the clock-related globals of a window (the render page or a same-origin child frame). */
	const wins = new Set() // patched windows; their current document is re-read on every step

	/** A frame's first navigation from about:blank keeps its window (and our patches) but brings a new document. */
	function refreshDocs() {
		for (const w of wins) {
			try {
				if (w.closed) {
					wins.delete(w)
					continue
				}
				if (w.document && !docs.has(w.document)) {
					docs.add(w.document)
					if (window.__vtDebug) console.log(`[vt] document registered: ${w.document.URL} at ${now.toFixed(1)}`)
				}
			} catch {
				wins.delete(w)
			}
		}
	}

	function patchWindow(win) {
		wins.add(win)
		docs.add(win.document)
		if (win.__ografVirtualTime) return
		const NativeDate = win.Date
		function VDate(...args) {
			if (!new.target) return args.length ? NativeDate(...args) : new NativeDate(epochMs + now).toString()
			return args.length ? Reflect.construct(NativeDate, args, new.target) : Reflect.construct(NativeDate, [epochMs + now], new.target)
		}
		Object.setPrototypeOf(VDate, NativeDate)
		VDate.prototype = NativeDate.prototype
		VDate.now = () => epochMs + now
		VDate.parse = NativeDate.parse
		VDate.UTC = NativeDate.UTC
		win.Date = VDate
		try {
			Object.defineProperty(win.performance, 'now', { configurable: true, value: () => now })
		} catch {}
		win.requestAnimationFrame = (cb) => {
			const id = nextId++
			frames.set(id, cb)
			return id
		}
		win.cancelAnimationFrame = (id) => frames.delete(id)
		win.setTimeout = (fn, delay, ...args) => addTimer(fn, delay, args, false, win)
		win.setInterval = (fn, delay, ...args) => addTimer(fn, delay, args, true, win)
		win.clearTimeout = win.clearInterval = (id) => timers.delete(id)
		win.Math.random = random
		// The virtual world is always on screen. Hidden render windows can report visibility changes
		// at random real-time moments, and libraries such as anime.js pause while hidden.
		try {
			Object.defineProperty(win.Document.prototype, 'hidden', { configurable: true, get: () => false })
			Object.defineProperty(win.Document.prototype, 'visibilityState', { configurable: true, get: () => 'visible' })
			const nativeAdd = win.EventTarget.prototype.addEventListener
			win.EventTarget.prototype.addEventListener = function (type, ...rest) {
				if (type === 'visibilitychange') return
				return nativeAdd.call(this, type, ...rest)
			}
		} catch {}
		// document.getAnimations() doesn't see inside shadow DOM, so record every shadow root.
		const nativeAttachShadow = win.Element.prototype.attachShadow
		win.Element.prototype.attachShadow = function (...args) {
			const root = nativeAttachShadow.apply(this, args)
			shadowRoots.add(root)
			return root
		}
		docs.add(win.document)
		win.__ografVirtualTime = { attachChild: (child) => patchWindow(child) }
		if (window.__vtDebug) console.log(`[vt] clock attached to ${win === window ? 'render page' : win.location.href} at ${now.toFixed(1)}`)
	}
	patchWindow(window)

	// ---- CSS / Web Animations: pause them and drive currentTime from the virtual clock.
	// Called after every virtual step, so an animation started by a style change at step t is
	// pinned to start at t (in real time it would start whenever the browser noticed it).
	function syncAnimations() {
		refreshDocs()
		const list = []
		for (const doc of docs) {
			if (!doc.defaultView) {
				docs.delete(doc)
				continue
			}
			try {
				list.push(...doc.getAnimations()) // also forces the style update that creates CSS transitions
			} catch {}
		}
		for (const root of shadowRoots) {
			if (!root.host?.isConnected) {
				shadowRoots.delete(root)
				continue
			}
			try {
				list.push(...root.getAnimations())
			} catch {}
		}
		const live = new Set(list)
		for (const a of list) {
			if (!tracked.has(a)) {
				if (window.__vtDebug) console.log(`[vt] new ${a.constructor.name} ${a.transitionProperty || a.animationName || ''} at ${now.toFixed(1)}`)
				tracked.set(a, now)
				trackedList.add(a)
				try {
					a.pause()
				} catch {}
			}
		}
		for (const a of trackedList) {
			if (!live.has(a)) {
				trackedList.delete(a)
				continue
			}
			try {
				a.currentTime = (now - tracked.get(a)) * (a.playbackRate || 1)
			} catch {}
		}
	}

	const microtasks = async (n = 4) => {
		for (let i = 0; i < n; i++) await Promise.resolve()
	}

	function runTimersUpTo(t) {
		for (;;) {
			let best = null
			for (const [id, tm] of timers) if (tm.due <= t && (!best || tm.due < best[1].due || (tm.due === best[1].due && id < best[0]))) best = [id, tm]
			if (!best) return
			const [id, tm] = best
			now = Math.max(now, tm.due)
			if (tm.interval) tm.due += tm.interval
			else timers.delete(id)
			try {
				tm.fn(...(tm.args || []))
			} catch (e) {
				console.error('[virtual-time] timer error', e)
			}
		}
	}

	function runFrame(t) {
		now = t
		const cbs = [...frames.values()]
		frames.clear()
		for (const cb of cbs) {
			try {
				cb(t)
			} catch (e) {
				console.error('[virtual-time] animation frame error', e)
			}
		}
	}

	return {
		native,
		get now() {
			return now
		},

		/**
		 * Advance virtual time to `target`, running timers at their due times and animation frames
		 * on a grid of `frameMs` from `origin` (so results don't depend on seek history).
		 * beforeFrame(t) runs before the frame at t (used to fire scheduled OGraf actions).
		 */
		async advanceTo(target, { frameMs, origin = 0, beforeFrame } = {}) {
			const step = frameMs > 0 ? frameMs : 1000 / 60
			let k = Math.floor((now - origin) / step + 1e-9) + 1
			while (origin + k * step <= target + 1e-6) {
				const t = origin + k * step
				runTimersUpTo(t)
				await microtasks()
				if (beforeFrame) await beforeFrame(t)
				runFrame(t)
				await microtasks()
				syncAnimations()
				k++
			}
			runTimersUpTo(target)
			if (beforeFrame) await beforeFrame(target)
			now = target
			await microtasks()
			syncAnimations()
		},

		/** While something loads, let virtual time follow real time so it can await its own timers. */
		async runWhile(promise, { frameMs = 1000 / 60, maxMs = 15000 } = {}) {
			let done = false
			promise.then(
				() => (done = true),
				() => (done = true)
			)
			const start = native.perfNow()
			while (!done && native.perfNow() - start < maxMs) {
				await new Promise((r) => native.setTimeout(r, 4))
				if (done) break
				runTimersUpTo(now + frameMs)
				runFrame(now + frameMs)
				await microtasks()
				syncAnimations()
			}
			return promise
		},

		/** Shadow roots and documents we know about (to find nested template iframes). */
		roots() {
			refreshDocs()
			return [...docs, ...shadowRoots]
		},

		/**
		 * The timeline starts now. Animations that began while the graphic was loading (in real time,
		 * so at a random virtual moment) restart from here, e.g. an endless pulse in a template's CSS.
		 */
		markOrigin() {
			syncAnimations()
			for (const a of trackedList) tracked.set(a, now)
			syncAnimations()
		},

		/**
		 * Wait in real time (virtual time stands still) until stylesheets, images and fonts that
		 * the graphic started loading have arrived, so their arrival can't land on a random frame.
		 * Returns at once when nothing is pending.
		 */
		async settle(maxMs = 3000) {
			refreshDocs()
			// Browsers only start loading a web font once text using it is laid out, and a stylesheet
			// that arrives can declare new fonts. So: force layout, wait, and repeat until nothing new starts.
			const layout = () => {
				for (const doc of docs) {
					try {
						for (const el of doc.querySelectorAll('body *')) el.getBoundingClientRect()
					} catch {}
				}
				for (const root of shadowRoots) {
					try {
						for (const el of root.querySelectorAll('*')) el.getBoundingClientRect()
					} catch {}
				}
			}
			const pending = () => {
				for (const root of [...docs, ...shadowRoots]) {
					try {
						for (const l of root.querySelectorAll('link[rel~="stylesheet"]')) {
							if (l.href && !l.disabled && !l.sheet && !l.__ografFailed) {
								l.addEventListener('error', () => (l.__ografFailed = true), { once: true })
								return true
							}
						}
						for (const img of root.querySelectorAll('img')) if (img.src && !img.complete) return true
						const doc = root.nodeType === 9 ? root : null
						if (doc?.fonts && doc.fonts.status === 'loading') return true
					} catch {}
				}
				return false
			}
			const start = native.perfNow()
			for (let round = 0; round < 5; round++) {
				layout()
				if (!pending()) break
				while (pending() && native.perfNow() - start < maxMs) await new Promise((r) => native.setTimeout(r, 5))
			}
			for (const doc of docs) {
				try {
					await Promise.race([doc.fonts?.ready, new Promise((r) => native.setTimeout(r, maxMs))])
				} catch {}
			}
		},

		/** Forget all timers and frames (before rebuilding the graphic for a backward seek). */
		reset() {
			timers.clear()
			frames.clear()
			for (const a of trackedList) {
				try {
					a.cancel()
				} catch {}
			}
			trackedList.clear()
			now = 0
			s = seed >>> 0
		},
	}
}
