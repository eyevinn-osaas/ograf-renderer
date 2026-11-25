// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Graphic references may name one manifest in a folder that holds several (template packs):
 * "alias:SPX/Pack#TITLE_2_STEPS.ograf.json". Returns { ref (folder part), manifestFile|null }.
 */
export function splitGraphicRef(ref) {
	const i = String(ref).lastIndexOf('#')
	if (i < 0) return { ref, manifestFile: null }
	return { ref: ref.slice(0, i), manifestFile: ref.slice(i + 1) || null }
}

/** All *.ograf.json manifests in a folder, sorted. */
export async function listManifests(graphicDir) {
	return (await fs.readdir(graphicDir)).filter((f) => f.toLowerCase().endsWith('.ograf.json')).sort()
}

/** Parse the manifest in a graphic folder (the named one, or the first if the folder has several). */
export async function readManifest(graphicDir, manifestFile = null) {
	const files = await listManifests(graphicDir)
	const file = manifestFile ? files.find((f) => f === manifestFile) : files[0]
	if (!file) throw new Error(manifestFile ? `Manifest ${manifestFile} not found in ${graphicDir}` : `No *.ograf.json manifest found in ${graphicDir}`)
	const manifest = JSON.parse((await fs.readFile(path.join(graphicDir, file), 'utf8')).replace(/^﻿/, ''))
	return { manifest, manifestFile: file }
}

/**
 * How a graphic is rendered:
 *   "non-realtime" - it seeks itself (supportsNonRealTime: true), frame-accurate by design.
 *   "emulated"     - realtime-only: it runs on our virtual clock (Date, timers, animation frames,
 *                    CSS animations), also frame-accurate.
 *   null           - neither declared as supported.
 */
export function renderMode(manifest) {
	if (manifest?.supportsNonRealTime === true) return 'non-realtime'
	if (manifest?.supportsRealTime !== false) return 'emulated'
	return null
}

/** Returns a list of problems that prevent rendering (empty = ok). */
export function checkRenderable(manifest) {
	const problems = []
	if (!manifest.main) problems.push('Manifest has no "main" entry.')
	if (!renderMode(manifest)) problems.push('Graphic declares neither real-time nor non-real-time support.')
	return problems
}

/** Default data object from the manifest's JSON schema. */
export function defaultData(manifest) {
	const props = manifest?.schema?.properties ?? {}
	const out = {}
	for (const [k, v] of Object.entries(props)) if (v && 'default' in v) out[k] = v.default
	return out
}
