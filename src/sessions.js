// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

// Editor sessions. An application (with the API token) opens one and gets an editor URL holding the
// session key. The browser only ever sees that key: it can list graphics, preview, and submit one
// render for this session, nothing else. Graphics in the preview get a separate preview token that
// only reads graphic files, since their (third-party) code can read its own URL.
// Sessions are kept as JSON files, so a restarted service still knows them.

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ulid, writeFileAtomic } from './core/util.js'

const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/
const token = () => crypto.randomBytes(32).toString('base64url')
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')

export class SessionStore {
	constructor({ root, ttlHours = 4, log = () => {} }) {
		this.root = path.resolve(root)
		this.ttlMs = ttlHours * 3600_000
		this.log = log
		this.byId = new Map()
		this.byKeyHash = new Map()
		this.byPreview = new Map()
	}

	async init() {
		await fs.mkdir(this.root, { recursive: true })
		for (const f of await fs.readdir(this.root)) {
			if (!f.endsWith('.json')) continue
			try {
				this._index(JSON.parse(await fs.readFile(path.join(this.root, f), 'utf8')))
			} catch {}
		}
		await this.prune()
		this.timer = setInterval(() => this.prune().catch(() => {}), 10 * 60_000)
		this.timer.unref?.()
	}

	_index(s) {
		this.byId.set(s.id, s)
		this.byKeyHash.set(s.keyHash, s)
		this.byPreview.set(s.previewToken, s)
	}

	/** settings: what the editor starts with and may change (see service.js). Returns { session, key }. */
	async create(settings) {
		const key = token()
		const now = Date.now()
		const s = {
			id: ulid(now),
			keyHash: hash(key), // the key itself is never stored
			previewToken: token(),
			state: 'open', // open | submitted | cancelled
			renderId: null,
			createdAt: new Date(now).toISOString(),
			expiresAt: new Date(now + this.ttlMs).toISOString(),
			...settings,
		}
		await this._save(s)
		this._index(s)
		return { session: s, key }
	}

	get(id) {
		return ID.test(id ?? '') ? (this.byId.get(id) ?? null) : null
	}

	live(s) {
		return !!s && Date.parse(s.expiresAt) > Date.now()
	}

	byKey(key) {
		const s = key ? this.byKeyHash.get(hash(key)) : null
		return this.live(s) ? s : null
	}

	byPreviewToken(t) {
		const s = t ? this.byPreview.get(t) : null
		return this.live(s) ? s : null
	}

	async update(s, patch) {
		Object.assign(s, patch)
		await this._save(s)
		return s
	}

	async remove(s) {
		this.byId.delete(s.id)
		this.byKeyHash.delete(s.keyHash)
		this.byPreview.delete(s.previewToken)
		await fs.rm(path.join(this.root, `${s.id}.json`), { force: true })
	}

	async prune() {
		// Kept a day after expiry so the application can still ask how it ended.
		for (const s of [...this.byId.values()]) if (Date.parse(s.expiresAt) + 24 * 3600_000 < Date.now()) await this.remove(s)
	}

	close() {
		clearInterval(this.timer)
	}

	async _save(s) {
		await writeFileAtomic(path.join(this.root, `${s.id}.json`), JSON.stringify(s, null, 2))
	}
}
