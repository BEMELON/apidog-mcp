/**
 * Apidog API Client
 *
 * Uses Apidog's INTERNAL api-folders endpoint for folder writes
 * because the public import-openapi route silently ignores
 * x-apidog-folder changes (the upstream apidog-sync-mcp-server bug).
 *
 * Public API (Bearer token from Apidog Settings → API Access Token):
 *   POST   /v1/projects/{pid}/export-openapi        (Apidog OpenAPI export)
 *   POST   /v1/projects/{pid}/import-openapi        (Apidog OpenAPI import)
 *
 * Internal API (same Bearer token, app-side host):
 *   GET    /v1/projects/{pid}/api-folders            (list all folders)
 *   GET    /v1/projects/{pid}/api-folders/{fid}      (folder detail)
 *   POST   /v1/projects/{pid}/api-folders            (create folder)
 *   GET    /v1/projects/{pid}/http-apis/{eid}        (endpoint detail incl. folderId)
 *   PUT    /v1/projects/{pid}/http-apis/{eid}        (update endpoint — incl. folderId)
 */

const PUBLIC_BASE = 'https://api.apidog.com';
const INTERNAL_BASE = 'https://app.apidog.com/api';
const API_VERSION = '2024-03-28';

export class ApidogClient {
  constructor(accessToken, projectId) {
    if (!accessToken) throw new Error('APIDOG_ACCESS_TOKEN is required');
    if (!projectId) throw new Error('APIDOG_PROJECT_ID is required');
    this.accessToken = accessToken;
    this.projectId = projectId;
  }

