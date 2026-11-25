<!--
SPDX-FileCopyrightText: 2026 Yle
SPDX-License-Identifier: CC-BY-4.0
-->

# "Import OGraf": using the editor from your application

Your application gets an **Import OGraf** command without building any graphics UI of its own. The renderer's web editor is used for picking the graphic, filling it in, timing and preview. The render runs in the background, and your application hears when it is done.

```
 Your app (browser)          Your app (server)              OGraf renderer
 ──────────────────          ─────────────────              ──────────────
 "Import OGraf" ───────────▶ POST /api/editor-sessions ───▶ session + editor URL
 open editor URL ◀────────── editorUrl
 user picks, fills in,
 previews, Save & Render ──────────────────────────────────▶ render queued
 postMessage "submitted" ◀── (editor)                        renders in the background
                              webhook render.done ◀───────── signed POST
                              GET …/graphic.mov or frames ─▶ files
 graphic appears in app ◀─── import
```

## 1. Configure the renderer

| Variable | Example | |
|---|---|---|
| `OGRAF_API_TOKEN` | a long random string | your server's credential; never give it to browsers |
| `OGRAF_PUBLIC_URL` | `https://ograf.example.com` | how browsers reach the renderer (used in `editorUrl`) |
| `OGRAF_EDITOR_ORIGINS` | `https://openlive.example.com` | origins of the applications that may embed the editor, receive its messages and be sent back to (`returnUrl`) |
| `OGRAF_WEBHOOK_ALLOW` | `https://openlive.example.com, http://openlive-api:3000` | where webhooks may go: origins, or `*.example.com` (https only) |
| `OGRAF_WEBHOOK_SECRET` | a long random string | signs every webhook |
| `OGRAF_EDITOR_SESSION_HOURS` | `4` | how long an editor link works |

## 2. Open a session (your server)

```js
const res = await fetch(`${OGRAF}/api/editor-sessions`, {
	method: 'POST',
	headers: { Authorization: `Bearer ${process.env.OGRAF_API_TOKEN}`, 'Content-Type': 'application/json' },
	body: JSON.stringify({
		title: 'Evening news – item 4',          // shown in the editor
		formats: ['1080p50', '1080i50'],          // the user picks from these; one = fixed
		format: '1080p50',
		duration: 8, lockDuration: false,         // seconds (or durationFrames)
		graphic: 'news/lower-third',              // optional: start with this graphic…
		data: { name: 'Jane Doe' },               // …and these texts
		encodes: ['prores'],                      // besides the PNG sequence
		callbackUrl: 'https://openlive.example.com/hooks/ograf',
		metadata: { projectId: 'p1', itemId: 'i4' }, // comes back in every webhook
		appOrigin: 'https://openlive.example.com',   // for postMessage (embedded or pop-up)
		returnUrl: 'https://openlive.example.com/items/i4', // optional: go back here when done
	}),
})
const { id, editorUrl } = await res.json() // 201
```

| Field | |
|---|---|
| `graphic`, `data`, `schedule` | the starting point; leave `graphic` out and the editor opens with the graphic picker |
| `format`, `formats` | the starting format and the ones offered (default: all) |
| `duration` / `durationFrames`, `lockDuration` | the length; locked = the user can't change it (a clip length from your timeline) |
| `encodes`, `tailFrames`, `allowAnyFormat` | as in `POST /api/renders` |
| `fromRender` | the id of an earlier render: re-open it for changes (graphic, texts, format, length and timing come from it) |
| `callbackUrl`, `metadata` | webhook target, and up to 8 KB of your own JSON returned with every event |
| `appOrigin`, `returnUrl` | see step 3 |
| `title` | a label in the editor's top bar |

Hand `editorUrl` to your front end. It holds a one-time key in its `#fragment`, which is never sent to a server. The key only lets the browser use this editor session: list graphics, preview, and send **one** render. It never gives access to the API token or to other renders.

## 3. Show the editor (your front end)

Pick one:

**Pop-up window**

