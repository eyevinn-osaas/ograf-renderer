// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

/**
 * Every source file starts with the SPDX header.
 * Code is Apache-2.0, Markdown documentation CC-BY-4.0. Exempt: files that cannot hold a comment
 * (JSON, images), the licence texts, and third-party fixtures that keep their own licence.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const HOLDER = 'SPDX-FileCopyrightText: 2026 Yle'
const EXEMPT = /(^LICENSES\/|^LICENSE$|^NOTICE$|\.json$|\.(png|jpe?g|webp|gif|svg|pdf)$|^fixtures\/graphics\/headline\/|^fixtures\/graphics\/LICENSE-)/

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
	.split('\n')
	.filter((f) => f && !EXEMPT.test(f))

for (const file of files) {
	test(`SPDX header: ${file}`, () => {
		const head = readFileSync(file, 'utf8').split(/\r?\n/).slice(0, 8).join('\n')
		const licence = file.endsWith('.md') ? 'CC-BY-4.0' : 'Apache-2.0'
		assert.ok(head.includes(HOLDER), 'missing SPDX-FileCopyrightText')
		assert.ok(head.includes(`SPDX-License-Identifier: ${licence}`), `missing SPDX-License-Identifier: ${licence}`)
	})
}
