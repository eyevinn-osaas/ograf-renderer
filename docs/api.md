<!--
SPDX-FileCopyrightText: 2026 Yle
SPDX-License-Identifier: CC-BY-4.0
-->

# HTTP API

All `/api` calls need `Authorization: Bearer <OGRAF_API_TOKEN>` when a token is set. The editor's own `/editor-api` and `/preview` routes are for the editor page only and are not a public interface. Request and response bodies are JSON unless noted otherwise. Errors come back as `{ "error": "…" }` with a 4xx or 5xx status.

## Service

### `GET /health`

No token needed. `{ "ok": true, "version": "0.1.0", "running": 0, "queued": 0 }`

### `GET /api/formats`

The output formats: `id`, `width`, `height`, `frameRate` (`[num, den]`), `interlaced`, `fieldOrder`, `layout` (the CSS size the graphic is laid out in) and `scale`.

### `GET /api/encodes`

`["prores", "webm"]`

## Graphics

A graphic is named by its folder in the library: `lower-third`, or `news/lower-third`. A folder with several manifests (a template pack) names each one as `folder#NAME.ograf.json`.

### `GET /api/graphics`

```json
[{
  "ref": "lower-third",
  "id": "ograf-nle-lower-third",
  "version": "1.0.0",
  "name": "Lower third",
  "renderMode": "non-realtime",
  "stepCount": 1,
  "formats": ["1080p25", "1080p50", "1080i50", "2160p25", "2160p50", "1080x1920p25", "…"],
  "schema": { "type": "object", "properties": { "name": { "type": "string", "default": "Anna Virtanen" } } }
}]
```

`renderMode` is `non-realtime` (seeks itself) or `emulated` (realtime-only, run on the virtual clock). `schema` is the graphic's data schema: build a form from it.

### `PUT /api/graphics/{name}[?replace=true]`

Body: a zip (any content type) with the graphic's `*.ograf.json` at its top or in one folder. Installs it as `{name}` (`[A-Za-z0-9._-]`, at most 100 characters). Returns the installed entries, as in the list. `409` if the name exists and `replace` isn't `true`. `403` if uploads are turned off.

### `DELETE /api/graphics/{name}`

Removes an uploaded (top-level) graphic.

### `POST /api/preview`

Renders one frame and returns it as `image/png`. It is synchronous; use it for thumbnails and form previews.

```json
{ "graphic": "lower-third", "data": { "name": "Jane" }, "format": "1080p25", "at": 2000, "fullSize": false }
```

`at` is the time in ms after the graphic starts playing (default 2000). The frame is at layout size (1920×1080 for UHD) unless `fullSize` is true.

### `POST /api/plan`

What a render with these settings would do, without rendering: build your own timeline UI on it.

```json
{ "graphic": "lower-third", "format": "1080p25", "durationFrames": 250, "schedule": "auto", "data": {} }
```

Returns `format`, `durationFrames`, `sampleCount`, `timestamps` (graphic time in ms per sample), `schedule` (the actions sent to the graphic), `outAt` and `outDuration` (ms), `steps`, `stepCount`, `mode` (`scheduled`, `self-timed`, `custom`), `emulate` and `timing`.

## Editor sessions

The web editor for an application's "Import OGraf" command: see [editor.md](editor.md).

### `POST /api/editor-sessions`

Returns `201 { id, state, editorUrl, editorPath, expiresAt, … }`. The fields are in [editor.md](editor.md).

### `GET /api/editor-sessions/{id}`

`{ id, state, renderId, title, createdAt, expiresAt, metadata }`, where `state` is `open`, `submitted`, `cancelled` or `expired`.

### `DELETE /api/editor-sessions/{id}`

Ends the session: its editor link stops working.

## Renders

### `POST /api/renders`

```json
{
  "graphic": "lower-third",
  "format": "1080i50",
  "duration": 6,
  "data": { "name": "Jane Doe", "title": "Reporter" },
  "schedule": "auto",
  "tailFrames": 0,
  "encodes": ["prores", "webm"],
  "allowAnyFormat": false
}
```

| Field | |
|---|---|
| `graphic` | required, a `ref` from `GET /api/graphics` |
| `format` | required, a format id |
| `duration` / `durationFrames` | required, one of them: seconds, or whole frames of the format (25 per second for `1080i50`) |
| `data` | the graphic's data. Leave it out to use the schema defaults. If given, it is used as is. |
| `schedule` | `"auto"`: the out-animation ends on the last frame. `{ "outFrame": 100 }`: the out-animation starts at frame 100. `{ "steps": [50, null] }`: "continue" at frame 50 for multi-step graphics (`null` = spaced automatically). Or a list of `{ "timestamp": ms, "action": { "type": "playAction", "params": {} } }` sent to the graphic as is. |
| `tailFrames` | transparent frames added after the graphic (room to make the clip longer in an editor) |
| `encodes` | video files to make besides the PNGs |
| `allowAnyFormat` | render vertical/square even if the manifest doesn't declare the size |
| `callbackUrl` | a webhook for when the render ends (`render.done`, `render.failed`, `render.cancelled`); must be on `OGRAF_WEBHOOK_ALLOW`. Payload and signature: [editor.md](editor.md#4-receive-the-webhook-your-server) |
| `metadata` | up to 8 KB of your own JSON, returned in the webhook and the render |

Returns `202` and the render (below), with `state: "queued"`. Renders run in order, `OGRAF_CONCURRENCY` at a time.

### `GET /api/renders/{id}`

```json
{
  "id": "01M88SK0QYW83JCJZVSMDT0AZ9",
  "state": "done",
  "request": { "…": "as posted, normalised" },
  "progress": { "stage": "encode:prores", "done": 100, "total": 100 },
  "error": null,
  "info": { "…": "render.json" },
  "createdAt": "…", "startedAt": "…", "finishedAt": "…",
  "links": {
    "self": "/api/renders/01M88…",
    "frames": "/api/renders/01M88…/frames.tar",
    "firstFrame": "/api/renders/01M88…/files/frames/000000.png",
    "info": "/api/renders/01M88…/files/render.json",
    "prores": "/api/renders/01M88…/files/graphic.mov",
    "webm": "/api/renders/01M88…/files/graphic.webm"
  }
}
```

`state` is `queued`, `running`, `done`, `failed` (see `error`) or `cancelled`. `progress.stage` is `render`, then `encode:<kind>` for each encode. Poll every second or two. Renders that were running when the service stopped come back as `failed`.

### `GET /api/renders`

Every render the service still has, newest first.

### `GET /api/renders/{id}/frames.tar[?fields=true]`

An uncompressed tar of `render.json` and `frames/` (and `fields/` for interlaced formats with `fields=true`), under a folder named after the render id. It is streamed, so there is no `Content-Length`.

### `GET /api/renders/{id}/files/{path}`

One file: `render.json`, `graphic.mov`, `graphic.webm`, `frames/NNNNNN.png` or `fields/NNNNNN.png`.

### `POST /api/renders/{id}/cancel`

Cancels a queued or running render.

### `DELETE /api/renders/{id}`

Cancels the render if needed and deletes its files. Finished renders are also deleted after `OGRAF_RETENTION_HOURS`.
