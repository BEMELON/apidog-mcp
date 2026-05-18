#!/usr/bin/env node

/**
 * apidog-mcp
 *
 * MCP server for Apidog with WORKING folder management.
 *
 * Tools:
 *   READ
 *     - analyze_folders   → Folder tree + folder→endpoint mapping + unfoldered list
 *     - list_endpoints    → Filterable endpoint listing from current spec
 *     - get_endpoint      → Single endpoint detail
 *     - export_spec       → Raw OpenAPI export
 *
 *   WRITE (uses internal api-folders / http-apis endpoint — bypasses the import-openapi silent fail)
 *     - create_folder     → Create new folder under a parent
 *     - move_endpoints    → Move one or more endpoints into a folder by name or id
 *     - create_endpoint   → Create a new endpoint under a folder
 *     - update_endpoint   → Partial update of an endpoint (name, status, path, method, description, tags, folderId, or raw patch)
 *     - delete_endpoint   → Delete an endpoint by id or {method, path}
 *
 * Config (env or CLI args):
 *   APIDOG_ACCESS_TOKEN, APIDOG_PROJECT_ID
 *   --access-token=..., --project-id=...
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ApidogClient } from './apidog-client.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function getConfig() {
  let accessToken = process.env.APIDOG_ACCESS_TOKEN;
  let projectId = process.env.APIDOG_PROJECT_ID;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--access-token=')) accessToken = arg.split('=').slice(1).join('=');
    if (arg.startsWith('--project-id=')) projectId = arg.split('=').slice(1).join('=');
  }
  if (!accessToken) throw new Error('APIDOG_ACCESS_TOKEN is required (env or --access-token=)');
  if (!projectId) throw new Error('APIDOG_PROJECT_ID is required (env or --project-id=)');
  return { accessToken, projectId };
}

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'analyze_folders',
    description:
      'Analyze current folder structure: returns folder tree (path → endpoints), counts, and a list of endpoints that have no folder assigned. Start here when reorganizing.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_endpoints',
    description:
      'List endpoints from the current Apidog project. Filter by path substring, folder substring, or status. Returns method, path, summary, tags, folder, endpoint id.',
    inputSchema: {
      type: 'object',
      properties: {
        filterPath: { type: 'string', description: 'Substring match on path' },
        filterFolder: { type: 'string', description: 'Substring match on folder path (e.g. "ABLY/")' },
        filterStatus: { type: 'string', description: 'e.g. released, developing, deprecated' },
        unfolderedOnly: { type: 'boolean', description: 'If true, only endpoints with no folder' },
      },
    },
  },
  {
    name: 'get_endpoint',
    description:
      'Return the full operation object for a single endpoint (method + path). Use to inspect existing format before changes.',
    inputSchema: {
      type: 'object',
      required: ['method', 'path'],
      properties: {
        method: { type: 'string', enum: ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] },
        path: { type: 'string' },
      },
    },
  },
  {
    name: 'export_spec',
    description:
      'Export the full OpenAPI spec (3.1 by default) including Apidog extensions. Use for snapshots or bulk analysis.',
    inputSchema: {
      type: 'object',
      properties: {
        oasVersion: { type: 'string', enum: ['3.0', '3.1'], default: '3.1' },
        includeExtensions: { type: 'boolean', default: true },
      },
    },
  },
  {
    name: 'create_folder',
    description:
      'Create a new folder. Provide the parent either by full path (e.g. "ABLY") or by id. Returns the new folder id and full path.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Leaf folder name (no slashes)' },
        parentPath: { type: 'string', description: 'Parent folder path. Omit to create at project root (parentId=0).' },
        parentId: { type: 'number', description: 'Alternative to parentPath. 0 = project root.' },
        type: { type: 'string', enum: ['http'], default: 'http' },
      },
    },
  },
  {
    name: 'create_endpoint',
    description:
      'Create a new HTTP endpoint via the internal POST /http-apis route (the same call the Apidog web app makes when you add an endpoint). Required: `name`, `method`, `path`, and either `folderId` or `targetFolderPath`. Optional named fields cover the common cases (status, description, tags). Use `patch` to pass through anything else (parameters, requestBody, responses, etc.).',
    inputSchema: {
      type: 'object',
      required: ['name', 'method', 'path'],
      properties: {
        name: { type: 'string', description: 'Display name (summary in OpenAPI).' },
        method: { type: 'string', enum: ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] },
        path: { type: 'string', description: 'Endpoint path, e.g. /admin/billing/invoices' },
        folderId: { type: 'number', description: 'Destination folder id. Alternative to `targetFolderPath`.' },
        targetFolderPath: { type: 'string', description: 'Destination folder by full path, resolved to id (e.g. "ABLY/내마관").' },
        status: { type: 'string', description: 'e.g. released, developing, deprecated, testing, designing, obsolete' },
        description: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        patch: {
          type: 'object',
          description: 'Free-form keys merged into the POST body (e.g. parameters, requestBody, responses, customApiFields).',
          additionalProperties: true,
        },
      },
    },
  },
  {
    name: 'update_endpoint',
    description:
      'Partial update of a single endpoint via the authoritative PUT /http-apis/{eid} route (same call the Apidog web app makes when you edit an endpoint). Identify the endpoint by `endpointId` OR by `{method, path}`. Provide any of the named patch fields, and/or a free-form `patch` object for keys not covered explicitly. Only the keys you send are touched — everything else on the endpoint is preserved. Use this when you need to change an endpoint\'s name, status, path/method, tags, description, folder, or raw schema fields (parameters/requestBody/responses) without rewriting the whole spec.',
    inputSchema: {
      type: 'object',
      properties: {
        endpointId: { type: 'number', description: 'Numeric endpoint id. Alternative to method+path.' },
        method: { type: 'string', enum: ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'], description: 'Lookup key. Use with `path`.' },
        path: { type: 'string', description: 'Lookup key. Use with `method`.' },
        name: { type: 'string', description: 'Display name (summary in OpenAPI).' },
        status: { type: 'string', description: 'e.g. released, developing, deprecated, testing, designing, obsolete' },
        description: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        newPath: { type: 'string', description: 'Rewrite the endpoint path. Use this instead of `path`, which is reserved for lookup.' },
        newMethod: { type: 'string', enum: ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'], description: 'Rewrite the HTTP method. Use this instead of `method`, which is reserved for lookup.' },
        folderId: { type: 'number', description: 'Move endpoint to this folder id.' },
        targetFolderPath: { type: 'string', description: 'Move endpoint to this folder by path (resolved to id).' },
        patch: {
          type: 'object',
          description: 'Free-form keys merged into the PUT body for anything not covered by the named fields (e.g. parameters, requestBody, responses, customApiFields).',
          additionalProperties: true,
        },
      },
    },
  },
  {
    name: 'delete_endpoint',
    description:
      'Delete an endpoint via DELETE /http-apis/{eid}. IRREVERSIBLE — Apidog does not surface a trash-recovery endpoint for HTTP APIs. Requires `confirm: true` to execute. Identify by `endpointId` OR `{method, path}`.',
    inputSchema: {
      type: 'object',
      required: ['confirm'],
      properties: {
        endpointId: { type: 'number' },
        method: { type: 'string', enum: ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] },
        path: { type: 'string' },
        confirm: { type: 'boolean', description: 'Must be true. Guard against accidental destructive calls.' },
      },
    },
  },
  {
    name: 'move_endpoints',
    description:
      'Move one or more endpoints into a target folder by writing folderId on each endpoint entity. The endpoint can be identified by id (number) or by {method, path}. Target folder is identified by full path (e.g. "ABLY/내마관") or id. USE THIS WHEN apidog-sync-mcp UPSERT TOOLS APPEAR TO SUCCEED BUT THE FOLDER NEVER CHANGES — this writes the authoritative folderId field on the endpoint instead of going through import-openapi.',
    inputSchema: {
      type: 'object',
      required: ['endpoints'],
      properties: {
        endpoints: {
          type: 'array',
          description: 'Endpoints to move. Each item is either a number/string id, or {method, path}.',
          items: {
            oneOf: [
              { type: 'number' },
              { type: 'string' },
              {
                type: 'object',
                required: ['method', 'path'],
                properties: {
                  method: { type: 'string' },
                  path: { type: 'string' },
                },
              },
            ],
          },
        },
        targetFolderPath: { type: 'string', description: 'Full path of the destination folder' },
        targetFolderId: { type: 'number', description: 'Alternative to targetFolderPath' },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------
async function resolveEndpointId(client, spec, item) {
  if (typeof item === 'number') return item;
  if (typeof item === 'string') return Number(item.replace(/^apiDetail\./, ''));
  if (item && item.method && item.path) {
    const method = item.method.toLowerCase();
    const op = spec?.paths?.[item.path]?.[method];
    if (!op) throw new Error(`Endpoint not found in spec: ${item.method.toUpperCase()} ${item.path}`);
    const id = ApidogClient.parseEndpointId(op['x-run-in-apidog']);
    if (!id) throw new Error(`Endpoint has no x-run-in-apidog: ${item.method.toUpperCase()} ${item.path}`);
    return id;
  }
  throw new Error(`Unsupported endpoint reference: ${JSON.stringify(item)}`);
}

async function resolveFolderId(client, { targetFolderPath, targetFolderId, parentPath, parentId }) {
  if (typeof targetFolderId === 'number') return targetFolderId;
  if (typeof parentId === 'number') return parentId;
  const wanted = targetFolderPath || parentPath;
  if (!wanted) return 0; // project root
  const folders = await client.listFolders();
  const id = ApidogClient.resolveFolderByPath(folders, wanted);
  if (!id) throw new Error(`Folder not found: ${wanted}`);
  return id;
}

const handlers = {
  async analyze_folders({ client }) {
    const folders = await client.listFolders();
    const pathMap = ApidogClient.buildPathMap(folders);
    const spec = await client.exportSpec({ includeExtensions: true });

    const folderTree = {};
    const unfoldered = [];
    let total = 0;
    for (const ep of ApidogClient.iterEndpoints(spec)) {
      total++;
      const key = `${ep.method.toUpperCase()} ${ep.path}`;
      if (ep.folder) {
        (folderTree[ep.folder] ||= []).push(key);
      } else {
        unfoldered.push(key);
      }
    }
    const folderSizes = Object.fromEntries(
      Object.entries(folderTree).sort((a, b) => b[1].length - a[1].length).map(([k, v]) => [k, v.length])
    );
    return {
      totalEndpoints: total,
      totalFolders: Object.keys(folderTree).length,
      unfolderedCount: unfoldered.length,
      unfoldered,
      folderTree,
      folderSizes,
      folderIds: Object.fromEntries(folders.map((f) => [pathMap[f.id] || f.name, f.id])),
    };
  },

  async list_endpoints({ client, args }) {
    const spec = await client.exportSpec({ includeExtensions: true });
    const out = [];
    for (const ep of ApidogClient.iterEndpoints(spec)) {
      if (args.filterPath && !ep.path.includes(args.filterPath)) continue;
      if (args.filterFolder && !(ep.folder || '').includes(args.filterFolder)) continue;
      if (args.filterStatus && ep.status !== args.filterStatus) continue;
      if (args.unfolderedOnly && ep.folder) continue;
      out.push({
        id: ep.id,
        method: ep.method.toUpperCase(),
        path: ep.path,
        summary: ep.summary,
        folder: ep.folder,
        status: ep.status,
        tags: ep.tags,
      });
    }
    return { count: out.length, endpoints: out };
  },

  async get_endpoint({ client, args }) {
    if (!args.method || !args.path) throw new Error('method and path are required');
    const spec = await client.exportSpec({ includeExtensions: true });
    const op = spec?.paths?.[args.path]?.[args.method.toLowerCase()];
    if (!op) throw new Error(`Not found: ${args.method.toUpperCase()} ${args.path}`);
    return {
      method: args.method.toLowerCase(),
      path: args.path,
      id: ApidogClient.parseEndpointId(op['x-run-in-apidog']),
      folder: op['x-apidog-folder'] || null,
      operation: op,
    };
  },

  async export_spec({ client, args }) {
    return client.exportSpec({
      oasVersion: args.oasVersion || '3.1',
      includeExtensions: args.includeExtensions !== false,
    });
  },

  async create_folder({ client, args }) {
    if (!args.name) throw new Error('name is required');
    const parentId = await resolveFolderId(client, args);
    const folder = await client.createFolder({ name: args.name, parentId, type: args.type || 'http' });
    return {
      id: folder?.id,
      name: folder?.name,
      parentId: folder?.parentId,
      type: folder?.type,
    };
  },

  async create_endpoint({ client, args }) {
    if (!args.name || !args.method || !args.path) {
      throw new Error('create_endpoint: name, method, and path are required');
    }
    let folderId = args.folderId;
    if (folderId === undefined && args.targetFolderPath) {
      folderId = await resolveFolderId(client, { targetFolderPath: args.targetFolderPath });
    }
    if (folderId === undefined || folderId === null) {
      throw new Error('create_endpoint: provide folderId or targetFolderPath');
    }

    const payload = { ...(args.patch && typeof args.patch === 'object' ? args.patch : {}) };
    payload.folderId = folderId;
    payload.name = args.name;
    payload.method = args.method.toLowerCase();
    payload.path = args.path;
    if (args.status !== undefined) payload.status = args.status;
    if (args.description !== undefined) payload.description = args.description;
    if (args.tags !== undefined) payload.tags = args.tags;

    const created = await client.createHttpApi(payload);
    return {
      endpointId: created?.id ?? null,
      folderId,
      name: payload.name,
      method: payload.method.toUpperCase(),
      path: payload.path,
      raw: created,
    };
  },

  async update_endpoint({ client, args }) {
    const hasIdent = args.endpointId || (args.method && args.path);
    if (!hasIdent) throw new Error('Provide endpointId, or both method and path');

    // 1. Resolve endpoint id (load spec only if we need {method,path} → id)
    let endpointId = args.endpointId;
    if (!endpointId) {
      const spec = await client.exportSpec({ includeExtensions: true });
      endpointId = await resolveEndpointId(client, spec, { method: args.method, path: args.path });
    }

    // 2. Assemble patch from named fields + free-form `patch`
    const body = { ...(args.patch && typeof args.patch === 'object' ? args.patch : {}) };
    if (args.name !== undefined) body.name = args.name;
    if (args.status !== undefined) body.status = args.status;
    if (args.description !== undefined) body.description = args.description;
    if (args.tags !== undefined) body.tags = args.tags;
    if (args.newPath !== undefined) body.path = args.newPath;
    if (args.newMethod !== undefined) body.method = args.newMethod.toLowerCase();
    if (args.folderId !== undefined) body.folderId = args.folderId;
    if (args.targetFolderPath !== undefined) {
      body.folderId = await resolveFolderId(client, { targetFolderPath: args.targetFolderPath });
    }

    if (Object.keys(body).length === 0) {
      throw new Error('No update fields provided — pass at least one of name/status/description/tags/newPath/newMethod/folderId/targetFolderPath/patch');
    }

    await client.updateHttpApi(endpointId, body);
    return {
      endpointId,
      updatedKeys: Object.keys(body),
      patch: body,
    };
  },

  async delete_endpoint({ client, args }) {
    if (args.confirm !== true) {
      throw new Error('delete_endpoint refused: pass confirm=true to acknowledge this is irreversible');
    }
    const hasIdent = args.endpointId || (args.method && args.path);
    if (!hasIdent) throw new Error('Provide endpointId, or both method and path');

    let endpointId = args.endpointId;
    let resolvedFrom = null;
    if (!endpointId) {
      const spec = await client.exportSpec({ includeExtensions: true });
      endpointId = await resolveEndpointId(client, spec, { method: args.method, path: args.path });
      resolvedFrom = `${args.method.toUpperCase()} ${args.path}`;
    }

    await client.deleteHttpApi(endpointId);
    return { endpointId, resolvedFrom, deleted: true };
  },

  async move_endpoints({ client, args }) {
    if (!Array.isArray(args.endpoints) || args.endpoints.length === 0) {
      throw new Error('endpoints must be a non-empty array');
    }
    const folderId = await resolveFolderId(client, args);
    if (!folderId) throw new Error('targetFolderPath or targetFolderId is required (root is not a valid move target)');

    // Resolve endpoint references via spec (handles {method,path} → id)
    const spec = await client.exportSpec({ includeExtensions: true });
    const ids = [];
    for (const ref of args.endpoints) {
      ids.push(await resolveEndpointId(client, spec, ref));
    }

    const summary = await client.moveEndpointsToFolder(folderId, ids);

    // Build human-readable folder path for the response
    const folders = await client.listFolders();
    const pathMap = ApidogClient.buildPathMap(folders);
    return {
      folderId,
      folderPath: pathMap[folderId] || String(folderId),
      moved: summary.moved,
      results: summary.results,
      endpointIds: ids,
    };
  },
};

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------
async function main() {
  const config = getConfig();
  const client = new ApidogClient(config.accessToken, config.projectId);

  const server = new Server(
    { name: 'apidog-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const fn = handlers[name];
    if (!fn) throw new Error(`Unknown tool: ${name}`);
    try {
      const result = await fn({ client, args });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Error in ${name}: ${err.message}` }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('apidog-mcp listening on stdio');
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
