// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs/promises'
import path from 'node:path'
import { FORMATS, getFormat } from './core/formats.js'
import { splitGraphicRef, defaultData } from './core/manifest.js'
import { renderGraphic, loadGraphic } from './render.js'
import { detectTiming } from './timing.js'
import { ENCODERS } from './encode.js'
import { closeBrowser } from './browser.js'
import { startService, configFromEnv } from './service.js'

const USAGE = `ograf-renderer <command> [options]

Commands:
  serve   Run the HTTP render service (default). Settings come from environment variables (see README).
          [--port <n>] [--graphics <dir>] [--output <dir>]
  render  --graphic <dir>[#NAME.ograf.json] --out <dir> --format <fmt> (--duration <frames> | --seconds <s>)
          [--data <json|@file>] [--out-frame <n>] [--steps <n,n…>] [--tail <frames>] [--encode prores,webm]
          Render one graphic to a folder: frames/000000.png …, render.json and the requested videos.
  probe   --graphic <dir> [--data <json|@file>]
          Report how the graphic reacts to time: "scheduled", "self-timed" or "emulated" (realtime-only).
  formats List the output formats.

Formats: ${Object.keys(FORMATS).join(' ')}
Encodes: ${Object.keys(ENCODERS).join(' ')} (needs FFmpeg)
Output is JSON lines on stdout ({"event":"progress"|"done"|"error", ...}). --verbose logs to stderr.`

export function parseArgs(argv) {
	const [cmd, ...rest] = argv
	const opts = {}
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i]
		if (!a.startsWith('--')) throw new Error(`Unexpected argument "${a}"`)
		const key = a.slice(2)
		const next = rest[i + 1]
		if (next === undefined || next.startsWith('--')) opts[key] = true
		else {
			opts[key] = next
			i++
		}
	}
	return { cmd, opts }
}

export const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

function scheduleFromOpts(opts) {
	const s = {}
	if (opts['out-frame'] !== undefined && opts['out-frame'] !== 'auto') s.outFrame = Number(opts['out-frame'])
	if (opts.steps !== undefined && opts.steps !== true) s.steps = String(opts.steps).split(',').map((v) => (v.trim() === '-' ? null : Number(v)))
	return Object.keys(s).length ? s : 'auto'
}

async function parseData(v) {
	if (v === undefined || v === true) return undefined
	const text = v.startsWith('@') ? await fs.readFile(v.slice(1), 'utf8') : v
	return JSON.parse(text.replace(/^﻿/, ''))
}

function req(opts, key) {
	if (opts[key] === undefined || opts[key] === true) throw new Error(`Missing --${key}`)
	return opts[key]
}

function progressEmitter() {
	let last = 0
	return ({ stage, done, total }) => {
		const now = Date.now()
		if (done === total || now - last > 250) {
			last = now
			emit({ event: 'progress', stage, done, total })
		}
	}
}

export async function runCli(argv) {
	const { cmd = 'serve', opts } = parseArgs(argv)
	const log = opts.verbose || process.env.OGRAF_DEBUG ? (m) => process.stderr.write(`${new Date().toISOString()} ${m}\n`) : () => {}
	switch (cmd) {
		case 'help':
		case '--help':
			process.stdout.write(USAGE + '\n')
			return 0
		case 'formats':
			for (const id of Object.keys(FORMATS)) emit(getFormat(id))
			return 0
		case 'serve': {
			const cfg = configFromEnv()
			if (opts.port) cfg.port = Number(opts.port)
			if (opts.graphics) cfg.graphicsDir = path.resolve(opts.graphics)
			if (opts.output) cfg.outputDir = path.resolve(opts.output)
			const serviceLog = (m) => process.stderr.write(`${new Date().toISOString()} ${m}\n`)
			const service = await startService(cfg, { log: serviceLog })
			serviceLog(`[service] ograf-renderer listening on ${cfg.host}:${service.port} (graphics ${cfg.graphicsDir}, renders ${cfg.outputDir}${cfg.token ? ', token required' : ', NO TOKEN: open to anyone who can reach it'})`)
			await new Promise((resolve) => {
				const stop = (sig) => {
					serviceLog(`[service] ${sig}: stopping`)
					service.close().finally(resolve)
				}
				process.once('SIGINT', stop)
				process.once('SIGTERM', stop)
			})
			return 0
		}
		case 'probe': {
			const g = splitGraphicRef(req(opts, 'graphic'))
			const graphicDir = path.resolve(g.ref)
			const { manifest } = await loadGraphic(graphicDir, g.manifestFile)
			const data = (await parseData(opts.data)) ?? defaultData(manifest)
			emit({ event: 'done', graphic: manifest.name, timing: await detectTiming({ graphicDir, manifest, data, log }) })
			return 0
		}
		case 'render': {
			const g = splitGraphicRef(req(opts, 'graphic'))
			const format = req(opts, 'format')
			const info = await renderGraphic({
				graphicDir: path.resolve(g.ref),
				manifestFile: g.manifestFile,
				data: await parseData(opts.data),
				format,
				durationFrames: opts.duration !== undefined ? Number(req(opts, 'duration')) : undefined,
				duration: opts.seconds !== undefined ? Number(req(opts, 'seconds')) : undefined,
				schedule: scheduleFromOpts(opts),
				tailFrames: opts.tail ? Number(opts.tail) : 0,
				encodes: opts.encode && opts.encode !== true ? String(opts.encode).split(',').map((s) => s.trim()).filter(Boolean) : [],
				outDir: req(opts, 'out'),
				onProgress: progressEmitter(),
				log,
			})
			emit({ event: 'done', outDir: path.resolve(opts.out), ...info })
			return 0
		}
		default:
			throw new Error(`Unknown command "${cmd}"\n\n${USAGE}`)
	}
}

export async function main(argv) {
	let code = 0
	try {
		code = await runCli(argv)
	} catch (e) {
		emit({ event: 'error', message: e.message })
		if (process.env.OGRAF_DEBUG) process.stderr.write(`${e.stack}\n`)
		code = 1
	} finally {
		await closeBrowser()
	}
	process.exit(code)
}
