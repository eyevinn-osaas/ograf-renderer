// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

import { PNG } from 'pngjs'

/**
 * Weave two temporal samples (PNG buffers) into one interlaced frame.
 * fieldOrder 'upper': the first temporal sample supplies the upper field
 * (rows 0, 2, 4…), the second the lower field (rows 1, 3, 5…).
 */
export function weaveFields(firstPng, secondPng, fieldOrder = 'upper') {
	const a = PNG.sync.read(firstPng)
	const b = PNG.sync.read(secondPng)
	if (a.width !== b.width || a.height !== b.height) throw new Error('Field size mismatch')
	const out = new PNG({ width: a.width, height: a.height })
	const stride = a.width * 4
	const firstParity = fieldOrder === 'upper' ? 0 : 1
	for (let y = 0; y < a.height; y++) {
		const src = (y & 1) === firstParity ? a.data : b.data
		src.copy(out.data, y * stride, y * stride, (y + 1) * stride)
	}
	// Fast settings: graphics frames are mostly transparent, so level 1 + Paeth stays small.
	return PNG.sync.write(out, { colorType: 6, deflateLevel: 1, filterType: 4 })
}
