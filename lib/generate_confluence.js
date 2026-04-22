"use strict";

/**
 * Swagger → Confluence XHTML (storage format) 변환
 * generate_markdown.js와 동일한 구조로 태그별 페이지 생성
 */

// ── 스키마 유틸 ───────────────────────────────────────────────────────────────
function getComponents(swagger) {
  return { schemas: { ...(swagger.components?.schemas || {}), ...(swagger.definitions || {}) } };
}

function resolveRef(ref, components) {
  if (!ref) return null;
  const name = ref.replace(/^#\/(components\/schemas|definitions)\//, "");
  return components?.schemas?.[name] || null;
}

function getSchemaType(schema, components) {
  if (!schema) return "Object";
  if (schema.$ref) {
    const r = resolveRef(schema.$ref, components);
    return r ? getSchemaType(r, components) : schema.$ref.split("/").pop();
  }
  if (schema.type === "array")
    return `Array<${schema.items ? getSchemaType(schema.items, components) : "Object"}>`;
  return schema.type || "Object";
}

function flattenSchema(schema, components, prefix = "", requiredList = []) {
  if (!schema) return [];
  if (schema.$ref) {
    const r = resolveRef(schema.$ref, components);
    return r ? flattenSchema(r, components, prefix, requiredList) : [[prefix || "Object", "Object", "X", "", ""]];
  }
  if (schema.type === "array") {
    const item = schema.items || {};
    const ri   = item.$ref ? resolveRef(item.$ref, components) : item;
    const fn   = prefix ? `${prefix}[]` : "[]";
    const rows = [[fn, `Array<${ri?.title || "Object"}>`, "X", schema.description || "", ""]];
    if (ri?.properties) {
      for (const [k, v] of Object.entries(ri.properties)) {
        const isR = (ri.required || []).includes(k) ? "O" : "X";
        rows.push(...flattenSchema(v, components, `${fn}.${k}`, ri.required || []));
        if (rows[rows.length - 1]?.[0] === `${fn}.${k}`) rows[rows.length - 1][2] = isR;
      }
    }
    return rows;
  }
  if (schema.type === "object" || schema.properties) {
    const rows = [];
    for (const [k, v] of Object.entries(schema.properties || {})) {
      const fn   = prefix ? `${prefix}.${k}` : k;
      const isR  = (schema.required || requiredList || []).includes(k) ? "O" : "X";
      const type = getSchemaType(v, components);
      const desc = v.description || "";
      const ex   = [];
      if (v.maxLength)              ex.push(`maxLength: ${v.maxLength}`);
      if (v.minimum  !== undefined) ex.push(`min: ${v.minimum}`);
      if (v.maximum  !== undefined) ex.push(`max: ${v.maximum}`);
      rows.push([fn, type, isR, desc, ex.join(", ")]);
      if ((v.type === "object" || v.properties) && v.properties)
        rows.push(...flattenSchema(v, components, fn, v.required || []));
      else if (v.type === "array")
        rows.push(...flattenSchema(v, components, fn, []));
      else if (v.$ref) {
        const r2 = resolveRef(v.$ref, components);
        if (r2 && (r2.type === "object" || r2.properties))
          rows.push(...flattenSchema(r2, components, fn, r2.required || []));
      }
    }
    return rows;
  }
  const ex = [];
  if (schema.maxLength)            ex.push(`maxLength: ${schema.maxLength}`);
  if (schema.minimum !== undefined) ex.push(`min: ${schema.minimum}`);
  if (schema.maximum !== undefined) ex.push(`max: ${schema.maximum}`);
  return [[prefix, schema.type || "Object", requiredList.includes(prefix) ? "O" : "X", schema.description || "", ex.join(", ")]];
}

function buildParamRows(parameters, inType) {
  return (parameters || [])
    .filter(p => p.in === inType)
    .map(p => {
      const type   = p.schema?.type || p.type || "String";
      const maxLen = p.schema?.maxLength ?? p.maxLength;
      return [p.name || "", type, p.required ? "O" : "X", p.description || "", maxLen != null ? `maxLength: ${maxLen}` : ""];
    });
}

function getRequestBodySchema(op) {
  if (op.requestBody?.content?.["application/json"]?.schema)
    return op.requestBody.content["application/json"].schema;
  return (op.parameters || []).find(p => p.in === "body")?.schema || null;
}

function getResponseSchema(op) {
  for (const code of ["200", "201"]) {
    const s = op.responses?.[code]?.content?.["application/json"]?.schema;
    if (s) return s;
  }
  for (const code of ["200", "201"]) {
    const s = op.responses?.[code]?.schema;
    if (s) return s;
  }
  return null;
}

function generateMock(schema, components, depth = 0) {
  if (depth > 5) return null;
  if (!schema) return "sample";
  if (schema.$ref) {
    const r = resolveRef(schema.$ref, components);
    return r ? generateMock(r, components, depth + 1) : {};
  }
  if (schema.example !== undefined) return schema.example;
  if (schema.enum) return schema.enum[0];
  switch (schema.type) {
    case "integer": case "number": return 0;
    case "boolean": return false;
    case "array":   return [schema.items ? generateMock(schema.items, components, depth + 1) : "sample"];
    case "object": {
      const obj = {};
      for (const [k, v] of Object.entries(schema.properties || {}))
        obj[k] = generateMock(v, components, depth + 1);
      return obj;
    }
    default: return "sample";
  }
}

function buildMock(schema, components) {
  if (!schema) return null;
  try { return JSON.stringify(generateMock(schema, components), null, 2); } catch { return null; }
}

function extractRequestExample(op) {
  const content = op.requestBody?.content?.["application/json"];
  if (content) {
    if (content.examples) { const f = Object.values(content.examples)[0]; if (f?.value != null) return JSON.stringify(f.value, null, 2); }
    if (content.example != null) return JSON.stringify(content.example, null, 2);
  }
  const bp = (op.parameters || []).find(p => p.in === "body");
  if (bp?.examples?.["application/json"] != null) return JSON.stringify(bp.examples["application/json"], null, 2);
  return null;
}

function extractResponseExample(op) {
  for (const code of ["200", "201"]) {
    const resp = op.responses?.[code];
    if (!resp) continue;
    const content = resp.content?.["application/json"];
    if (content) {
      if (content.example != null) return JSON.stringify(content.example, null, 2);
      if (content.examples) { const f = Object.values(content.examples)[0]; if (f?.value != null) return JSON.stringify(f.value, null, 2); }
    }
    if (resp.examples?.["application/json"] != null) return JSON.stringify(resp.examples["application/json"], null, 2);
  }
  return null;
}

// ── 에러 응답 예시 추출 (4xx/5xx 스키마 우선) ─────────────────────────────────
function extractErrorExample(op, components) {
  for (const [code, r] of Object.entries(op.responses || {})) {
    if (String(code).startsWith("2")) continue;
    const content = r?.content?.["application/json"];
    if (content?.example != null) return JSON.stringify(content.example, null, 2);
    if (content?.examples) {
      const f = Object.values(content.examples)[0];
      if (f?.value != null) return JSON.stringify(f.value, null, 2);
    }
    if (content?.schema) return buildMock(content.schema, components);
    if (r?.schema) return buildMock(r.schema, components);
  }
  return null;
}

// ── Swagger title에서 베이스 제목 추출 (API 규격서용) ─────────────────────────
// "KT 사장이지 쇼핑센터 API Documentation" → "KT 사장이지 쇼핑센터 API 규격서"
function extractBaseTitle(title) {
  const m = String(title || "").match(/^(.*?)\s*API\b/i);
  return (m ? m[1].trim() : String(title || "").trim()) + " API 규격서";
}

// ── tag name → Korean description 매핑 빌드 ───────────────────────────────────
function buildTagDescMap(swagger) {
  const map = {};
  for (const t of swagger.tags || []) {
    if (t.name && t.description) map[t.name] = t.description;
  }
  return map;
}

// ── XHTML 헬퍼 ───────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// 헤더 가운데 정렬 포함
function xTable(headers, rows) {
  const th = headers.map(h => `<th style="text-align:center"><strong>${esc(h)}</strong></th>`).join("");
  const tr = rows.map(r =>
    `<tr>${headers.map((_, i) => `<td>${esc(r[i] ?? "")}</td>`).join("")}</tr>`
  ).join("");
  return `<table><tbody><tr>${th}</tr>${tr || `<tr>${headers.map(() => "<td></td>").join("")}</tr>`}</tbody></table>`;
}

// ── Response 예시 — 흰 배경 표, 에러/정상 두 행 ──────────────────────────────
function xResponseExampleTable(errEx, resEx) {
  const cell = (text) =>
    `<td style="background-color:#ffffff;vertical-align:top;white-space:pre-wrap;font-family:monospace">${esc(text)}</td>`;
  return `<table><tbody><tr>${cell(errEx)}</tr><tr>${cell(resEx)}</tr></tbody></table>`;
}

// ── Response-Body 계층형 테이블 (헤더 가운데 정렬) ────────────────────────────
function xRespTable(rows) {
  if (rows.length === 0) {
    return `<table><tbody>` +
      `<tr>` +
      `<th style="text-align:center"><strong>Name</strong></th>` +
      `<th style="text-align:center"><strong>Type</strong></th>` +
      `<th style="text-align:center"><strong>Nullable</strong></th>` +
      `<th style="text-align:center"><strong>Description</strong></th>` +
      `<th style="text-align:center"><strong>비고</strong></th>` +
      `</tr>` +
      `<tr><td></td><td></td><td></td><td></td><td></td></tr>` +
      `</tbody></table>`;
  }

  const parsed = rows.map(([name, type, nullable, desc, note]) => {
    const isDiv   = String(name).startsWith("──");
    if (isDiv) return { isDivider: true, label: String(name) };
    const cleaned  = String(name).replace(/\[\]/g, "");
    const parts    = cleaned.split(".");
    const depth    = parts.length - 1;
    const lastPart = parts[parts.length - 1];
    return { isDivider: false, depth, lastPart, type, nullable, desc, note };
  });

  const maxDepth = Math.max(...parsed.filter(p => !p.isDivider).map(p => p.depth), 0);
  const nameCols = maxDepth + 1;
  const totalCols = nameCols + 4; // name칸들 + Type + Nullable + Description + 비고

  const header = `<tr>` +
    `<th style="text-align:center" colspan="${nameCols}"><strong>Name</strong></th>` +
    `<th style="text-align:center"><strong>Type</strong></th>` +
    `<th style="text-align:center"><strong>Nullable</strong></th>` +
    `<th style="text-align:center"><strong>Description</strong></th>` +
    `<th style="text-align:center"><strong>비고</strong></th>` +
    `</tr>`;

  const dataRows = parsed.map(p => {
    if (p.isDivider) {
      return `<tr><td colspan="${totalCols}" style="text-align:center;font-style:italic;background-color:#f4f5f7">${esc(p.label)}</td></tr>`;
    }
    const { depth, lastPart, type, nullable, desc, note } = p;
    const nameCells = Array.from({ length: nameCols }, (_, i) =>
      `<td>${i === depth ? esc(lastPart) : ""}</td>`
    ).join("");
    return `<tr>${nameCells}<td>${esc(type)}</td><td>${esc(nullable)}</td><td>${esc(desc)}</td><td>${esc(note)}</td></tr>`;
  }).join("");

  return `<table><tbody>${header}${dataRows}</tbody></table>`;
}

// ── API 블록 마커 키 ─────────────────────────────────────────────────────────
function apiBlockKey(method, path) {
  return `${method.toUpperCase()} ${path}`;
}

// ── 태그 페이지 내 API 1개 섹션 XHTML (마커 제외) ────────────────────────────
function buildSingleApiXhtml(method, path, op, infId, swagger) {
  const components  = getComponents(swagger);
  const PARAM_HDRS  = ["Name", "Type", "Required", "Description", "비고"];
  const summary     = op.summary || `${method.toUpperCase()} ${path}`;

  const pathParams   = buildParamRows(op.parameters, "path");
  const queryParams  = buildParamRows(op.parameters, "query");
  const headerParams = buildParamRows(op.parameters, "header");
  const bodySchema   = getRequestBodySchema(op);
  const bodyRows     = bodySchema ? flattenSchema(bodySchema, components) : [];
  const respSchema   = getResponseSchema(op);
  const respRows     = respSchema ? flattenSchema(respSchema, components) : [];
  const reqEx        = extractRequestExample(op) || (bodySchema ? buildMock(bodySchema, components) : null);
  const resEx        = extractResponseExample(op) || (respSchema ? buildMock(respSchema, components) : null)
                    || JSON.stringify({ code: 200, message: "success" }, null, 2);
  const errEx        = extractErrorExample(op, components)
                    || JSON.stringify({ code: "E001", message: "에러 메시지" }, null, 2);

  const errRespRows = [];
  for (const [code, r] of Object.entries(op.responses || {})) {
    if (String(code).startsWith("2")) continue;
    const s = r?.content?.["application/json"]?.schema || r?.schema;
    if (s) { errRespRows.push(...flattenSchema(s, components)); break; }
  }

  const parts = [];
  parts.push(`<h3>${esc(summary)} (${esc(infId)})</h3>`);
  parts.push(`<h4>API 기본 정보</h4>`);
  parts.push(xTable(["Method", "URI", "Description"], [[method.toUpperCase(), path, op.description || summary]]));
  parts.push(`<h4>Request - Path Parameter</h4>`);
  parts.push(xTable(PARAM_HDRS, pathParams));
  parts.push(`<h4>Request - Query Parameter</h4>`);
  parts.push(xTable(PARAM_HDRS, queryParams));
  parts.push(`<h4>Request - Header</h4>`);
  parts.push(xTable(PARAM_HDRS, headerParams));
  parts.push(`<h4>Request - Body</h4>`);
  parts.push(xTable(PARAM_HDRS, bodyRows));
  parts.push(`<h4>Response - Body</h4>`);
  parts.push(xRespTable([...respRows, ...errRespRows]));
  parts.push(`<h4>Response 예시</h4>`);
  parts.push(xResponseExampleTable(errEx, resEx));
  parts.push(`<hr/>`);

  return parts.join("\n");
}

// ── API 1개의 Confluence 페이지 XHTML 생성 ───────────────────────────────────
function buildApiPage(method, path, op, swagger, infId) {
  const components  = getComponents(swagger);
  const PARAM_HDRS  = ["Name", "Type", "Required", "Description", "비고"];

  const summary     = op.summary || `${method.toUpperCase()} ${path}`;

  const pathParams   = buildParamRows(op.parameters, "path");
  const queryParams  = buildParamRows(op.parameters, "query");
  const headerParams = buildParamRows(op.parameters, "header");
  const bodySchema   = getRequestBodySchema(op);
  const bodyRows     = bodySchema ? flattenSchema(bodySchema, components) : [];
  const respSchema   = getResponseSchema(op);
  const respRows     = respSchema ? flattenSchema(respSchema, components) : [];
  const resEx        = extractResponseExample(op) || (respSchema ? buildMock(respSchema, components) : null)
                    || JSON.stringify({ code: 200, message: "success" }, null, 2);
  const errEx        = extractErrorExample(op, components)
                    || JSON.stringify({ code: "E001", message: "에러 메시지" }, null, 2);

  const parts = [];
  parts.push(`<h2>${esc(summary)} (${esc(infId)})</h2>`);

  parts.push(`<h3>API 기본 정보</h3>`);
  parts.push(xTable(["Method", "URI", "Description"], [[method.toUpperCase(), path, op.description || summary]]));

  parts.push(`<h3>Request - Path Parameter</h3>`);
  parts.push(xTable(PARAM_HDRS, pathParams));

  parts.push(`<h3>Request - Query Parameter</h3>`);
  parts.push(xTable(PARAM_HDRS, queryParams));

  parts.push(`<h3>Request - Header</h3>`);
  parts.push(xTable(PARAM_HDRS, headerParams));

  parts.push(`<h3>Request - Body</h3>`);
  parts.push(xTable(PARAM_HDRS, bodyRows));

  // Response-Body (성공 + 에러 파라미터, 구분행 없이)
  const errRespRows = [];
  for (const [code, r] of Object.entries(op.responses || {})) {
    if (String(code).startsWith("2")) continue;
    const s = r?.content?.["application/json"]?.schema || r?.schema;
    if (s) { errRespRows.push(...flattenSchema(s, components)); break; }
  }
  parts.push(`<h3>Response - Body</h3>`);
  parts.push(xRespTable([...respRows, ...errRespRows]));

  parts.push(`<h3>Response 예시</h3>`);
  parts.push(xResponseExampleTable(errEx, resEx));

  return parts.join("\n");
}

// ── 타이틀 부모 페이지 XHTML — 빈 내용 ─────────────────────────────────────
function buildTitlePage(swagger, apis) {
  return "";
}

// ── 태그 페이지 헤더 XHTML (API 섹션 제외) ──────────────────────────────────
function buildTagPageHeader(tag, swagger, tagDescMap = {}) {
  const today      = new Date().toISOString().slice(0, 10);
  const koreanBase = tagDescMap[tag] || tag;

  const errorCodes = new Map();
  for (const methods of Object.values(swagger.paths || {})) {
    for (const op of Object.values(methods)) {
      if (typeof op !== "object" || Array.isArray(op)) continue;
      for (const [code, r] of Object.entries(op.responses || {})) {
        if (!errorCodes.has(code)) errorCodes.set(code, r.description || "");
      }
    }
  }
  const errRows = [...errorCodes.entries()]
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([code, desc]) => [code, "", desc, ""]);

  const parts = [];
  parts.push(`<h2>${esc(koreanBase)}</h2>`);
  parts.push(`<p>${esc(koreanBase)}를 조회합니다.</p>`);
  parts.push(`<h3>작성 내역</h3>`);
  parts.push(xTable(["작성일", "작성자", "내용"], [[today, "", "최초 작성"]]));
  parts.push(`<h3>공통 에러 응답</h3>`);
  parts.push(xTable(
    ["상태코드", "에러코드", "Description", "비고"],
    errRows.length ? errRows : [["", "", "", ""]]
  ));
  parts.push(`<hr/>`);
  return parts.join("\n");
}

// ── 태그 1개의 Confluence 페이지 XHTML (API 목록 상세) ───────────────────────
// tagDescMap: { tagName: koreanDescription } — swagger.tags[].description 기반
function buildTagPage(tag, apis, swagger, tagDescMap = {}) {
  const parts = [];
  parts.push(buildTagPageHeader(tag, swagger, tagDescMap));

  for (const { method, path, op, infId } of apis) {
    const key      = apiBlockKey(method, path);
    const apiXhtml = buildSingleApiXhtml(method, path, op, infId, swagger);
    parts.push(`<!-- API-BLOCK: ${key} -->`);
    parts.push(apiXhtml);
    parts.push(`<!-- API-BLOCK-END: ${key} -->`);
  }

  return parts.join("\n");
}

module.exports = { buildApiPage, buildTitlePage, buildTagPage, buildTagPageHeader, buildSingleApiXhtml, apiBlockKey, extractBaseTitle, buildTagDescMap };
