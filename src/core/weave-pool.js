// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

import { Worker } from 'node:worker_threads'
import os from 'node:os'

const WORKER_SRC = `
const { parentPort } = require('node:worker_threads')
const fs = require('node:fs')
let weaveFields
parentPort.on('message', async ({ id, a, b, out, fieldOrder, interlaceUrl }) => {
	try {
		if (!weaveFields) weaveFields = (await import(interlaceUrl)).weaveFields
		fs.writeFileSync(out, weaveFields(fs.readFileSync(a), fs.readFileSync(b), fieldOrder))
		parentPort.postMessage({ id })
	} catch (e) {
		parentPort.postMessage({ id, error: e.message })
	}
})`

/** Pool of worker threads that weave field pairs (file in -> file out). */
export class WeavePool {
	constructor(size = Math.max(1, Math.min(8, os.cpus().length - 1))) {
		this.interlaceUrl = new URL('./interlace.js', import.meta.url).href
		this.workers = Array.from({ length: size }, () => {
			const w = new Worker(WORKER_SRC, { eval: true })
			w.busy = false
			w.on('message', ({ id, error }) => {
				const job = this.pending.get(id)
				this.pending.delete(id)
				w.busy = false
				error ? job.reject(new Error(error)) : job.resolve()
				this._pump()
			})
			w.on('error', (e) => {
				for (const j of this.pending.values()) j.reject(e)
				this.pending.clear()
			})
			return w
		})
		this.queue = []
		this.pending = new Map()
		this.nextId = 0
	}

	weave(a, b, out, fieldOrder) {
		return new Promise((resolve, reject) => {
			this.queue.push({ id: this.nextId++, a, b, out, fieldOrder, resolve, reject })
			this._pump()
		})
	}

	_pump() {
		for (const w of this.workers) {
			if (w.busy || !this.queue.length) continue
			const job = this.queue.shift()
			w.busy = true
			this.pending.set(job.id, job)
			w.postMessage({ id: job.id, a: job.a, b: job.b, out: job.out, fieldOrder: job.fieldOrder, interlaceUrl: this.interlaceUrl })
		}
	}

	async close() {
		await Promise.all(this.workers.map((w) => w.terminate()))
	}
}
