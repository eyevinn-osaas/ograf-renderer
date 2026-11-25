// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

/**
 * Output formats.
 *
 * - layout:    CSS viewport the graphic is laid out in (graphics are authored for this).
 * - scale:     deviceScaleFactor; output pixels = layout * scale.
 * - frameRate: timeline frames per second (what the NLE sees), as a rational [num, den].
 * - fieldsPerFrame: 2 for interlaced. The renderer captures frameRate*fieldsPerFrame
 *   temporal samples per second; interlaced output is woven from consecutive pairs.
 */
export const FORMATS = {
	'1080p25': { layout: [1920, 1080], scale: 1, frameRate: [25, 1], fieldsPerFrame: 1 },
	'1080p50': { layout: [1920, 1080], scale: 1, frameRate: [50, 1], fieldsPerFrame: 1 },
	'1080i50': { layout: [1920, 1080], scale: 1, frameRate: [25, 1], fieldsPerFrame: 2, fieldOrder: 'upper' },
	'2160p25': { layout: [1920, 1080], scale: 2, frameRate: [25, 1], fieldsPerFrame: 1 },
	'2160p50': { layout: [1920, 1080], scale: 2, frameRate: [50, 1], fieldsPerFrame: 1 },
	// Social media: vertical 9:16 and square 1:1.
	'1080x1920p25': { layout: [1080, 1920], scale: 1, frameRate: [25, 1], fieldsPerFrame: 1 },
	'1080x1920p50': { layout: [1080, 1920], scale: 1, frameRate: [50, 1], fieldsPerFrame: 1 },
	'1080x1080p25': { layout: [1080, 1080], scale: 1, frameRate: [25, 1], fieldsPerFrame: 1 },
	'1080x1080p50': { layout: [1080, 1080], scale: 1, frameRate: [50, 1], fieldsPerFrame: 1 },
}

/** Shorthands for config.graphicFormats: a word for both frame rates of a social format. */
export const FORMAT_GROUPS = {
	vertical: ['1080x1920p25', '1080x1920p50'],
	square: ['1080x1080p25', '1080x1080p50'],
}

/**
 * Formats the site config allows for a graphic beyond what its manifest declares, so Yle can
 * enable a vendor graphic for e.g. square without editing the vendor's files.
 *
 * config.graphicFormats: { "<graphic ref or folder>": ["square" | "vertical" | "<format id>", ...] }
 * A key matches the graphic ref exactly (as the library lists it, e.g. "demo:graphics/Loopic/lower-third"
 * or "demo:graphics/SPX/Template_Pack_1.4.0#NAME_LEFT.ograf.json"), or a folder above it
 * ("demo:graphics/SPX" covers every graphic under it). Unknown format names are ignored.
 */
export function configuredFormats(config, ref) {
	const map = config?.graphicFormats
	if (!map || typeof map !== 'object' || !ref) return []
	const norm = (s) => String(s).replace(/\\/g, '/').replace(/\/+$/, '')
	const r = norm(ref)
	const out = new Set()
	for (const [key, list] of Object.entries(map)) {
		const k = norm(key)
		if (!(r === k || r.startsWith(`${k}/`) || r.startsWith(`${k}#`))) continue
		for (const name of Array.isArray(list) ? list : [list]) {
			for (const id of FORMAT_GROUPS[name] ?? [name]) if (FORMATS[id]) out.add(id)
		}
	}
	return [...out]
}

/** The 16:9 broadcast layout every graphic is assumed to support. */
export const BROADCAST_LAYOUT = [1920, 1080]

const isBroadcastLayout = ([w, h]) => w === BROADCAST_LAYOUT[0] && h === BROADCAST_LAYOUT[1]

/** Does a value satisfy an OGraf constraint ({ exact, min, max, ideal } or a plain number)? `ideal` is only a preference. */
function fitsConstraint(c, v) {
	if (c === undefined || c === null) return true
	if (typeof c === 'number') return c === v
	if (c.exact !== undefined && c.exact !== v) return false
	if (c.min !== undefined && v < c.min) return false
	if (c.max !== undefined && v > c.max) return false
	return true
}

/**
 * Can this graphic be rendered in this format?
 * 16:9 formats take every graphic (that's what graphics are made for). Other layouts (vertical,
 * square) need a manifest renderRequirements entry whose resolution constrains the size and fits
 * the layout. Frame-rate constraints are ignored: non-realtime rendering serves any rate.
 * extra: format ids the site config allows for this graphic (configuredFormats).
 */
export function graphicSupportsFormat(manifest, formatId, extra = []) {
	const { layout } = getFormat(formatId)
	if (isBroadcastLayout(layout) || extra.includes(formatId)) return true
	const reqs = Array.isArray(manifest?.renderRequirements) ? manifest.renderRequirements : []
	return reqs.some((r) => {
		const res = r?.resolution
		if (!res || (res.width === undefined && res.height === undefined)) return false
		return fitsConstraint(res.width, layout[0]) && fitsConstraint(res.height, layout[1])
	})
}

export function unsupportedFormatMessage(manifest, formatId) {
	const [w, h] = getFormat(formatId).layout
	return `"${manifest?.name || manifest?.id}" is not made for ${formatId} (${w}×${h}). Pick a graphic made for this format. To allow it anyway, its manifest must list the size in renderRequirements, or the renderer config must list it under "graphicFormats".`
}

/** Every format id this graphic can be rendered in (extra: from configuredFormats). */
export function supportedFormats(manifest, extra = []) {
	return Object.keys(FORMATS).filter((id) => graphicSupportsFormat(manifest, id, extra))
}

export function getFormat(id) {
	const f = FORMATS[id]
	if (!f) throw new Error(`Unknown format "${id}". Known: ${Object.keys(FORMATS).join(', ')}`)
	const [num, den] = f.frameRate
	const [lw, lh] = f.layout
	return {
		id,
		...f,
		interlaced: f.fieldsPerFrame === 2,
		width: lw * f.scale,
		height: lh * f.scale,
		/** Temporal samples per second, as rational. */
		sampleRate: [num * f.fieldsPerFrame, den],
	}
}

/** Exact timestamp in ms for temporal sample i at rational rate [num, den]. */
export function sampleTimestamp(i, [num, den]) {
	return (i * 1000 * den) / num
}
