"use strict";

/**
 * 외부 문서(Shopby API docs) 기반 Swagger 응답 스키마 보완 모듈
 * server.js에서 분리 — standalone 및 scripts에서 재사용 가능
 */

const https = require("https");
const http  = require("http");
const yaml  = require("js-yaml");

// ── 원시 HTTP 응답 (body + contentType) ──────────────────────────────────────
function fetchRaw(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error("너무 많은 리다이렉트"));
    const client = url.startsWith("https") ? https : http;
    client.get(url, { headers: { Accept: "application/json, text/html" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return fetchRaw(next, redirectCount + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200)
        return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve({ body: data, contentType: res.headers["content-type"] || "" }));
    }).on("error", reject);
  });
}

// ── URL → JSON fetch (HTML이면 Swagger JSON URL 자동 추출) ─────────────────────
async function fetchJson(url) {
  const { body, contentType } = await fetchRaw(url);

  if (contentType.includes("json") || body.trimStart().startsWith("{") || body.trimStart().startsWith("[")) {
    try { return JSON.parse(body); }
    catch { throw new Error("응답이 유효한 JSON이 아닙니다."); }
  }

  if (contentType.includes("html") || body.trimStart().startsWith("<")) {
    const jsonUrl = await extractSwaggerJsonUrl(url, body);
    if (jsonUrl) return fetchJson(jsonUrl);
    throw new Error("HTML 페이지에서 Swagger JSON URL을 찾지 못했습니다. api-docs 직접 URL을 입력해주세요.");
  }

  throw new Error("알 수 없는 응답 형식입니다.");
}

// ── Swagger UI HTML → JSON URL 추출 ──────────────────────────────────────────
async function extractSwaggerJsonUrl(pageUrl, html) {
  const base        = new URL(pageUrl);
  const primaryName = base.searchParams.get("urls.primaryName") || null;

  const initPaths = ["/swagger-ui/swagger-initializer.js", "/swagger-initializer.js"];
  const srcMatch  = html.match(/<script[^>]+src="([^"]*swagger-initializer[^"]*)"/i);
  if (srcMatch) {
    const p = srcMatch[1].startsWith("http") ? srcMatch[1] : new URL(srcMatch[1], base).href;
    const pathname = new URL(p, base).pathname;
    if (!initPaths.includes(pathname)) initPaths.unshift(pathname);
  }

  for (const p of initPaths) {
    try {
      const initUrl = `${base.protocol}//${base.host}${p}`;
      const { body: jsBody } = await fetchRaw(initUrl);

      const configUrlMatch = jsBody.match(/"configUrl"\s*:\s*"([^"]+)"/);
      if (configUrlMatch) {
        const configUrl = new URL(configUrlMatch[1], base).href;
        try {
          const { body: configBody } = await fetchRaw(configUrl);
          const config = JSON.parse(configBody);
          if (config.urls && Array.isArray(config.urls)) {
            const found = resolveUrlFromList(config.urls, primaryName, base);
            if (found) return found;
          }
        } catch { /* skip */ }
      }

      const found = parseSwaggerInitializer(jsBody, primaryName, base);
      if (found) return found;
    } catch { /* 없으면 skip */ }
  }

  const found = parseSwaggerInitializer(html, primaryName, base);
  if (found) return found;

  const altMatch = html.match(/<link[^>]+type="application\/json"[^>]+href="([^"]*)"/i);
  if (altMatch) return new URL(altMatch[1], base).href;

  return null;
}

function resolveUrlFromList(urls, primaryName, base) {
  let entry;
  if (primaryName) {
    const target = decodeURIComponent(primaryName).toLowerCase().trim();
    entry = urls.find(e => decodeURIComponent(String(e.name ?? "")).toLowerCase().trim() === target);
  }
  entry = entry || urls[0];
  if (!entry?.url) return null;
  const rawUrl = entry.url.replace(/ /g, "%20");
  return new URL(rawUrl, base).href;
}

