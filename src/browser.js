// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

// One shared headless Chromium per process. Every render gets its own browser context (no shared
// cookies, storage or cache between renders); every parallel chunk its own page in that context.

import fs from 'node:fs'
import puppeteer from 'puppeteer-core'

let browserPromise = null

const env = (name) => process.env[name]?.trim() || ''
const on = (name) => /^(1|true|yes|on)$/i.test(env(name))

/** Chromium to use: OGRAF_CHROME, else the one the optional `puppeteer` package downloaded, else a usual install. */
async function findChrome() {
	if (env('OGRAF_CHROME')) return env('OGRAF_CHROME')
	try {
		const { default: full } = await import('puppeteer')
		const p = await full.executablePath() // a string before puppeteer 25, a promise since
		if (typeof p === 'string' && fs.existsSync(p)) return p
	} catch {}
	const candidates = {
		win32: [
			`${process.env['PROGRAMFILES']}\\Google\\Chrome\\Application\\chrome.exe`,
			`${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
			`${process.env['LOCALAPPDATA']}\\Google\\Chrome\\Application\\chrome.exe`,
			`${process.env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
		],
		darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
		linux: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'],
	}[process.platform] ?? []
	const hit = candidates.find((p) => p && fs.existsSync(p))
	if (!hit) throw new Error('No Chromium found. Set OGRAF_CHROME to a Chrome/Chromium executable, or `npm install puppeteer`.')
	return hit
}

/**
 * Chromium flags. Graphics are third-party code, so by default they get no network beyond the
 * renderer's own local file server: every other request goes to a proxy that doesn't exist. In a
 * cloud this also keeps graphics away from internal services (metadata endpoints and the like).
 * OGRAF_NETWORK=allow lets them load web fonts and other remote resources.
 */
export function chromeArgs() {
	const args = [
		'--hide-scrollbars',
		'--mute-audio',
		'--no-first-run',
		'--no-default-browser-check',
		'--disable-extensions',
		'--disable-sync',
		'--disable-background-networking',
		'--disable-component-update',
		'--disable-default-apps',
		'--disable-dev-shm-usage', // containers often have a small /dev/shm
		// Rendering never waits on a display: no vsync, no 60 Hz cap on animation frames.
		'--disable-gpu-vsync',
		'--disable-frame-rate-limit',
		'--disable-renderer-backgrounding',
		'--disable-background-timer-throttling',
		'--disable-backgrounding-occluded-windows',
		// Run CSS/Web animations on the main thread only. Compositor-thread animations keep their own
		// clock for a frame after being paused, which makes virtual-clock renders of realtime graphics racy.
		'--disable-threaded-animation',
		// Same text on every host.
		'--font-render-hinting=none',
		// WebGL graphics on machines without a GPU (software rendering).
		'--enable-unsafe-swiftshader',
		'--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
	]
	if (env('OGRAF_NETWORK').toLowerCase() !== 'allow') args.push('--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>;127.0.0.1;localhost')
	// Chromium's sandbox needs user namespaces, which Docker's default seccomp profile doesn't allow.
	// The container is the sandbox there; OGRAF_CHROME_SANDBOX=1 keeps Chromium's own as well.
	if (env('OGRAF_CHROME_SANDBOX') ? !on('OGRAF_CHROME_SANDBOX') : process.platform === 'linux' && fs.existsSync('/.dockerenv')) {
		args.push('--no-sandbox', '--disable-setuid-sandbox')
	}
	const extra = env('OGRAF_CHROME_ARGS')
	if (extra) args.push(...extra.split(/\s+/))
	return args
}

export async function getBrowser() {
	if (browserPromise) {
		const b = await browserPromise.catch(() => null)
		if (b?.connected) return b
		browserPromise = null
	}
	browserPromise = (async () => {
		const browser = await puppeteer.launch({
			executablePath: await findChrome(),
			headless: true,
			args: chromeArgs(),
			defaultViewport: null,
			protocolTimeout: 120_000,
			handleSIGINT: false,
			handleSIGTERM: false,
			handleSIGHUP: false,
		})
		browser.on('disconnected', () => {
			browserPromise = null
		})
		return browser
	})()
	return browserPromise
}

export async function closeBrowser() {
	const p = browserPromise
	browserPromise = null
	const b = await p?.catch(() => null)
	await b?.close().catch(() => {})
}

/** A fresh, isolated browser context for one render. */
export async function newContext() {
	return (await getBrowser()).createBrowserContext()
}
