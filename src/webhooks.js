// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

// Webhooks: the service tells an application when a render is done, failed or was cancelled, and when
// a user closed the editor without rendering. Only URLs on the allow list (OGRAF_WEBHOOK_ALLOW) are
// called, redirects are not followed (no detours to internal services), and every call is signed
// with OGRAF_WEBHOOK_SECRET when set:
//   X-Ograf-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">

import crypto from 'node:crypto'

const RETRY_DELAYS_MS = [0, 5_000, 30_000, 120_000, 600_000]

/**
 * Allow-list entries: an origin ("https://app.example.com", "http://openlive:3000"), or a host
 * pattern ("*.example.com", which also needs https). "*" allows everything (development only).
 */
export function parseAllowList(text) {
	return String(text ?? '')
		.split(/[\s,]+/)
		.map((s) => s.trim().replace(/\/+$/, ''))
		.filter(Boolean)
}

export function urlAllowed(url, allow) {
	let u
	try {
		u = new URL(url)
	} catch {
		return false
	}
	if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return false
	return allow.some((a) => {
		if (a === '*') return true
		if (a.startsWith('*.')) return u.protocol === 'https:' && (u.hostname.endsWith(a.slice(1)) || u.hostname === a.slice(2))
		try {
			return new URL(a).origin === u.origin
		} catch {
			return false
		}
	})
}

export function sign(secret, body, t = Math.floor(Date.now() / 1000)) {
	return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`
}

/** For receivers (and tests): check a signature header, allowing toleranceS of clock difference. */
export function verifySignature(secret, body, header, toleranceS = 300) {
	const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(header ?? ''))
	if (!m) return false
	if (Math.abs(Date.now() / 1000 - Number(m[1])) > toleranceS) return false
	const expected = Buffer.from(sign(secret, body, Number(m[1])).split('v1=')[1], 'hex')
	const got = Buffer.from(m[2], 'hex')
	return expected.length === got.length && crypto.timingSafeEqual(expected, got)
}

export class Webhooks {
	constructor({ allow = [], secret = '', log = () => {}, retryDelaysMs = RETRY_DELAYS_MS, timeoutMs = 10_000 } = {}) {
		this.allow = allow
		this.secret = secret
		this.log = log
		this.retryDelaysMs = retryDelaysMs
		this.timeoutMs = timeoutMs
		this.pending = new Set()
	}

	check(url) {
		if (url === undefined || url === null || url === '') return null
		if (typeof url !== 'string' || !urlAllowed(url, this.allow)) {
			const err = new Error(this.allow.length ? 'callbackUrl is not on the webhook allow list (OGRAF_WEBHOOK_ALLOW)' : 'Webhooks are turned off: set OGRAF_WEBHOOK_ALLOW')
			err.status = 400
			throw err
		}
		return url
	}

	/** Send in the background, with retries. Returns a promise for tests; callers don't wait. */
	send(url, event, payload) {
		if (!url) return Promise.resolve(false)
		const body = JSON.stringify({ event, at: new Date().toISOString(), ...payload })
		const id = crypto.randomUUID()
		const p = (async () => {
			for (let attempt = 0; attempt < this.retryDelaysMs.length; attempt++) {
				if (this.retryDelaysMs[attempt]) await new Promise((r) => setTimeout(r, this.retryDelaysMs[attempt]).unref?.())
				if (this.closed) return false
				try {
					const headers = { 'Content-Type': 'application/json', 'User-Agent': 'ograf-renderer', 'X-Ograf-Event': event, 'X-Ograf-Delivery': id }
					if (this.secret) headers['X-Ograf-Signature'] = sign(this.secret, body)
					const res = await fetch(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) })
					if (res.status >= 200 && res.status < 300) {
						this.log(`[webhook] ${event} -> ${url}: ${res.status}`)
						return true
					}
					this.log(`[webhook] ${event} -> ${url}: HTTP ${res.status} (attempt ${attempt + 1})`)
				} catch (e) {
					this.log(`[webhook] ${event} -> ${url}: ${e.message} (attempt ${attempt + 1})`)
				}
			}
			this.log(`[webhook] ${event} -> ${url}: gave up`)
			return false
		})()
		this.pending.add(p)
		p.finally(() => this.pending.delete(p))
		return p
	}

	close() {
		this.closed = true
	}
}
