---
name: apidog-fields
description: Apidog OpenAPI extension keys (x-apidog-*), status enum values, request/response shapes, and security schemes ACTUALLY in use in the ably-server Apidog project. Load this BEFORE calling apidog-mcp tools that create or update endpoints — it tells you what `status` values are valid, what extension keys to expect, what content types to set, what security scheme names map to which header, and how the internal http-apis payload is shaped. Triggers on apidog-mcp tool use, OpenAPI spec edits in this project, or any question about Apidog endpoint fields.
---

# Apidog field reference — ably-server (project 856039)

Snapshot of the live spec at the time this skill was generated. 406 operations / 698 schemas, OpenAPI 3.1.0. Re-run `node scripts/extract-fields.js > /tmp/apidog-fields.json` to refresh.

---

## 1. Apidog extension keys

Extensions land at the **operation level** (`spec.paths[<path>][<method>].x-*`). The spec root carries none in this project.

| Key | Required? | Value | Notes |
|---|---|---|---|
| `x-apidog-folder` | ✅ on every operation | string, slash-separated path | "ABLY/내마관", "Community/AI챗봇", "AI스튜디오/[AI피팅룸]/[어드민]/컨셉 목록". Escape literal `/` as `\/` and literal `\` as `\\`. Apidog prefers this over `tags` for folder placement on import. |
| `x-apidog-status` | ✅ on every operation | enum (see §2) | Endpoint lifecycle state. |
| `x-run-in-apidog` | ✅ on every operation | URL string | `https://app.apidog.com/web/project/856039/apis/api-<ID>-run`. **Source of truth for the numeric endpoint id** — `ApidogClient.parseEndpointId()` extracts `<ID>` from `api-<ID>-run`. |
| `x-apidog-maintainer` | optional, rare | string (Apidog username/nickname) | Used on 2/406 ops. Set when an owner matters. |
| `x-apidog-additional-responses` | optional | object | Seen once as a key under `responses`. Apidog uses this to store extra response variants beyond the standard status codes. Pass-through only — don't hand-author. |

Per the official docs there are also lifecycle states `pending`, `integrating`, `testing`, `tested`, `deprecated`, `exception`, `obsolete`, `to be deprecated`. None of those are present in this project — see §2.

---

## 2. `x-apidog-status` values **in use**

```
released    387   (95.3%)
developing   10
designing     9
```

Use `released` by default for shipped endpoints. `developing` / `designing` are reserved for work-in-progress. If you set anything else (`pending`, `deprecated`, etc. from the official list), the Apidog UI will accept it but the project hasn't standardized on those values yet — flag in PR description.

---

## 3. HTTP methods in use

```
GET    225
POST   116
DELETE  34
PATCH   16
PUT     13
HEAD     2
```

No `OPTIONS` in use. When adding endpoints, prefer GET/POST/PATCH/DELETE; PUT only when replacing a resource wholesale. Always lowercase the method in the internal http-apis payload (`apidog-client.js` already does this in `update_endpoint`/`create_endpoint`).

---

## 4. Parameters

`in` values present:

```
query    352
path     218
header    12
```

No `cookie` parameters. Typical operation parameter shape:

```json
{
  "name": "sno",
  "in": "path",
  "required": true,
  "schema": { "type": "integer" }
}
```

