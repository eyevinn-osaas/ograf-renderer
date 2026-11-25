// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

// Render jobs of the service: a queue run N at a time, each job in its own folder under the output
// root with job.json (request and state) and, once done, frames/, fields/, videos and render.json.
// Finished jobs survive a restart; jobs that were running when the service stopped are marked failed.
// Jobs older than the retention time are deleted.

import fs from 'node:fs/promises'
import path from 'node:path'
import { ulid, writeFileAtomic } from './core/util.js'
import { renderGraphic } from './render.js'

const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/

export class JobManager {
	constructor({ root, library, concurrency = 1, retentionHours = 24, log = () => {}, onFinished = () => {} }) {
		this.onFinished = onFinished // (job) when it ends done, failed or cancelled
		this.root = path.resolve(root)
		this.library = library
		this.concurrency = Math.max(1, concurrency)
		this.retentionMs = retentionHours * 3600_000
		this.log = log
		this.jobs = new Map() // id -> job (public state)
		this.controllers = new Map() // id -> AbortController
		this.queue = []
		this.running = 0
	}

	async init() {
		await fs.mkdir(this.root, { recursive: true })
		for (const name of await fs.readdir(this.root)) {
			if (!ID.test(name)) continue
			try {
				const job = JSON.parse(await fs.readFile(path.join(this.root, name, 'job.json'), 'utf8'))
				if (job.state === 'queued' || job.state === 'running') {
					Object.assign(job, { state: 'failed', error: 'The service stopped during this render', finishedAt: new Date().toISOString() })
					await this._save(job)
				}
				this.jobs.set(job.id, job)
			} catch {}
		}
		this.cleanupTimer = setInterval(() => this.cleanup().catch((e) => this.log(`[cleanup] ${e.message}`)), 15 * 60_000)
		this.cleanupTimer.unref?.()
		await this.cleanup()
	}

	dir(id) {
		if (!ID.test(id)) throw Object.assign(new Error('Invalid job id'), { status: 400 })
		return path.join(this.root, id)
	}

	get(id) {
		return this.jobs.get(id) ?? null
	}

	list() {
		return [...this.jobs.values()].sort((a, b) => (a.id < b.id ? 1 : -1))
	}

	/**
	 * request: { graphic, data?, format, durationFrames | duration, schedule?, tailFrames?, encodes?, allowAnyFormat? }
	 * extra: { callbackUrl?, metadata?, sessionId? } kept with the job, for the webhook.
	 */
	async submit(request, { callbackUrl = null, metadata = null, sessionId = null } = {}) {
		const id = ulid()
		const job = { id, state: 'queued', request, callbackUrl, metadata, sessionId, progress: null, error: null, info: null, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null }
		await fs.mkdir(this.dir(id), { recursive: true })
		await this._save(job)
		this.jobs.set(id, job)
		this.queue.push(id)
		this._pump()
		return job
	}

	async cancel(id) {
		const job = this.get(id)
		if (!job) return null
		if (job.state === 'queued') {
			this.queue = this.queue.filter((q) => q !== id)
			Object.assign(job, { state: 'cancelled', finishedAt: new Date().toISOString() })
			await this._save(job)
			this._finished(job)
		} else if (job.state === 'running') this.controllers.get(id)?.abort()
		return job
	}

	async remove(id) {
		const job = this.get(id)
		if (!job) return false
		await this.cancel(id)
		if (job.state === 'running') await new Promise((r) => (job._onSettled = r)) // wait for it to stop
		this.jobs.delete(id)
		await fs.rm(this.dir(id), { recursive: true, force: true })
		return true
	}

	async cleanup() {
		if (!(this.retentionMs > 0)) return
		const now = Date.now()
		for (const job of [...this.jobs.values()]) {
			if (!job.finishedAt || now - Date.parse(job.finishedAt) < this.retentionMs) continue
			this.log(`[cleanup] deleting job ${job.id}`)
			this.jobs.delete(job.id)
			await fs.rm(this.dir(job.id), { recursive: true, force: true }).catch(() => {})
		}
	}

	async close() {
		clearInterval(this.cleanupTimer)
		for (const id of this.queue.splice(0)) {
			const job = this.get(id)
			if (job) Object.assign(job, { state: 'cancelled', finishedAt: new Date().toISOString() })
			if (job) await this._save(job).catch(() => {})
		}
		for (const c of this.controllers.values()) c.abort()
	}

	_pump() {
		while (this.running < this.concurrency && this.queue.length) {
			const id = this.queue.shift()
			this.running++
			this._run(id).finally(() => {
				this.running--
				this._pump()
			})
		}
	}

	async _run(id) {
		const job = this.get(id)
		if (!job || job.state !== 'queued') return
		const ctrl = new AbortController()
		this.controllers.set(id, ctrl)
		Object.assign(job, { state: 'running', startedAt: new Date().toISOString() })
		await this._save(job)
		const r = job.request
		let lastSave = 0
		try {
			const { graphicDir, manifestFile } = await this.library.resolve(r.graphic)
			job.info = await renderGraphic({
				graphicDir,
				manifestFile,
				data: r.data,
				format: r.format,
				durationFrames: r.durationFrames,
				duration: r.duration,
				schedule: r.schedule ?? 'auto',
				tailFrames: r.tailFrames ?? 0,
				encodes: r.encodes ?? [],
				strictFormat: !r.allowAnyFormat,
				outDir: this.dir(id),
				signal: ctrl.signal,
				log: (m) => this.log(`[job ${id}] ${m}`),
				onProgress: (p) => {
					job.progress = p
					if (Date.now() - lastSave > 1000) {
						lastSave = Date.now()
						this._save(job).catch(() => {})
					}
				},
			})
			Object.assign(job, { state: 'done', finishedAt: new Date().toISOString() })
			this.log(`[job ${id}] done in ${job.info.renderMs} ms`)
		} catch (e) {
			const cancelled = ctrl.signal.aborted
			Object.assign(job, { state: cancelled ? 'cancelled' : 'failed', error: cancelled ? null : e.message, finishedAt: new Date().toISOString() })
			this.log(`[job ${id}] ${cancelled ? 'cancelled' : `failed: ${e.message}`}`)
		} finally {
			this.controllers.delete(id)
			await this._save(job).catch(() => {})
			job._onSettled?.()
			this._finished(job)
		}
	}

	_finished(job) {
		try {
			this.onFinished(job)
		} catch (e) {
			this.log(`[job ${job.id}] onFinished: ${e.message}`)
		}
	}

	async _save(job) {
		const { _onSettled, ...rest } = job
		await writeFileAtomic(path.join(this.dir(job.id), 'job.json'), JSON.stringify(rest, null, 2))
	}
}
