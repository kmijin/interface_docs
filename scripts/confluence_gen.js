#!/usr/bin/env node
"use strict";

/**
 * scripts/confluence_gen.js
 *
 * Swagger JSON → Confluence storage XHTML 변환 CLI
 *
 * 사용법:
 *   node scripts/confluence_gen.js --file path/to/swagger.json [--prefix INF] [--no-supplement]
 *   cat swagger.json | node scripts/confluence_gen.js [--prefix INF] [--no-supplement]
 *
 * 출력 (stdout, JSON):
 *   {
 *     "parentTitle": "시스템명",
 *     "parentXhtml": "<xhtml>...",
 *     "children": [
 *       { "title": "TagName", "xhtml": "<xhtml>..." },
 *       ...
 *     ]
 *   }
 */

const fs   = require("fs");
const path = require("path");

const { fetchJson, supplementWithExternalDocs } = require("../lib/supplement_external");
const { buildTitlePage, buildTagPage, extractBaseTitle, buildTagDescMap } = require("../lib/generate_confluence");

// ── CLI 인수 파싱 ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let filePath     = null;
let swaggerUrl   = null;
let idPrefix     = "INF";
let doSupplement = true;

for (let i = 0; i < args.length; i++) {
  if      (args[i] === "--file"   && args[i + 1]) { filePath   = args[++i]; }
  else if (args[i] === "--url"    && args[i + 1]) { swaggerUrl = args[++i]; }
  else if (args[i] === "--prefix" && args[i + 1]) { idPrefix   = args[++i]; }
  else if (args[i] === "--no-supplement")          { doSupplement = false; }
}

// ── Swagger JSON 읽기 (URL, 파일, 또는 stdin) ─────────────────────────────────
async function readSwagger() {
  if (swaggerUrl) {
    process.stderr.write(`[confluence_gen] Swagger URL fetch: ${swaggerUrl}\n`);
    return fetchJson(swaggerUrl);
  }

  if (filePath) {
    const resolved = path.resolve(process.cwd(), filePath);
    return JSON.parse(fs.readFileSync(resolved, "utf8"));
  }

  // stdin
  return new Promise((resolve, reject) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => raw += chunk);
    process.stdin.on("end", () => {
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error("stdin에서 유효한 JSON을 읽지 못했습니다: " + e.message)); }
    });
    process.stdin.on("error", reject);
  });
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  let swagger = await readSwagger();

  if (doSupplement) {
    process.stderr.write("[confluence_gen] 외부 문서 보완 중...\n");
    swagger = await supplementWithExternalDocs(swagger);
  }

  // 전체 API 목록 + tag별 그룹화
  const allApis = [];
  const tagMap  = {};
  for (const [p, methods] of Object.entries(swagger.paths || {})) {
    for (const [method, op] of Object.entries(methods)) {
      if (typeof op !== "object" || Array.isArray(op)) continue;
      const tag = (op.tags || ["기타"])[0];
      if (!tagMap[tag]) tagMap[tag] = [];
      const entry = { method: method.toUpperCase(), path: p, op, tag };
      allApis.push(entry);
      tagMap[tag].push(entry);
    }
  }

  // 인터페이스 ID 부여
  const apisWithId = allApis.map((a, i) => ({
    ...a,
    infId: `${idPrefix}-${String(i + 1).padStart(3, "0")}`,
  }));

  const tagDescMap  = buildTagDescMap(swagger);
  const parentTitle = extractBaseTitle(swagger.info?.title || "API");
  const parentXhtml = buildTitlePage(swagger, apisWithId);

  // tag별 apisWithId 재그룹화
  const tagApis = {};
  for (const a of apisWithId) {
    if (!tagApis[a.tag]) tagApis[a.tag] = [];
    tagApis[a.tag].push(a);
  }

  const children = Object.entries(tagApis).map(([tag, apis]) => ({
    title: `${tagDescMap[tag] || tag} 정보 조회`,
    xhtml: buildTagPage(tag, apis, swagger, tagDescMap),
  }));

  const result = {
    parentTitle,
    parentXhtml,
    homeTitle: "기능명(홈)",
    homeXhtml: "",
    children,
  };
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main().catch(err => {
  process.stderr.write("[confluence_gen] 오류: " + err.message + "\n");
  process.exit(1);
});