Header params seen include `baggage` (Datadog distributed tracing — auto-injected, don't author), `Authorization`, `Accept`, `Content-Type`. **Skip** auto-injected headers (`baggage`, `Authorization`, `Accept`, `Content-Type`) when authoring new endpoints — Apidog adds them automatically from the security scheme + content type.

---

## 5. Request / response shape

> ⚠️ **The shapes below are what the OpenAPI export looks like.** The `update_endpoint` / `create_endpoint` `patch` field does **NOT** accept those shapes — it requires Apidog's internal flat format. Mixing them up is the #1 silent-fail trap: a PUT with OpenAPI-nested `requestBody.content.<mime>.schema` returns 200 OK and the UI shows nothing.
>
> **Patch-side cheat sheet (this is what you write in `patch`):**
>
> ```jsonc
> {
>   "requestBody": {
>     "type": "application/json",         // MIME goes here, not as a content-key
>     "required": true,
>     "additionalContentTypes": [],
>     "parameters": [],                   // populated only when type === "multipart/form-data"
>     "jsonSchema": { /* schema directly — no content wrapper */ }
>   },
>   "parameters": {                       // object, NOT array
>     "path":   [{ "id":"<unique>","name":"sno","required":true,"enable":true,"type":"integer","schema":{"type":"integer"} }],
>     "query":  [{ "id":"<unique>","name":"page","required":false,"enable":true,"example":"1","type":"integer","schema":{"type":"integer","minimum":1,"default":20} }],
>     "cookie": [],
>     "header": []
>   },
>   "responses": [                        // array, each entry carries its own code
>     { "name":"Success","code":200,"contentType":"json","jsonSchema":{ /* ... */ } }
>   ]
> }
> ```
>
> multipart form fields go inside `requestBody.parameters[]` (not the top-level `parameters` object):
>
> ```jsonc
> { "requestBody": {
>     "type": "multipart/form-data",
>     "required": true,
>     "parameters": [
>       { "id":"<unique>","name":"file","type":"file","required":true,"enable":true,
>         "schema":{ "type":"string","format":"binary" } },
>       { "id":"<unique>","name":"image_type","type":"string","required":true,"enable":true,
>         "schema":{ "type":"string","enum":["HOME_TAB_TOP_ICON"] } }
>     ]
> } }
> ```
>
> Always verify via `get_endpoint { endpointId }` (default `source: "internal"` since v0.2.x — same shape the UI reads).

### Request content types

```
application/json       108
multipart/form-data     12
form-data                1   ← likely typo for multipart/form-data
json                     4   ← likely typo for application/json
```

When creating new endpoints, **use `application/json` or `multipart/form-data`**. Don't introduce `form-data` / `json` — those are import artifacts.

### Response content types

```
application/json   328   (all responses)
```

### Response status codes in use

```
200  307     201   61     202    3     204   33
400   18     401   31     403    1     404   10
409    4     500    1
```

Convention in this project:
- `200` for read endpoints
- `201` for creates
- `204` for deletes / fire-and-forget
- `400/401/404` documented when the endpoint surfaces specific failure paths

---

## 6. Security schemes

All defined in `components.securitySchemes`. Naming is mixed — the table below maps the scheme name → the header/format actually applied.

| Scheme name | Type | Header / Scheme | What it means |
|---|---|---|---|
| `MemberApiKey` | apiKey | header `X-User-Code` | Logged-in user (mobile/web app). |
| `AnonymousApiKey` | apiKey | header `X-User-Code` | Anonymous web visitor. |
| `AdminApiKey` | apiKey | header `X-User-Code` | 운드민 (admin portal). |
| `AIAdminApiKey` | apiKey | header `X-User-Code` | AI 스튜디오 admin. |
| `DatadogWebhookApiKey` | apiKey | header `X-Datadog-Api-Key` | Datadog → server webhook signature. |
| `bearerAuth` | http | `Bearer <token>` | Generic OAuth/JWT. |
| `jwtAuth` | apiKey | header `Authorization` | JWT passed as raw header value. |
| `jwt` | http | `Bearer <token>` | Older JWT scheme, still referenced by some operations. |
| `apikey-header-Authorization` | apiKey | header `Authorization` | Generic API key in Authorization header. |

> ⚠️ Operations occasionally reference a security name **`x-apidog`** with no matching scheme definition. That's a known dangling reference from Apidog UI defaults — don't add it to new operations.

Pick the scheme that matches the URL prefix:
- `/seller/...`         → 셀러 토큰 (typically `bearerAuth`)
- `/admin/...`          → `AdminApiKey` / `AIAdminApiKey`
- `/webview/...`        → `MemberApiKey` (logged-in) or `AnonymousApiKey`
- `/api/v2/...`         → `MemberApiKey`
- `/community/webview/...` → `MemberApiKey`
- `/ai-studio/...`      → `MemberApiKey` or `AnonymousApiKey`

---

## 7. Folder convention

Top-level buckets:

```
ABLY/...           — main commerce API
Community/...      — community-server (자유톡 / 요즘코디 / AI챗봇 / 운세 / …)
AI스튜디오/...      — ai-studio-server
AI스튜디오/루트/... — newer ai-studio routes (post-split)
```

When choosing a folder for a new endpoint:
1. Match the URL prefix (`/community/webview/...` → `Community/<feature>`).
2. If the feature already has a folder with ≥3 endpoints, place it there. Don't create siblings for variations.
3. New top-level folders need a sign-off — discuss before creating.

---

## 8. Calling `apidog-mcp` tools — using this reference

### `create_endpoint`

Minimal payload aligned with project conventions:

```jsonc
{
  "name": "유저 자유톡 목록",
  "method": "get",
  "path": "/community/webview/members/me/talks/",
  "targetFolderPath": "Community/자유톡",
  "status": "developing",          // start as developing, flip to released after merge
  "tags": ["자유톡"],              // match the folder leaf — see §7
  "patch": {
    "x-apidog-maintainer": "BEMELON",
    "security": [{ "MemberApiKey": [] }]
  }
}
```

### `update_endpoint`

Common partial updates:

```jsonc
// Promote to released
{ "endpointId": 15170107, "status": "released" }

// Rename + change folder in one call
{ "method": "get", "path": "/admin/legacy", "name": "관리자 …",
  "targetFolderPath": "ABLY/운드민" }

// Raw schema patch — ALWAYS Apidog internal flat shape (see §5).
// OpenAPI-nested shapes here return 200 OK but the field never appears in the UI.
{ "endpointId": 15170107,
  "patch": {
    "parameters": {                 // object keyed by location, NOT an array
      "query": [{ "id":"q1","name":"page","required":false,"enable":true,
                  "example":"1","type":"integer",
                  "schema":{"type":"integer","minimum":1,"default":20} }]
    },
    "requestBody": {
      "type": "application/json",   // MIME on type field, schema directly under jsonSchema
      "required": true,
      "jsonSchema": { "type":"object","properties":{ "name":{"type":"string"} } }
    },
    "responses": [
      { "name":"Success","code":200,"contentType":"json",
        "jsonSchema":{ "type":"object","properties":{ "id":{"type":"integer"} } } }
    ]
  }
}

// Dry-run before committing a big patch
{ "endpointId": 15170107, "patch": { /* ... */ }, "dryRun": true }
```

### `delete_endpoint`

Always pass `confirm: true`. Irreversible.

---

## 9. Gotchas this skill captures so you don't relearn them

1. **`x-apidog-folder` import is silent-fail via `import-openapi`**. Folder moves must go through the internal `http-apis/{id}` PUT — `update_endpoint` / `move_endpoints` already do.
2. **`x-run-in-apidog` is the only spec-side place the numeric endpoint id appears.** Strip `api-(\d+)-run` to get the id.
3. **`x-apidog` security reference with no scheme** exists on some operations. Harmless but don't propagate it to new ops.
4. **Auto-injected headers** (`baggage`, `Authorization`, `Accept`, `Content-Type`) appear as parameters on many operations because Apidog's import keeps them. When authoring new endpoints, omit them — the Apidog UI re-adds them from the security/content-type.
5. **Status enum is narrower in practice than in docs** — stick to `released` / `developing` / `designing` unless you have a specific reason.
6. **`get_endpoint` default is the internal ground truth, NOT the OpenAPI export.** As of v0.2.x, `get_endpoint` calls `/http-apis/{eid}` directly and returns the raw payload — same shape `update_endpoint` writes to. The response is tagged `_source: "internal"`. If you want the OpenAPI form, pass `source: "openapi"` explicitly, but expect drift: the export converter drops/transforms some `requestBody`, `parameters`, and `x-apidog-*` fields, so a successful PUT can look missing through the export view.
7. **`update_endpoint` patch MUST use Apidog's internal flat shape, not OpenAPI nested.** OpenAPI nested (`content.<mime>.schema`, `parameters: [{in}]`, `responses: {"200": {...}}`) PUTs return **200 OK but the UI never shows the field** — silent UI fail, not 500. Confirmed 2026-05-19 across 11 endpoints. Use the format documented in §5 below: `requestBody.jsonSchema` (no content wrapper, `type` field = MIME), `parameters` as an object keyed by location, parameter items with top-level `id` + `enable` + `type` + nested `schema`, `responses` as an array with `{name, code, contentType, jsonSchema}`. Always verify via `get_endpoint` (default `source: "internal"` since v0.2.x) — same shape the UI reads.
8. **Use `dryRun: true` on big `update_endpoint` patches.** Returns the resolved PUT body + URL without sending the request — cheap way to sanity-check a large patch before you commit.

---

## 10. Refresh

```bash
APIDOG_ACCESS_TOKEN=adgp_… APIDOG_PROJECT_ID=856039 \
  node /Users/khwang/workspace/apidog-mcp/scripts/extract-fields.js \
  > /tmp/apidog-fields.json
```

Diff the resulting JSON against the assumptions above; update this skill when the sample set drifts (new status values, new security schemes, new top folders).
