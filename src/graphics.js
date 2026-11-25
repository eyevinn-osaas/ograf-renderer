// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

// The graphics library of the service: a folder of OGraf graphics (mounted, or filled through uploads).
// A graphic is named by its folder relative to the library, "news/lower-third", plus "#NAME.ograf.json"
// when the folder holds several manifests (template packs).

import fs from 'node:fs/promises'
import path from 'node:path'
import { readZip } from './core/zip.js'
import { splitGraphicRef, renderMode } from './core/manifest.js'
import { supportedFormats } from './core/formats.js'

const MAX_DEPTH = 5
const inside = (file, root) => file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep)

export class GraphicsLibrary {
	constructor(root) {
		this.root = path.resolve(root)
	}

	/** Folder for a ref, refusing anything outside the library (also through links). */
	async resolve(ref) {
		const { ref: folder, manifestFile } = splitGraphicRef(String(ref ?? ''))
		if (!folder || /^[a-z]:|^[/\\]/i.test(folder) || folder.split(/[/\\]/).includes('..')) throw new HttpError(400, `Invalid graphic reference "${ref}"`)
		if (manifestFile && (manifestFile.includes('/') || manifestFile.includes('\\'))) throw new HttpError(400, `Invalid manifest name "${manifestFile}"`)
		const dir = path.resolve(this.root, folder)
		const [real, realRoot] = await Promise.all([fs.realpath(dir).catch(() => null), fs.realpath(this.root).catch(() => this.root)])
		if (!real || !inside(real, realRoot) || real === realRoot) throw new HttpError(404, `No graphic "${ref}"`)
		return { graphicDir: real, manifestFile }
	}

	/** Every graphic in the library: one entry per manifest. */
	async list() {
		const out = []
		const walk = async (rel, depth) => {
			const dir = path.join(this.root, rel)
			let entries
			try {
				entries = await fs.readdir(dir, { withFileTypes: true })
			} catch {
				return
			}
			const manifests = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.ograf.json')).map((e) => e.name).sort()
			for (const file of manifests) {
				try {
					const manifest = JSON.parse((await fs.readFile(path.join(dir, file), 'utf8')).replace(/^﻿/, ''))
					const folder = rel.split(path.sep).join('/')
					out.push({
						ref: manifests.length > 1 ? `${folder}#${file}` : folder,
						folder,
						main: manifest.main,
						thumbnail: typeof manifest.thumbnails?.[0]?.file === 'string' ? manifest.thumbnails[0].file : null,
						id: manifest.id,
						version: manifest.version,
						name: manifest.name,
						description: manifest.description,
						renderMode: renderMode(manifest),
						stepCount: manifest.stepCount ?? 1,
						formats: supportedFormats(manifest),
						schema: manifest.schema ?? null,
					})
				} catch (e) {
					out.push({ ref: `${rel.split(path.sep).join('/')}#${file}`, error: `Unreadable manifest: ${e.message}` })
				}
			}
			if (manifests.length || depth >= MAX_DEPTH) return
			for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') await walk(path.join(rel, e.name), depth + 1)
		}
		await walk('', 0)
		return out.filter((g) => g.ref)
	}

	/**
	 * Unpack a zipped graphic into <library>/<name>. The zip may hold the graphic at its top or in one
	 * folder. Replaces an existing graphic of that name only with replace=true.
	 */
	async install(name, zipBuf, { replace = false } = {}) {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name ?? '')) throw new HttpError(400, 'name: letters, digits, ".", "_" and "-" only (max 100)')
		let zip
		try {
			zip = readZip(zipBuf)
		} catch (e) {
			throw new HttpError(400, `Not a usable zip: ${e.message}`)
		}
		const files = zip.names.filter((n) => !n.endsWith('/') && !n.startsWith('__MACOSX/'))
		for (const n of files) if (n.startsWith('/') || /^[a-z]:/i.test(n) || n.split('/').includes('..')) throw new HttpError(400, `Unsafe path in zip: ${n}`)
		// Strip one common top folder ("my-graphic/graphic.mjs" -> "graphic.mjs").
		const tops = new Set(files.map((n) => n.split('/')[0]))
		const strip = tops.size === 1 && files.every((n) => n.includes('/')) ? `${[...tops][0]}/` : ''
		const rel = files.map((n) => n.slice(strip.length))
		if (!rel.some((n) => !n.includes('/') && n.toLowerCase().endsWith('.ograf.json'))) throw new HttpError(400, 'No *.ograf.json manifest at the top of the zip')

		await fs.mkdir(this.root, { recursive: true })
		const dest = path.join(this.root, name)
		const exists = await fs.stat(dest).then(() => true, () => false)
		if (exists && !replace) throw new HttpError(409, `A graphic "${name}" exists already (replace=true to overwrite)`)
		const tmp = path.join(this.root, `.${name}.${process.pid}.${Date.now()}.tmp`)
		try {
			for (let i = 0; i < files.length; i++) {
				const out = path.join(tmp, ...rel[i].split('/'))
				if (!inside(out, tmp)) throw new HttpError(400, `Unsafe path in zip: ${files[i]}`)
				await fs.mkdir(path.dirname(out), { recursive: true })
				await fs.writeFile(out, zip.read(files[i]))
			}
			if (exists) await fs.rm(dest, { recursive: true, force: true })
			await fs.rename(tmp, dest)
		} catch (e) {
			await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
			if (e instanceof HttpError) throw e
			throw new HttpError(400, e.message)
		}
		return (await this.list()).filter((g) => g.ref === name || g.ref.startsWith(`${name}#`))
	}

	async remove(name) {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name ?? '')) throw new HttpError(400, 'Invalid name')
		const dest = path.join(this.root, name)
		if (!(await fs.stat(dest).catch(() => null))?.isDirectory()) throw new HttpError(404, `No graphic "${name}"`)
		await fs.rm(dest, { recursive: true, force: true })
	}
}

export class HttpError extends Error {
	constructor(status, message) {
		super(message)
		this.status = status
	}
}
