"use strict";

/**
 * Swagger → 마크다운 인터페이스 정의서 생성
 * generate_from_swagger.js의 스키마 유틸을 재사용하지 않고 독립 구현
 * (서버 재사용성을 위해 별도 파일로 분리)
 */

// ── 스키마 유틸 (generate_from_swagger.js와 동일 로직) ────────────────────────
function getComponents(swagger) {
  return {
    schemas: {
      ...(swagger.components?.schemas || {}),
      ...(swagger.definitions || {}),
    },
  };
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
    return r ? flattenSchema(r, components, prefix, requiredList) : [[prefix || "Object", "Object", "N", "", ""]];
  }
  if (schema.type === "array") {
    const item = schema.items || {};
    const ri   = item.$ref ? resolveRef(item.$ref, components) : item;
    const fn   = prefix ? `${prefix}[]` : "[]";
    const rows = [[fn, `Array<${ri?.title || "Object"}>`, "N", schema.description || "", ""]];
    if (ri?.properties) {
      for (const [k, v] of Object.entries(ri.properties)) {
        const isR = (ri.required || []).includes(k) ? "Y" : "N";
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
      const isR  = (schema.required || requiredList || []).includes(k) ? "Y" : "N";
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
  if (schema.maxLength)           ex.push(`maxLength: ${schema.maxLength}`);
  if (schema.minimum !== undefined) ex.push(`min: ${schema.minimum}`);
  if (schema.maximum !== undefined) ex.push(`max: ${schema.maximum}`);
  return [[prefix, schema.type || "Object", requiredList.includes(prefix) ? "Y" : "N", schema.description || "", ex.join(", ")]];
}

function buildParamRows(parameters, inType) {
  return (parameters || [])
    .filter(p => p.in === inType)
    .map(p => {
      const type   = p.schema?.type || p.type || "String";
      const maxLen = p.schema?.maxLength ?? p.maxLength;
      return [p.name || "", type, p.required ? "Y" : "N", p.description || "", maxLen != null ? `maxLength: ${maxLen}` : ""];
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

function getHttpStatusText(code) {
  return { "200": "OK", "201": "Created", "204": "No Content", "400": "Bad Request", "401": "Unauthorized", "403": "Forbidden", "404": "Not Found", "500": "Internal Server Error" }[String(code)] || "";
}

// ── 마크다운 테이블 헬퍼 ──────────────────────────────────────────────────────
function mdTable(headers, rows) {
  const esc = s => String(s ?? "").replace(/\|/g, "\\|");
  const sep = headers.map(() => "---");
  const lines = [
    `| ${headers.map(esc).join(" | ")} |`,
    `| ${sep.join(" | ")} |`,
    ...rows.map(r => `| ${headers.map((_, i) => esc(r[i] ?? "")).join(" | ")} |`),
  ];
  return lines.join("\n");
}

function mdEmptyTable(headers) {
  return mdTable(headers, [headers.map(() => "")]);
}

// ── 마크다운 생성 ─────────────────────────────────────────────────────────────
function generateMarkdown(swagger, idPrefix) {
  const components = getComponents(swagger);
  const paths      = swagger.paths || {};
  const sysTitle   = swagger.info?.title || "API";
  const version    = swagger.info?.version || "v1.0";
  const today      = new Date().toISOString().slice(0, 10);
  const desc       = (swagger.info?.description || "").replace(/<[^>]*>/g, " ").replace(/s+/g, " ").trim();
  const N          = 4;
  const ID_PREFIX  = idPrefix || "INF";

  const lines = [];

  // 표지
  lines.push(`# 시스템 인터페이스 정의서`);
  lines.push(`## ${sysTitle}`);
  lines.push("");
  lines.push(mdTable(["항목", "내용"], [
    ["문서 번호", ""],
    ["문서 버전", version],
    ["작성 일자", today],
    ["작성자", swagger.info?.contact?.name || ""],
  ]));
  lines.push("");
  lines.push("---");
  lines.push("");

  // 태그별 API 목록 수집
  const tagOrder = [];
  const tagMap   = {};
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (typeof op !== "object" || Array.isArray(op)) continue;
      const tag = (op.tags || ["기타"])[0];
      if (!tagMap[tag]) { tagMap[tag] = []; tagOrder.push(tag); }
      tagMap[tag].push({ path, method, op });
    }
  }

  // 목차
  lines.push("## 목차");
  lines.push("");
  lines.push(`- [1. 시스템 인터페이스 개요](#1-시스템-인터페이스-개요)`);
  lines.push(`- [2. 시스템 인터페이스 연동 방법](#2-시스템-인터페이스-연동-방법)`);
  lines.push(`- [3. 시스템 인터페이스 정보](#3-시스템-인터페이스-정보)`);
  lines.push(`- [${N}. 시스템 인터페이스 명세서](#${N}-시스템-인터페이스-명세서)`);
  let tocIdx = 1;
  for (const tag of tagOrder) {
    for (const { op } of tagMap[tag]) {
      const infId   = `${ID_PREFIX}-${String(tocIdx).padStart(3, "0")}`;
      const summary = op.summary || "";
      const anchor  = `${N}${tocIdx}-${summary.toLowerCase().replace(/[^w가-힣]/g, "-")}-${infId.toLowerCase()}`;
      lines.push(`  - [${N}.${tocIdx}. ${summary} (${infId})](#${anchor})`);
      tocIdx++;
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("");

  // 섹션 1: 시스템 인터페이스 개요
  lines.push(`## 1. 시스템 인터페이스 개요`);
  lines.push("");
  lines.push(`### 1.1. 개요`);
  lines.push("");
  lines.push(`본 문서는 ${sysTitle}의 API Communication을 기술한 문서이다.`);
  lines.push(`본 문서를 기준으로 ${sysTitle} 구성을 위한 데이터 연동을 진행한다.`);
  if (desc) lines.push(desc);
  lines.push("");
  lines.push("---");
  lines.push("");

  // 섹션 2: 시스템 인터페이스 연동 방법
  lines.push(`## 2. 시스템 인터페이스 연동 방법`);
  lines.push("");
  lines.push(`### 2.1. 서버정보`);
  lines.push("");
  const servers = swagger.servers || (swagger.host ? [{ url: `${(swagger.schemes?.[0] || "https")}://${swagger.host}${swagger.basePath || ""}` }] : []);
  if (servers.length > 0) {
    lines.push(mdTable(["환경", "URL", "설명"], servers.map((s, i) => [i === 0 ? "운영" : "개발", s.url || "", s.description || ""])));
  } else {
    lines.push(mdTable(["환경", "URL", "설명"], [["운영", "", ""]]));
  }
  lines.push("");
  lines.push(`### 2.2. REQUEST 정보`);
  lines.push("");
  lines.push(mdTable(["항목", "값", "필수여부", "설명"], [["Content-Type", "application/json", "Y", ""], ["Authorization", "", "N", ""]]));
  lines.push("");
  lines.push("---");
  lines.push("");

  // 섹션 3: 시스템 인터페이스 정보
  lines.push(`## 3. 시스템 인터페이스 정보`);
  lines.push("");
  lines.push(`### 3.1. 기본정보`);
  lines.push("");
  lines.push(mdTable(["항목", "내용"], [
    ["시스템명", sysTitle],
    ["버전", version],
    ["설명", desc],
  ]));
  lines.push("");
  lines.push(`### 3.2. 인터페이스 정보 목록`);
  lines.push("");
  lines.push("문서 목차로 대체합니다.");
  lines.push("");
  lines.push("---");
  lines.push("");

  // 섹션 4: 시스템 인터페이스 명세서
  lines.push(`## ${N}. 시스템 인터페이스 명세서`);
  lines.push("");

  const PARAM_HDRS = ["Name", "Type", "Required", "Description", "비고"];
  let idx = 1;
  for (const tag of tagOrder) {
    for (const { path, method, op } of tagMap[tag]) {
      const infId   = `${ID_PREFIX}-${String(idx).padStart(3, "0")}`;
      const summary = op.summary || `${method.toUpperCase()} ${path}`;

      lines.push(`### ${N}.${idx}. ${summary} (${infId})`);
      lines.push("");

      let sub = 1;

      lines.push(`#### ${N}.${idx}.${sub++}. API 기본 정보`);
      lines.push("");
      lines.push(mdTable(["Method", "URI", "Description"], [[method.toUpperCase(), path, summary]]));
      lines.push("");

      const pathParams  = buildParamRows(op.parameters, "path");
      const queryParams = buildParamRows(op.parameters, "query");
      const bodySchema  = getRequestBodySchema(op);
      const bodyRows    = bodySchema ? flattenSchema(bodySchema, components) : [];
      const respSchema  = getResponseSchema(op);
      const respRows    = respSchema ? flattenSchema(respSchema, components) : [];

      lines.push(`#### ${N}.${idx}.${sub++}. Request - Path Parameters`);
      lines.push("");
      lines.push(pathParams.length > 0 ? mdTable(PARAM_HDRS, pathParams) : mdEmptyTable(PARAM_HDRS));
      lines.push("");

      lines.push(`#### ${N}.${idx}.${sub++}. Request - Query Parameters`);
      lines.push("");
      lines.push(queryParams.length > 0 ? mdTable(PARAM_HDRS, queryParams) : mdEmptyTable(PARAM_HDRS));
      lines.push("");

      lines.push(`#### ${N}.${idx}.${sub++}. Request - Body`);
      lines.push("");
      lines.push(bodyRows.length > 0 ? mdTable(PARAM_HDRS, bodyRows) : mdEmptyTable(PARAM_HDRS));
      lines.push("");

      lines.push(`#### ${N}.${idx}.${sub++}. Response - Body`);
      lines.push("");
      lines.push(respRows.length > 0 ? mdTable(["Name", "Type", "Nullable", "Description", "비고"], respRows) : mdEmptyTable(["Name", "Type", "Nullable", "Description", "비고"]));
      lines.push("");

      lines.push(`#### ${N}.${idx}.${sub++}. JSON 예시`);
      lines.push("");
      const reqEx = extractRequestExample(op) || (bodySchema ? buildMock(bodySchema, components) : null);
      const resEx = extractResponseExample(op) || (respSchema ? buildMock(respSchema, components) : null)
                 || JSON.stringify({ code: 200, message: "success" }, null, 2);
      if (reqEx) {
        lines.push("**[ Request ]**");
        lines.push("```json");
        lines.push(reqEx);
        lines.push("```");
        lines.push("");
      }
      lines.push("**[ Response ]**");
      lines.push("```json");
      lines.push(resEx);
      lines.push("```");
      lines.push("");
      lines.push("---");
      lines.push("");

      idx++;
    }
  }

  return lines.join("\n");
}

module.exports = generateMarkdown;