```js
const win = window.open(editorUrl, 'ograf-editor', 'width=1400,height=900')
window.addEventListener('message', (e) => {
	if (e.origin !== OGRAF_ORIGIN || e.data?.type !== 'ograf:editor') return
	if (e.data.event === 'submitted') showPending(e.data.sessionId, e.data.renderId)
	if (e.data.event === 'cancelled') closeDialog()
})
```

**Embedded** in your page: `<iframe src="${editorUrl}" style="width:100%;height:100%;border:0"></iframe>` with the same listener. Embedding is allowed only for origins in `OGRAF_EDITOR_ORIGINS`. Close the iframe on `submitted` or `cancelled`.

**Same tab with `returnUrl`:** navigate to `editorUrl`. After *Save & Render* the editor goes to `returnUrl?ografSession=<id>&ografRender=<renderId>`, and after *Cancel* to `returnUrl?ografSession=<id>&ografCancelled=1`.

Messages (`postMessage`, sent only to `appOrigin`):

| `event` | when | extra fields |
|---|---|---|
| `ready` | the editor has loaded | |
| `submitted` | *Save & Render*: the render is queued | `renderId` |
| `cancelled` | *Cancel* | |

All of them carry `type: "ograf:editor"` and `sessionId`. Messages are for the UI only. Don't rely on them for the result: the user may close the window, and the webhook arrives either way.

## 4. Receive the webhook (your server)

`POST callbackUrl` with JSON:

```json
{
  "event": "render.done",
  "at": "2026-11-25T08:00:00.000Z",
  "sessionId": "01M88…",
  "metadata": { "projectId": "p1", "itemId": "i4" },
  "render": { "id": "01M89…", "state": "done", "info": { "frames": 400, "format": "1080p50", "data": { "name": "Jane Doe" } },
              "links": { "frames": "/api/renders/01M89…/frames.tar", "prores": "/api/renders/01M89…/files/graphic.mov", "…": "…" } }
}
```

Events: `render.done`, `render.failed` (`render.error` says why), `render.cancelled`, and `editor.cancelled` (the user closed the editor without rendering; there is no `render`). Answer with any 2xx. Anything else, or no answer within 10 s, is retried after 5 s, 30 s, 2 min and 10 min. Redirects are not followed. Retries live in the service's memory, so after a restart, ask `GET /api/editor-sessions/{id}` or `GET /api/renders/{id}` for anything still waiting.

Check the signature before trusting the body:

```js
import crypto from 'node:crypto'

function verify(secret, rawBody, header, toleranceS = 300) {
	const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? '')
	if (!m || Math.abs(Date.now() / 1000 - Number(m[1])) > toleranceS) return false
	const expected = crypto.createHmac('sha256', secret).update(`${m[1]}.${rawBody}`).digest()
	return crypto.timingSafeEqual(expected, Buffer.from(m[2], 'hex'))
}
// verify(process.env.OGRAF_WEBHOOK_SECRET, rawBody, req.headers['x-ograf-signature'])
```

Headers: `X-Ograf-Event`, `X-Ograf-Delivery` (one id per event, the same on every retry: use it to ignore duplicates), and `X-Ograf-Signature`.

Then fetch the result with the API token (`render.links`) and import it.

## 5. Change it later

Open a new session with `fromRender: "<renderId>"`. The editor opens with that render's graphic, texts, format, length and markers. The new render gets a new id; the old one stays until the retention time (`OGRAF_RETENTION_HOURS`) removes it.

## The editor

- **Graphic picker** with the library's thumbnails and a search. Graphics not made for any offered format are greyed out.
- **Form** built from the graphic's schema (text, multi-line, numbers, colours, choices, lists, groups). Changing graphic keeps the fields that have the same name.
- **Preview** with the same OGraf runtime as the renderer, so what you see is what renders. Play, scrub, step by frame (fields for interlaced formats), backgrounds, EBU R95 safe areas.
- **Timing:** the out marker (**O**) and, for multi-step graphics, continue markers (**C**), as in the NLE editor.
- **Safety:** graphics run in sandboxed frames with an opaque origin. They can't read the editor, its session key or the API. Their files are served under a separate preview token that only reads graphics. Graphics that use `localStorage` may not preview, since an opaque origin has none; their render isn't affected.
