#!/usr/bin/env node
/**
 * extract-fields.js
 *
 * Survey the current Apidog project's exported OpenAPI spec to discover
 * which Apidog-specific extension keys and enum values are actually in use,
 * along with the shape of parameters / requestBody / responses.
 *
 * Output: prints a JSON summary to stdout. Pipe to a file:
 *   APIDOG_ACCESS_TOKEN=... APIDOG_PROJECT_ID=... node scripts/extract-fields.js > /tmp/apidog-fields.json
 *
 * Uses the same ApidogClient as the MCP server, so creds come from the
 * same env vars / CLI args.
 */

import { ApidogClient } from '../src/apidog-client.js';

function getConfig() {
  let accessToken = process.env.APIDOG_ACCESS_TOKEN;
  let projectId = process.env.APIDOG_PROJECT_ID;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--access-token=')) accessToken = arg.split('=').slice(1).join('=');
    if (arg.startsWith('--project-id=')) projectId = arg.split('=').slice(1).join('=');
  }
  if (!accessToken) throw new Error('APIDOG_ACCESS_TOKEN required (env or --access-token=)');
  if (!projectId) throw new Error('APIDOG_PROJECT_ID required (env or --project-id=)');
  return { accessToken, projectId };
}

function bumpCount(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function track(set, key, value, maxSamples = 5) {
  if (!set[key]) set[key] = { count: 0, samples: new Set() };
  set[key].count += 1;
  if (set[key].samples.size < maxSamples && value !== undefined) {
    set[key].samples.add(typeof value === 'string' ? value : JSON.stringify(value).slice(0, 200));
  }
}

function finalizeSet(set) {
  const out = {};
  for (const [k, { count, samples }] of Object.entries(set)) {
    out[k] = { count, samples: [...samples] };
  }
  return out;
}

function summarizeSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 3) return null;
  const out = { type: schema.type };
  if (schema.format) out.format = schema.format;
  if (schema.enum) out.enum = schema.enum.slice(0, 8);
  if (schema.$ref) out.$ref = schema.$ref;
  if (schema.type === 'object' && schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties)
        .slice(0, 10)
        .map(([k, v]) => [k, summarizeSchema(v, depth + 1)])
    );
  }
  if (schema.type === 'array' && schema.items) {
    out.items = summarizeSchema(schema.items, depth + 1);
  }
  return out;
}

async function main() {
  const cfg = getConfig();
  const client = new ApidogClient(cfg.accessToken, cfg.projectId);
  const spec = await client.exportSpec({ includeExtensions: true });

  // Operation-level
  const opExtensions = {};      // x-apidog-* keys on each operation
  const statusValues = {};      // x-apidog-status frequency
  const folderValues = {};      // x-apidog-folder frequency (top 20)
  const methodCounts = {};
  const tagCounts = {};
  const securityNames = new Set();
  const parameterIns = {};      // header/query/path/cookie counts
  const requestContentTypes = {};
  const responseStatusCodes = {};
  const responseContentTypes = {};
  const paramExamples = [];
  const responseExamples = [];

  // Spec-level extensions
  const specRootKeys = Object.keys(spec || {}).filter((k) => k.startsWith('x-'));

  let totalOps = 0;
  for (const [pathKey, ops] of Object.entries(spec.paths || {})) {
    const HTTP = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
    for (const [method, op] of Object.entries(ops || {})) {
      if (!HTTP.has(method)) continue;
      totalOps++;
      bumpCount(methodCounts, method.toUpperCase());

      for (const key of Object.keys(op)) {
        if (key.startsWith('x-')) track(opExtensions, key, op[key]);
      }
      if (op['x-apidog-status']) bumpCount(statusValues, op['x-apidog-status']);
      if (op['x-apidog-folder']) bumpCount(folderValues, op['x-apidog-folder']);
      if (Array.isArray(op.tags)) for (const t of op.tags) bumpCount(tagCounts, t);
      if (Array.isArray(op.security)) {
        for (const s of op.security) Object.keys(s || {}).forEach((n) => securityNames.add(n));
      }
      if (Array.isArray(op.parameters)) {
        for (const p of op.parameters) {
          if (p?.in) bumpCount(parameterIns, p.in);
          if (paramExamples.length < 6 && p?.schema) {
            paramExamples.push({
              endpoint: `${method.toUpperCase()} ${pathKey}`,
              parameter: { name: p.name, in: p.in, required: !!p.required, schema: summarizeSchema(p.schema) },
            });
          }
        }
      }
      if (op.requestBody?.content) {
        for (const ct of Object.keys(op.requestBody.content)) bumpCount(requestContentTypes, ct);
      }
      if (op.responses) {
        for (const [code, resp] of Object.entries(op.responses)) {
          bumpCount(responseStatusCodes, code);
          if (resp?.content) {
            for (const ct of Object.keys(resp.content)) bumpCount(responseContentTypes, ct);
          }
          if (responseExamples.length < 6 && resp?.content?.['application/json']?.schema) {
            responseExamples.push({
              endpoint: `${method.toUpperCase()} ${pathKey}`,
              status: code,
              schema: summarizeSchema(resp.content['application/json'].schema),
            });
          }
        }
      }
    }
  }

  // Components
  const schemaNames = Object.keys(spec.components?.schemas || {});
  const securitySchemes = spec.components?.securitySchemes || {};

  // Folder top
  const topFolders = Object.entries(folderValues)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  const out = {
    summary: {
      project_id: cfg.projectId,
      openapi: spec.openapi,
      info_title: spec.info?.title,
      total_operations: totalOps,
      total_schemas: schemaNames.length,
    },
    spec_root_extensions: specRootKeys,
    operation_extensions: finalizeSet(opExtensions),
    status_values: statusValues,
    method_counts: methodCounts,
    top_folders: Object.fromEntries(topFolders),
    top_tags: Object.fromEntries(
      Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 20)
    ),
    parameter_in_counts: parameterIns,
    request_content_types: requestContentTypes,
    response_status_codes: responseStatusCodes,
    response_content_types: responseContentTypes,
    security_names_in_use: [...securityNames],
    security_schemes: Object.fromEntries(
      Object.entries(securitySchemes).map(([n, s]) => [n, { type: s.type, scheme: s.scheme, name: s.name, in: s.in }])
    ),
    parameter_examples: paramExamples,
    response_examples: responseExamples,
  };

  process.stdout.write(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e?.stack || e?.message || e);
  process.exit(1);
});