  get headers() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.accessToken}`,
      'X-Apidog-Api-Version': API_VERSION,
    };
  }

  async #request(method, url, body) {
    const init = { method, headers: this.headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(url, init);
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Apidog ${method} ${url} → ${res.status}: ${text.slice(0, 300)}`);
    }
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  }

  // ---------- Public API (export/import) ----------

  async exportSpec({ oasVersion = '3.1', includeExtensions = true } = {}) {
    const url = `${PUBLIC_BASE}/v1/projects/${this.projectId}/export-openapi?locale=en-US`;
    return this.#request('POST', url, {
      scope: { type: 'ALL' },
      options: {
        includeApidogExtensionProperties: includeExtensions,
        addFoldersToTags: false,
      },
      oasVersion,
      exportFormat: 'JSON',
    });
  }

  async importSpec(spec, options = {}) {
    const {
      targetEndpointFolderId = 0,
      targetSchemaFolderId = 0,
      endpointOverwriteBehavior = 'OVERWRITE_EXISTING',
      schemaOverwriteBehavior = 'OVERWRITE_EXISTING',
      updateFolderOfChangedEndpoint = true,
      prependBasePath = false,
    } = options;
    const url = `${PUBLIC_BASE}/v1/projects/${this.projectId}/import-openapi?locale=en-US`;
    return this.#request('POST', url, {
      input: typeof spec === 'string' ? spec : JSON.stringify(spec),
      options: {
        targetEndpointFolderId,
        targetSchemaFolderId,
        endpointOverwriteBehavior,
        schemaOverwriteBehavior,
        updateFolderOfChangedEndpoint,
        prependBasePath,
      },
    });
  }

  // ---------- Internal API (folder management) ----------

  async listFolders() {
    const url = `${INTERNAL_BASE}/v1/projects/${this.projectId}/api-folders`;
    const res = await this.#request('GET', url);
    return res?.data ?? [];
  }

  async getFolder(folderId) {
    const url = `${INTERNAL_BASE}/v1/projects/${this.projectId}/api-folders/${folderId}`;
    const res = await this.#request('GET', url);
    return res?.data ?? null;
  }

  async createFolder({ name, parentId, type = 'http' }) {
    if (!name) throw new Error('createFolder: name is required');
    if (parentId === undefined || parentId === null) throw new Error('createFolder: parentId is required (use 0 for project root)');
    const url = `${INTERNAL_BASE}/v1/projects/${this.projectId}/api-folders`;
    const res = await this.#request('POST', url, { name, parentId, type });
    return res?.data ?? null;
  }

  /**
   * Get a single HTTP endpoint's internal representation (incl. folderId).
   */
  async getHttpApi(endpointId) {
    const url = `${INTERNAL_BASE}/v1/projects/${this.projectId}/http-apis/${endpointId}`;
    const res = await this.#request('GET', url);
    return res?.data ?? null;
  }

  /**
   * Create a new HTTP endpoint via the internal POST /http-apis route
   * (the same call the Apidog web app makes when you add an endpoint).
   * `payload` must include at minimum `folderId`, `name`, `method`, `path`.
   * Everything else (parameters, requestBody, responses, status, tags,
   * description, …) is forwarded as-is.
   */
  async createHttpApi(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('createHttpApi: payload is required');
    }
    for (const k of ['folderId', 'name', 'method', 'path']) {
      if (payload[k] === undefined || payload[k] === null) {
        throw new Error(`createHttpApi: ${k} is required`);
      }
    }
    const url = `${INTERNAL_BASE}/v1/projects/${this.projectId}/http-apis`;
    const res = await this.#request('POST', url, payload);
    return res?.data ?? res;
  }

  /**
   * Generic partial update for an HTTP endpoint. Sends the given patch
   * as the PUT body to `/http-apis/{eid}` — the same authoritative route
   * the Apidog web app uses when you edit an endpoint. Only the keys you
   * include are touched; everything else on the endpoint is preserved.
   *
   * Commonly accepted keys: name, path, method, status, description,
   * tags, folderId, parameters, requestBody, responses.
   */
  async updateHttpApi(endpointId, patch) {
    if (!endpointId) throw new Error('updateHttpApi: endpointId is required');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('updateHttpApi: patch must be a non-empty object');
    }
    if (Object.keys(patch).length === 0) {
      throw new Error('updateHttpApi: patch is empty — nothing to update');
    }
    const url = `${INTERNAL_BASE}/v1/projects/${this.projectId}/http-apis/${endpointId}`;
    return this.#request('PUT', url, patch);
  }

  /**
   * Update an endpoint's folder. This is the authoritative move:
   * it writes `folderId` on the endpoint entity itself, which is
   * the true source of truth in Apidog (the folder's `children`
   * array is derived/display-only and ignored on its own).
   */
  async setEndpointFolder(endpointId, folderId) {
    return this.updateHttpApi(endpointId, { folderId });
  }

  /**
   * Delete an endpoint. Irreversible from the API — Apidog does not
   * surface a trash-recovery endpoint for HTTP APIs.
   */
  async deleteHttpApi(endpointId) {
    if (!endpointId) throw new Error('deleteHttpApi: endpointId is required');
    const url = `${INTERNAL_BASE}/v1/projects/${this.projectId}/http-apis/${endpointId}`;
    return this.#request('DELETE', url);
  }

  /**
   * Move multiple endpoints into a single target folder.
   *
   * @param {number} folderId
   * @param {Array<number|string>} endpointIds  Numeric IDs or apiDetail.* strings.
   */
  async moveEndpointsToFolder(folderId, endpointIds) {
    const ids = endpointIds.map((id) => (
      typeof id === 'string' ? Number(id.replace(/^apiDetail\./, '')) : Number(id)
    ));

    const results = [];
    for (const eid of ids) {
      try {
        await this.setEndpointFolder(eid, folderId);
        results.push({ endpointId: eid, status: 'moved' });
      } catch (err) {
        results.push({ endpointId: eid, status: 'failed', error: err.message });
      }
    }
    return { folderId, moved: results.filter((r) => r.status === 'moved').length, results };
  }

  // ---------- Helpers ----------

  /**
   * Build folder path (e.g., "ABLY/내마관") from folder tree.
   */
  static buildPathMap(folders) {
    const byId = Object.fromEntries(folders.map((f) => [f.id, f]));
    const path = (fid) => {
      const parts = [];
      let cur = fid;
      while (cur && byId[cur]) {
        const f = byId[cur];
        if (f.type === 'root') break;
        parts.unshift(f.name);
        cur = f.parentId;
      }
      return parts.join('/');
    };
    return Object.fromEntries(folders.map((f) => [f.id, path(f.id)]));
  }

  /**
   * Resolve folder ID by full path. Returns null if not found.
   */
  static resolveFolderByPath(folders, fullPath) {
    const pathMap = this.buildPathMap(folders);
    for (const [id, p] of Object.entries(pathMap)) {
      if (p === fullPath) return Number(id);
    }
    return null;
  }

  /**
   * Extract endpoint ID from x-run-in-apidog URL.
   * e.g., "https://app.apidog.com/web/project/856039/apis/api-15170107-run" → 15170107
   */
  static parseEndpointId(runUrl) {
    if (!runUrl) return null;
    const m = String(runUrl).match(/api-(\d+)-run/);
    return m ? Number(m[1]) : null;
  }

  /**
   * Walk a spec's paths and yield { method, path, id, folder, operation } for each endpoint.
   */
  static *iterEndpoints(spec) {
    const HTTP = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
    for (const [path, ops] of Object.entries(spec?.paths || {})) {
      for (const [method, op] of Object.entries(ops || {})) {
        if (!HTTP.has(method)) continue;
        yield {
          method,
          path,
          id: ApidogClient.parseEndpointId(op['x-run-in-apidog']),
          folder: op['x-apidog-folder'] || null,
          status: op['x-apidog-status'] || null,
          summary: op.summary || '',
          tags: op.tags || [],
          operation: op,
        };
      }
    }
  }
}
