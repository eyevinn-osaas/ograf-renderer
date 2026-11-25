// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

// Video files with alpha from a rendered PNG sequence, with FFmpeg (OGRAF_FFMPEG, default "ffmpeg" on PATH).

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

const BT709 = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709']

/**
 * kind -> how to encode. Each gets the rendered info and returns { file, args }.
 * - prores: ProRes 4444 with alpha in .mov, at the timeline rate (interlaced formats stay interlaced,
 *           upper field first). For NLEs, playout servers and archives.
 * - webm:   VP9 with alpha in .webm. Interlaced formats are encoded from their fields as 50p, since
 *           browsers don't do interlaced. For web players, OBS and browser-based graphics.
 */
export const ENCODERS = {
	prores: (info) => ({
		file: 'graphic.mov',
		args: [
			...input(info, 'frames'),
			'-vf',
			`scale=out_color_matrix=bt709:out_range=tv${info.interlaced ? ',setfield=tff' : ''}`,
			'-c:v',
			'prores_ks',
			'-profile:v',
			'4444',
			'-pix_fmt',
			'yuva444p10le',
			'-alpha_bits',
			'16',
			'-vendor',
			'apl0',
			// Interlaced DCT, each frame flagged top field first. FFmpeg labels such a stream "tb" and
			// writes the QuickTime fiel atom as 0x0209, its usual marking for top-field-first content.
			...(info.interlaced ? ['-flags', '+ildct+ilme'] : []),
			...BT709,
		],
	}),
	webm: (info) => ({
		file: 'graphic.webm',
		args: [
			...input(info, info.interlaced ? 'fields' : 'frames'),
			'-vf',
			'scale=out_color_matrix=bt709:out_range=tv',
			'-c:v',
			'libvpx-vp9',
			'-pix_fmt',
			'yuva420p',
			'-b:v',
			'0',
			'-crf',
			process.env.OGRAF_WEBM_CRF || '24',
			'-row-mt',
			'1',
			'-deadline',
			'good',
			'-cpu-used',
			'4',
			'-auto-alt-ref',
			'0',
			...BT709,
		],
	}),
}

function input(info, folder) {
	const [num, den] = info.frameRate
	const rate = folder === 'fields' ? `${num * 2}/${den}` : `${num}/${den}`
	return ['-framerate', rate, '-start_number', '0', '-i', path.join(folder, '%06d.png')]
}

export async function encode({ kind, outDir, info, signal, log = () => {}, onProgress = () => {} }) {
	const enc = ENCODERS[kind]
	if (!enc) throw new Error(`Unknown encode "${kind}". Known: ${Object.keys(ENCODERS).join(', ')}`)
	const { file, args } = enc(info)
	const total = kind === 'webm' && info.interlaced ? info.frames * 2 : info.frames
	const tmp = `${file}.partial${path.extname(file)}`
	const ffmpeg = process.env.OGRAF_FFMPEG || 'ffmpeg'
	const full = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args, '-progress', 'pipe:1', tmp]
	log(`[encode] ${ffmpeg} ${full.join(' ')}`)
	const t0 = Date.now()
	await new Promise((resolve, reject) => {
		const child = spawn(ffmpeg, full, { cwd: outDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
		let err = ''
		const kill = () => child.kill('SIGKILL')
		signal?.addEventListener('abort', kill)
		child.stdout.on('data', (d) => {
			const m = /frame=(\d+)\s*$/m.exec(String(d))
			if (m) onProgress({ done: Number(m[1]), total })
		})
		child.stderr.on('data', (d) => (err = (err + d).slice(-4000)))
		child.on('error', (e) => reject(e.code === 'ENOENT' ? new Error(`FFmpeg not found ("${ffmpeg}"). Install it or set OGRAF_FFMPEG.`) : e))
		child.on('close', (code) => {
			signal?.removeEventListener('abort', kill)
			if (signal?.aborted) reject(new Error('Render cancelled'))
			else if (code === 0) resolve()
			else reject(new Error(`FFmpeg (${kind}) failed with code ${code}: ${err.trim()}`))
		})
	})
	await fs.rename(path.join(outDir, tmp), path.join(outDir, file))
	const { size } = await fs.stat(path.join(outDir, file))
	return { file, bytes: size, encodeMs: Date.now() - t0 }
}
