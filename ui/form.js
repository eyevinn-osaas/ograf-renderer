// SPDX-FileCopyrightText: 2026 Yle
// SPDX-License-Identifier: Apache-2.0

// Builds an editable form from an OGraf manifest JSON schema (subset of JSON Schema + GDD hints).
// Supports: string (single/multi-line, color, enum), number/integer, boolean, object, array.

const h = (tag, attrs = {}, ...children) => {
	const el = document.createElement(tag)
	for (const [k, v] of Object.entries(attrs)) {
		if (v === undefined || v === null || v === false) continue
		if (k === 'class') el.className = v
		else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
		else if (k in el && k !== 'list') el[k] = v
		else el.setAttribute(k, v === true ? '' : v)
	}
	for (const c of children.flat()) if (c != null) el.append(c)
	return el
}

const labelOf = (key, s) => s?.title || s?.label || s?.gddOptions?.label || key
const kindOf = (s) => {
	const t = Array.isArray(s?.type) ? s.type.find((x) => x !== 'null') : s?.type
	if (t) return t
	if (s?.properties) return 'object'
	if (s?.items) return 'array'
	if (s?.enum) return typeof s.enum[0]
	return 'string'
}

function defaultFor(s) {
	if (s && 'default' in s) return structuredClone(s.default)
	switch (kindOf(s)) {
		case 'object':
			return {}
		case 'array':
			return []
		case 'boolean':
			return false
		case 'number':
		case 'integer':
			return s?.minimum ?? 0
		default:
			return ''
	}
}

/**
 * @returns {{ el: HTMLElement, getValue: () => any }}
 * onChange is called (debounced by the caller) on every edit.
 */
export function buildForm(schema, value, onChange) {
	const root = editorFor('', schema || { type: 'object', properties: {} }, value ?? {}, onChange, 0)
	return { el: root.el, getValue: root.get }
}

function editorFor(key, s, value, onChange, depth) {
	const kind = kindOf(s)
	if (kind === 'object') return objectEditor(key, s, value, onChange, depth)
	if (kind === 'array') return arrayEditor(key, s, value, onChange, depth)
	return fieldEditor(key, s, value, onChange)
}

function objectEditor(key, s, value, onChange, depth) {
	const v = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
	const props = Object.entries(s.properties || {}).sort(
		([, a], [, b]) => (a?.order ?? a?.gddOptions?.order ?? 1e9) - (b?.order ?? b?.gddOptions?.order ?? 1e9)
	)
	const children = props.map(([k, ps]) => [k, editorFor(k, ps, k in v ? v[k] : defaultFor(ps), onChange, depth + 1)])
	const body = h('div', { class: 'form-group' }, children.map(([, c]) => c.el))
	const el =
		depth === 0
			? body
			: h('fieldset', { class: 'form-object' }, h('legend', {}, labelOf(key, s)), s.description && h('p', { class: 'help' }, s.description), body)
	if (depth === 0 && !props.length) body.append(h('p', { class: 'help' }, 'This graphic has no editable fields.'))
	return {
		el,
		get: () => {
			// Keep unknown keys from the original value (e.g. vendor data), overwrite edited ones.
			const out = { ...v }
			for (const [k, c] of children) out[k] = c.get()
			return out
		},
	}
}

function arrayEditor(key, s, value, onChange, depth) {
	const itemSchema = s.items || { type: 'string' }
	const list = h('div', { class: 'form-array-items' })
	let items = []
	const render = () => {
		list.replaceChildren(
			...items.map((it, i) =>
				h(
					'div',
					{ class: 'form-array-item' },
					h('div', { class: 'form-array-body' }, it.el),
					h(
						'div',
						{ class: 'form-array-tools' },
						h('button', { type: 'button', class: 'icon', title: 'Move up', disabled: i === 0, onclick: () => move(i, -1) }, '↑'),
						h('button', { type: 'button', class: 'icon', title: 'Move down', disabled: i === items.length - 1, onclick: () => move(i, 1) }, '↓'),
						h('button', { type: 'button', class: 'icon danger', title: 'Remove', onclick: () => remove(i) }, '×')
					)
				)
			)
		)
	}
	const make = (val) => editorFor('', { ...itemSchema, title: itemSchema.title || '' }, val, onChange, depth + 1)
	const move = (i, d) => {
		const vals = items.map((x) => x.get())
		;[vals[i], vals[i + d]] = [vals[i + d], vals[i]]
		items = vals.map(make)
		render()
		onChange()
	}
	const remove = (i) => {
		items.splice(i, 1)
		render()
		onChange()
	}
	items = (Array.isArray(value) ? value : []).map(make)
	render()
	const add = h('button', { type: 'button', class: 'secondary small', onclick: () => (items.push(make(defaultFor(itemSchema))), render(), onChange()) }, '+ Add')
	const el = h('fieldset', { class: 'form-array' }, h('legend', {}, labelOf(key, s)), s.description && h('p', { class: 'help' }, s.description), list, add)
	return { el, get: () => items.map((x) => x.get()) }
}

function fieldEditor(key, s, value, onChange) {
	const kind = kindOf(s)
	const gdd = s?.gddType || ''
	const id = `f-${Math.random().toString(36).slice(2)}`
	let input
	let get

	if (Array.isArray(s?.enum)) {
		input = h('select', { id, onchange: onChange }, s.enum.map((opt, i) => h('option', { value: String(i) }, s.enumNames?.[i] ?? s.gddOptions?.labels?.[opt] ?? String(opt))))
		const idx = s.enum.findIndex((x) => x === value)
		input.value = String(idx >= 0 ? idx : 0)
		get = () => s.enum[+input.value]
	} else if (kind === 'boolean') {
		input = h('input', { id, type: 'checkbox', checked: !!value, onchange: onChange })
		get = () => input.checked
	} else if (kind === 'number' || kind === 'integer') {
		input = h('input', { id, type: 'number', value: value ?? '', min: s.minimum, max: s.maximum, step: kind === 'integer' ? 1 : s.multipleOf || 'any', oninput: onChange })
		get = () => (input.value === '' ? null : kind === 'integer' ? parseInt(input.value, 10) : parseFloat(input.value))
	} else if (gdd.startsWith('color-') || s?.format === 'color') {
		input = h('input', { id, type: 'color', value: /^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff', oninput: onChange })
		get = () => input.value
	} else if (gdd === 'multi-line' || s?.format === 'multi-line' || (s?.maxLength ?? 0) > 200) {
		input = h('textarea', { id, rows: 3, value: value ?? '', maxLength: s.maxLength, oninput: onChange })
		get = () => input.value
	} else {
		input = h('input', { id, type: 'text', value: value ?? '', maxLength: s.maxLength, placeholder: s.examples?.[0] ?? '', oninput: onChange })
		get = () => input.value
	}

	const label = labelOf(key, s)
	const el =
		kind === 'boolean'
			? h('div', { class: 'form-field checkbox' }, input, h('label', { for: id }, label), s?.description && h('p', { class: 'help' }, s.description))
			: h('div', { class: 'form-field' }, label && h('label', { for: id }, label), input, s?.description && h('p', { class: 'help' }, s.description))
	return { el, get }
}
