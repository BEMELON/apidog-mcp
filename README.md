# apidog-mcp

> MCP server for [Apidog](https://apidog.com) with **working folder management**.

A drop-in replacement / supplement for `apidog-sync-mcp-server` that fixes the silent-fail issue where folder moves and folder creations on existing endpoints are accepted by the tool but never persisted by Apidog.

## Why this exists

Apidog stores an endpoint's folder in a `folderId` field on the endpoint entity itself. The OpenAPI spec exports this as `x-apidog-folder`, but writing `x-apidog-folder` back via `POST /v1/projects/{id}/import-openapi` does **not** update the endpoint's `folderId`. Apidog accepts the import, responds `success: true`, the upstream `apidog-sync-mcp-server` reports `verified: true` — but the endpoint stays where it was.

`apidog-mcp` writes through the authoritative route: `PUT /v1/projects/{pid}/http-apis/{eid}` with `{ "folderId": <fid> }`. This is the same call the Apidog web app makes when you drag an endpoint between folders, so the move actually persists and the UI tree reflects it immediately.

## Tools

| Tool | Purpose |
|---|---|
| `analyze_folders` | Folder tree + folder→endpoint mapping + list of unfoldered endpoints. Start here. |
| `list_endpoints` | Filterable endpoint listing (`filterPath`, `filterFolder`, `filterStatus`, `unfolderedOnly`). |
| `get_endpoint` | Full operation object for a single `{method, path}`. |
| `export_spec` | Raw OpenAPI export (3.0 or 3.1) including Apidog extensions. |
| `create_folder` | Create a new folder under a parent (by path or id). |
| `move_endpoints` | **Actually moves** endpoints into a folder via the internal `http-apis/{id}` PUT. |
| `create_endpoint` | Create a new endpoint under a folder. |
| `update_endpoint` | Partial update of a single endpoint (name / status / path / method / tags / description / folder / raw patch). |
| `delete_endpoint` | Delete an endpoint by id or `{method, path}`. Requires `confirm: true`. |

## Install (local path, recommended)

```bash
git clone https://github.com/BEMELON/apidog-mcp.git
cd apidog-mcp
npm install
```

Then register the server with your MCP client. For Claude Code:

```jsonc
// ~/.claude.json — under "projects" → "(your project)" → "mcpServers"
"apidog": {
  "command": "node",
  "args": ["/absolute/path/to/apidog-mcp/src/index.js"],
  "env": {
    "APIDOG_ACCESS_TOKEN": "adgp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "APIDOG_PROJECT_ID": "856039"
  }
}
```

You can also pass credentials as CLI args:

```bash
node src/index.js --access-token=adgp_... --project-id=856039
```

## Getting your credentials

- **Access token**: Apidog → top-right avatar → **Account Settings → API Access Token → New Token**. Scope: `Manage projects` for writes.
- **Project ID**: From any project URL — `https://app.apidog.com/web/project/<PROJECT_ID>/...`

## Usage examples

Inspect the current layout:

```
analyze_folders {}
```

Find every endpoint not yet in a folder:

```
list_endpoints { "unfolderedOnly": true }
```

Create a folder and move endpoints into it:

```
create_folder { "name": "Billing", "parentPath": "Admin" }
move_endpoints {
  "targetFolderPath": "Admin/Billing",
  "endpoints": [
    { "method": "get",  "path": "/admin/billing/invoices" },
    { "method": "post", "path": "/admin/billing/invoices" },
    15170107
  ]
}
```

`move_endpoints` accepts endpoint references as:
- numeric id (e.g. `15170107`), or
- `apiDetail.<id>` string, or
- `{ method, path }` (looked up via the spec).

By default it **appends** to the target folder's existing children. Pass `"replace": true` to overwrite.

Create a new endpoint under a folder:

```
create_endpoint {
  "name": "관리자 인보이스 단건 조회",
  "method": "get",
  "path": "/admin/billing/invoices/{invoice_id}",
  "targetFolderPath": "Admin/Billing",
  "status": "developing",
  "tags": ["admin", "billing"]
}
```

Edit a single endpoint (rename + change status + retag, in one call):

```
update_endpoint {
  "method": "get",
  "path": "/admin/billing/invoices",
  "name": "관리자 인보이스 목록",
  "status": "released",
  "tags": ["admin", "billing"]
}
```

Move + rename in one call by using `targetFolderPath`:

```
update_endpoint {
  "endpointId": 15170107,
  "name": "Invoice list",
  "targetFolderPath": "Admin/Billing"
}
```

Send raw schema fields the named args don't cover:

```
update_endpoint {
  "endpointId": 15170107,
  "patch": {
    "parameters": [ /* ... */ ],
    "responses":  { /* ... */ }
  }
}
```

Delete (requires `confirm: true`):

```
delete_endpoint { "method": "get", "path": "/admin/legacy/foo", "confirm": true }
```

## Implementation notes

- **Public endpoints** (`https://api.apidog.com`): `export-openapi`, `import-openapi`. Used for read-only spec snapshots.
- **Internal endpoints** (`https://app.apidog.com/api`): `api-folders` CRUD + `http-apis/{eid}` for endpoint moves. Same Bearer token works for both hosts.
- The authoritative move is `PUT /v1/projects/{pid}/http-apis/{eid}` with `{ folderId: <fid> }`. Updating `x-apidog-folder` via import-openapi, or the folder's `children` array, has **no effect** on its own.
- Folder paths are reconstructed by walking `parentId` until `type: "root"` is reached — APIDOG's own scheme.

## Differences from `apidog-sync-mcp-server`

| | apidog-sync-mcp-server | apidog-mcp |
|---|---|---|
| Folder moves | Via spec re-import — silent-fail | Via internal `http-apis` PUT — works |
| Tool count | 12 (incl. reorganization planner, schema upsert, deletion) | 8 (folder ops + endpoint update/delete + read) |
| Endpoint update | Via import-openapi — folder/path changes may be ignored | Direct internal PUT — authoritative |
| Endpoint delete | Yes | Yes (requires `confirm: true`) |

`apidog-mcp` now covers folder ops + endpoint partial update + delete via Apidog's authoritative internal route. Use `apidog-sync-mcp-server` only if you specifically need its reorganization planner or schema upsert helpers.

## License

MIT