function parseSwaggerInitializer(js, primaryName, base) {
  const startIdx = js.search(/\burls\s*:\s*\[/);
  if (startIdx !== -1) {
    const bracketStart = js.indexOf("[", startIdx);
    let depth = 0, i = bracketStart, inStr = false, strChar = "";
    for (; i < js.length; i++) {
      const c = js[i];
      if (inStr) {
        if (c === "\\") { i++; continue; }
        if (c === strChar) inStr = false;
      } else {
        if (c === '"' || c === "'") { inStr = true; strChar = c; }
        else if (c === "[") depth++;
        else if (c === "]") { depth--; if (depth === 0) break; }
      }
    }
    const arrStr = js.slice(bracketStart, i + 1);
    try {
      const fixed = arrStr
        .replace(/'/g, '"')
        .replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3');
      const arr = JSON.parse(fixed);
      if (primaryName && arr.length > 0) {
        const target = decodeURIComponent(primaryName).toLowerCase().trim();
        const entry  = arr.find(e => {
          const n = decodeURIComponent(String(e.name ?? "")).toLowerCase().trim();
          return n === target;
        });
        if (entry?.url) return new URL(entry.url, base).href;
      }
      if (arr[0]?.url) return new URL(arr[0].url, base).href;
    } catch { /* fallback */ }
  }

  const singleMatch = js.match(/\burl\s*:\s*["']([^"']+)["']/);
  if (singleMatch) return new URL(singleMatch[1], base).href;

  return null;
}

// ── 외부 URL 추출 (HTML <a>, 마크다운 링크, 일반 URL) ────────────────────────
function extractUrls(text) {
  if (!text) return [];
  const urls = new Set();
  for (const m of text.matchAll(/<a[^>]+href=["']([^"']+)["']/gi))
    if (/^https?:\/\//.test(m[1])) urls.add(m[1]);
  for (const m of text.matchAll(/\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g))
    urls.add(m[2]);
  for (const m of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g))
    urls.add(m[0]);
  return [...urls];
}

// ── docs.shopby.co.kr URL 파싱 ────────────────────────────────────────────────
function parseShopbyUrl(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.includes("shopby.co.kr")) return null;
    const rawName = u.searchParams.get("url.primaryName") || u.searchParams.get("urls.primaryName");
    if (!rawName) return null;
    const group = rawName.replace(/[\/\s]+$/, "").trim();
    const hash = u.hash || "";
    const parts = hash.replace(/^#\//, "").split("/");
    return { group, tag: parts[0] || null, operationId: parts[1] || null };
  } catch { return null; }
}

// ── Shopby config 캐시 ─────────────────────────────────────────────────────────
let shopbyConfigCache = null;
async function getShopbyConfig() {
  if (shopbyConfigCache) return shopbyConfigCache;
  const { body } = await fetchRaw("https://docs.shopby.co.kr/config.json");
  shopbyConfigCache = JSON.parse(body);
  return shopbyConfigCache;
}

// ── group명 → YAML URL 변환 ──────────────────────────────────────────────────
async function resolveShopbySpecUrl(group) {
  const config = await getShopbyConfig();
  const priority = ["shop", ...Object.keys(config).filter(k => k !== "shop")];
  for (const key of priority) {
    const list = config[key];
    if (!Array.isArray(list)) continue;
    const entry = list.find(e => e.name === group);
    if (entry) {
      const rel = entry.url.replace(/^\.\.\//, "");
      return `https://docs.shopby.co.kr/${rel}`;
    }
  }
  return null;
}

// ── YAML/JSON Swagger fetch & parse ──────────────────────────────────────────
const specCache = {};
async function fetchShopbySpec(group) {
  if (specCache[group]) return specCache[group];
  const specUrl = await resolveShopbySpecUrl(group);
  if (!specUrl) return null;
  const { body } = await fetchRaw(specUrl);
  const spec = specUrl.endsWith(".yml") || specUrl.endsWith(".yaml")
    ? yaml.load(body)
    : JSON.parse(body);
  specCache[group] = spec;
  return spec;
}

// ── operationId 또는 tag+path로 operation 매칭 ───────────────────────────────
function findOperation(spec, { tag, operationId }) {
  for (const [, methods] of Object.entries(spec.paths || {})) {
    for (const [, op] of Object.entries(methods)) {
      if (typeof op !== "object" || Array.isArray(op)) continue;
      if (operationId && op.operationId) {
        const opId   = op.operationId.toLowerCase().replace(/[-_]/g, "");
        const target = operationId.toLowerCase().replace(/[-_]/g, "");
        if (opId === target) return op;
      }
      if (tag && !operationId) {
        if ((op.tags || []).some(t => t.toLowerCase() === tag.toLowerCase())) return op;
      }
    }
  }
  return null;
}

// ── 외부 Swagger response schema 추출 ────────────────────────────────────────
function extractExternalRespSchema(op, extComponents) {
  for (const code of ["200", "201"]) {
    const r = op.responses?.[code];
    if (!r) continue;
    let schema = r.content?.["application/json"]?.schema || r.schema;
    if (!schema) continue;
    if (schema.$ref) {
      const name = schema.$ref.replace(/^#\/(components\/schemas|definitions)\//, "");
      schema = extComponents?.[name] || schema;
    }
    return schema;
  }
  return null;
}

// ── 스키마 properties 재귀 해소 ───────────────────────────────────────────────
function resolveSchema(schema, components) {
  if (!schema) return schema;
  if (schema.$ref) {
    const name = schema.$ref.replace(/^#\/(components\/schemas|definitions)\//, "");
    return resolveSchema(components?.[name], components);
  }
  return schema;
}

// ── 외부 스키마에서 result[] / data{} 안의 properties 추출 ───────────────────
function extractResultProperties(schema, components) {
  const resolved = resolveSchema(schema, components);
  if (!resolved) return null;

  const props = resolved.properties || {};
  for (const key of ["result", "data", "content", "list", "items"]) {
    if (props[key]) {
      const container = resolveSchema(props[key], components);
      if (container?.type === "array") {
        const items = resolveSchema(container.items, components);
        if (items?.properties) return { containerKey: key, containerType: "array", properties: items.properties, required: items.required || [] };
      }
      if (container?.type === "object" || container?.properties) {
        return { containerKey: key, containerType: "object", properties: container.properties || {}, required: container.required || [] };
      }
    }
  }
  if (resolved.type === "array") {
    const items = resolveSchema(resolved.items, components);
    if (items?.properties) return { containerKey: null, containerType: "array", properties: items.properties, required: items.required || [] };
  }
  if (resolved.properties) return { containerKey: null, containerType: "object", properties: resolved.properties, required: resolved.required || [] };
  return null;
}

// ── 로컬 Swagger의 빈 result[] / data{} 찾기 ─────────────────────────────────
function findLocalEmptyContainer(schema, components) {
  const resolve = (s) => {
    if (!s?.$ref) return s;
    const name = s.$ref.replace(/^#\/(components\/schemas|definitions)\//, "");
    return components?.[name] || s;
  };
  const root = resolve(schema);
  if (!root) return null;
  const props = root.properties || {};
  for (const key of ["result", "data", "content", "list", "items"]) {
    if (!props[key]) continue;
    const container = resolve(props[key]);
    if (container?.type === "array") {
      const items = resolve(container.items);
      if (!items?.properties) return { key, container, containerType: "array" };
    } else if ((container?.type === "object" || container?.properties) && !container?.properties) {
      return { key, container, containerType: "object" };
    }
  }
  if (!root.properties) return { key: null, container: root, containerType: root.type === "array" ? "array" : "object" };
  return null;
}

// ── $ref 스키마를 딥카피하여 operation 전용 인라인 스키마로 교체 ──────────────
function inlineRefSchema(respHolder, localSchema, localComponents) {
  if (!localSchema?.$ref) return localSchema;
  const name = localSchema.$ref.replace(/^#\/(components\/schemas|definitions)\//, "");
  const resolved = localComponents?.[name];
  if (!resolved) return localSchema;
  const cloned = JSON.parse(JSON.stringify(resolved));
  if (respHolder) respHolder.schema = cloned;
  return cloned;
}

// ── 메인: Swagger 응답 스키마에 외부 Shopby 문서 필드 보완 ────────────────────
async function supplementWithExternalDocs(swagger) {
  const localComponents = { ...(swagger.components?.schemas || {}), ...(swagger.definitions || {}) };
  const paths = swagger.paths || {};

  for (const [, methods] of Object.entries(paths)) {
    for (const [, op] of Object.entries(methods)) {
      if (typeof op !== "object" || Array.isArray(op)) continue;
      const desc = op.description || "";
      const urls = extractUrls(desc);
      if (!urls.length) continue;

      let respHolder = null;
      let localSchema = null;
      for (const code of ["200", "201"]) {
        const r = op.responses?.[code];
        if (!r) continue;
        const c = r.content?.["application/json"];
        if (c?.schema) { localSchema = c.schema; respHolder = c; break; }
        if (r.schema)  { localSchema = r.schema; respHolder = r; break; }
      }

      localSchema = inlineRefSchema(respHolder, localSchema, localComponents);

      const emptyContainer = findLocalEmptyContainer(localSchema, localComponents);
      if (!emptyContainer) continue;

      for (const url of urls) {
        const parsed = parseShopbyUrl(url);
        if (!parsed) continue;
        try {
          const extSpec = await fetchShopbySpec(parsed.group);
          if (!extSpec) continue;
          const extComponents = { ...(extSpec.components?.schemas || {}), ...(extSpec.definitions || {}) };
          const extOp = findOperation(extSpec, parsed);
          if (!extOp) { console.log(`[외부문서] operationId 매칭 실패: ${parsed.operationId} (group: ${parsed.group})`); continue; }

          const extRespSchema = extractExternalRespSchema(extOp, extComponents);
          if (!extRespSchema) continue;
          const extracted = extractResultProperties(extRespSchema, extComponents);
          if (!extracted?.properties) continue;

          const { key, container, containerType } = emptyContainer;
          const injectedSchema = {
            type: "object",
            properties: extracted.properties,
            ...(extracted.required?.length ? { required: extracted.required } : {}),
          };

          if (key === null) {
            if (respHolder) respHolder.schema = containerType === "array"
              ? { type: "array", items: injectedSchema }
              : injectedSchema;
          } else if (containerType === "array") {
            container.items = injectedSchema;
          } else {
            container.properties = extracted.properties;
            if (extracted.required?.length) container.required = extracted.required;
          }

          console.log(`[외부문서 보완 성공] ${parsed.group}/${parsed.operationId} → ${key || "root"}[${containerType}]에 ${Object.keys(extracted.properties).length}개 필드 주입`);
          break;
        } catch (e) {
          console.log(`[외부문서 보완 실패] ${url}: ${e.message}`);
        }
      }
    }
  }
  return swagger;
}

module.exports = {
  fetchRaw,
  fetchJson,
  supplementWithExternalDocs,
};
