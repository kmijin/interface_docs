"use strict";

const express = require("express");
const multer  = require("multer");
const path    = require("path");
const https   = require("https");
const http    = require("http");
const yaml    = require("js-yaml");
const generateFromSwagger  = require("./lib/generate_from_swagger");
const generateMarkdown     = require("./lib/generate_markdown");
const { analyzeTemplate }  = require("./lib/analyze_template");
const { buildApiPage, buildTitlePage, buildTagPage, buildTagPageHeader, buildSingleApiXhtml, apiBlockKey, extractBaseTitle, buildTagDescMap } = require("./lib/generate_confluence");
const { fetchRaw, fetchJson: fetchJsonExt, supplementWithExternalDocs } = require("./lib/supplement_external");

// fetchJson은 supplement_external에서 가져온 것을 그대로 사용
const fetchJson = fetchJsonExt;

const app    = express();
const PORT   = 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ── Confluence 설정 파일 로드 ─────────────────────────────────────────────────
const fs = require("fs");
const CONF_CONFIG_PATH = path.join(__dirname, "confluence.config.json");
function loadConfConfig() {
  try { return JSON.parse(fs.readFileSync(CONF_CONFIG_PATH, "utf8")); }
  catch { return {}; }
}

// ── Confluence REST API 직접 호출 ─────────────────────────────────────────────
function confRequest(cfg, apiPath, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const auth    = "Basic " + Buffer.from(`${cfg.email}:${cfg.token}`).toString("base64");
    const payload = body ? JSON.stringify(body) : "";
    const parsed  = new URL(cfg.baseUrl.replace(/\/$/, "") + apiPath);
    const client  = parsed.protocol === "https:" ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        "Authorization": auth,
        "Content-Type": "application/json",
        "Accept": "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    };
    const req = client.request(opts, resp => {
      let d = "";
      resp.on("data", c => d += c);
      resp.on("end", () => resolve({ status: resp.statusCode, body: d }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── POST /analyze-template  (multipart: file = .docx) ─────────────────────────
app.post("/analyze-template", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "파일이 없습니다." });
    if (!req.file.originalname.match(/\.docx$/i))
      return res.status(400).json({ error: ".docx 파일만 지원합니다." });

    const profile = await analyzeTemplate(req.file.buffer);
    res.json({ ok: true, profile });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /fetch-swagger  (JSON: { url }) → swagger JSON 반환 ──────────────────
app.post("/fetch-swagger", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "url 필드가 없습니다." });
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: "http(s):// 로 시작하는 URL을 입력하세요." });

    const swaggerObj = await fetchJson(url);
    res.json({ ok: true, swagger: swaggerObj });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /generate  (JSON: { swagger?, swaggerUrl?, templateProfile? }) ────────
app.post("/generate", async (req, res) => {
  try {
    let { swagger, swaggerUrl, templateProfile, idPrefix } = req.body;

    // URL이 넘어온 경우 먼저 fetch
    if (!swagger && swaggerUrl) {
      if (!/^https?:\/\//i.test(swaggerUrl))
        return res.status(400).json({ error: "http(s):// 로 시작하는 URL을 입력하세요." });
      swagger = await fetchJson(swaggerUrl);
    }

    if (!swagger) return res.status(400).json({ error: "swagger 또는 swaggerUrl 필드가 필요합니다." });

    let swaggerObj = typeof swagger === "string" ? JSON.parse(swagger) : swagger;
    swaggerObj = await supplementWithExternalDocs(swaggerObj);
    const title      = swaggerObj.info?.title?.replace(/[^\w가-힣\s]/g, "").trim() || "인터페이스정의서";
    const safeTitle  = `시스템_인터페이스_정의서_${title.replace(/\s+/g, "_")}`;

    const buffer = await generateFromSwagger(swaggerObj, templateProfile || null, idPrefix || null);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(safeTitle)}.docx`);
    res.send(buffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /generate-md  (JSON: { swagger?, swaggerUrl? }) → .md 반환 ───────────
app.post("/generate-md", async (req, res) => {
  try {
    let { swagger, swaggerUrl, idPrefix } = req.body;
    if (!swagger && swaggerUrl) {
      if (!/^https?:\/\//i.test(swaggerUrl))
        return res.status(400).json({ error: "http(s):// 로 시작하는 URL을 입력하세요." });
      swagger = await fetchJson(swaggerUrl);
    }
    if (!swagger) return res.status(400).json({ error: "swagger 또는 swaggerUrl 필드가 필요합니다." });

    let swaggerObj = typeof swagger === "string" ? JSON.parse(swagger) : swagger;
    swaggerObj = await supplementWithExternalDocs(swaggerObj);
    const title      = swaggerObj.info?.title?.replace(/[^\w가-힣\s]/g, "").trim() || "인터페이스정의서";
    const safeTitle  = `시스템_인터페이스_정의서_${title.replace(/\s+/g, "_")}`;

    const md = generateMarkdown(swaggerObj, idPrefix || null);
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(safeTitle)}.md`);
    res.send(md);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /confluence-proxy  (CORS 우회 프록시) ───────────────────────────────
// body: { baseUrl, email, token, path, method?, body? }
app.post("/confluence-proxy", async (req, res) => {
  try {
    const { baseUrl, email, token, path: apiPath, method = "GET", body: reqBody } = req.body;
    if (!baseUrl || !email || !token || !apiPath)
      return res.status(400).json({ error: "baseUrl, email, token, path 필드가 필요합니다." });

    const targetUrl = baseUrl.replace(/\/$/, "") + apiPath;
    console.log(`[confluence-proxy] ${method} ${targetUrl}`);
    const auth = "Basic " + Buffer.from(`${email}:${token}`).toString("base64");

    // 모든 메서드를 직접 https/http 요청으로 통일
    const parsed = new URL(targetUrl);
    const client = parsed.protocol === "https:" ? https : http;
    const payload = (reqBody && method !== "GET") ? JSON.stringify(reqBody) : "";
    const data = await new Promise((resolve, reject) => {
      const reqOptions = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers: {
          "Authorization": auth,
          "Content-Type": "application/json",
          "Accept": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      };
      const r = client.request(reqOptions, resp => {
        let d = "";
        resp.on("data", c => d += c);
        resp.on("end", () => resolve({ status: resp.statusCode, body: d }));
      });
      r.on("error", reject);
      if (payload) r.write(payload);
      r.end();
    });

    let parsed2;
    try { parsed2 = JSON.parse(data.body || "{}"); }
    catch { parsed2 = { raw: data.body?.slice(0, 300) }; }
    return res.status(data.status).json(parsed2);
  } catch (err) {
    console.error("[confluence-proxy]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /confluence-config  (설정 정보 반환 — token 제외) ────────────────────
app.get("/confluence-config", (req, res) => {
  const cfg = loadConfConfig();
  res.json({
    ok: true,
    configured: !!(cfg.baseUrl && cfg.email && cfg.token),
    baseUrl: cfg.baseUrl || "",
    email: cfg.email || "",
    defaultSpaceKey: cfg.defaultSpaceKey || "",
    defaultParentPageId: cfg.defaultParentPageId || "",
  });
});

// ── 마커 기반 태그 페이지 파싱 ────────────────────────────────────────────────
// 반환: { header: string, blocks: Map<key, xhtml> }
function extractApiBlocks(xhtml) {
  const blocks = new Map();
  const re = /<!-- API-BLOCK: (.+?) -->\n?([\s\S]*?)\n?<!-- API-BLOCK-END: \1 -->/g;
  let match;
  while ((match = re.exec(xhtml)) !== null) {
    blocks.set(match[1], match[2]);
  }
  const firstMarker = /<!-- API-BLOCK: /.exec(xhtml);
  const header = firstMarker ? xhtml.slice(0, firstMarker.index).trimEnd() : xhtml;
  return { header, blocks };
}

// ── 기존 페이지 + 새 API 목록 병합 ──────────────────────────────────────────
// 반환: { xhtml: string, added: number, changed: number, unchanged: number }
function mergeTagPage(existingXhtml, newHeaderXhtml, newApis, swagger) {
  const hasMarkers = existingXhtml.includes("<!-- API-BLOCK: ");

  // 마커 없는 구버전 페이지 → 전체 교체
  if (!hasMarkers) {
    const parts = [newHeaderXhtml];
    for (const { method, path, op, infId } of newApis) {
      const key      = apiBlockKey(method, path);
      const apiXhtml = buildSingleApiXhtml(method, path, op, infId, swagger);
      parts.push(`<!-- API-BLOCK: ${key} -->\n${apiXhtml}\n<!-- API-BLOCK-END: ${key} -->`);
    }
    const xhtml = parts.join("\n");
    return { xhtml, added: newApis.length, changed: 0, unchanged: 0 };
  }

  const { blocks: existingBlocks } = extractApiBlocks(existingXhtml);
  let added = 0, changed = 0, unchanged = 0;

  // 헤더는 새로 생성한 것 사용
  const parts = [newHeaderXhtml];

  for (const { method, path, op, infId } of newApis) {
    const key      = apiBlockKey(method, path);
    const newXhtml = buildSingleApiXhtml(method, path, op, infId, swagger);
    const oldXhtml = existingBlocks.get(key);

    if (oldXhtml === undefined) {
      added++;
    } else if (oldXhtml.trim() === newXhtml.trim()) {
      unchanged++;
    } else {
      changed++;
    }

    parts.push(`<!-- API-BLOCK: ${key} -->\n${newXhtml}\n<!-- API-BLOCK-END: ${key} -->`);
  }

  return { xhtml: parts.join("\n"), added, changed, unchanged };
}

// ── POST /confluence-upload  (title 부모 페이지 + summary 자식 페이지) ────────
// body: { swagger, spaceKey?, parentPageId?, idPrefix? }
app.post("/confluence-upload", async (req, res) => {
  console.log("[confluence-upload] 요청 수신");
  try {
    const cfg = loadConfConfig();
    if (!cfg.baseUrl || !cfg.email || !cfg.token)
      return res.status(400).json({ error: "confluence.config.json에 baseUrl / email / token을 설정하세요." });

    let { swagger, swaggerUrl, spaceKey, parentPageId, idPrefix, email, token } = req.body;
    // 요청으로 받은 자격증명 우선, 없으면 config 파일 fallback
    const authEmail = email || cfg.email;
    const authToken = token || cfg.token;
    if (!authEmail || !authToken)
      return res.status(400).json({ error: "이메일과 API 토큰이 필요합니다." });
    cfg.email = authEmail;
    cfg.token = authToken;
    spaceKey     = spaceKey     || cfg.defaultSpaceKey;
    parentPageId = parentPageId || cfg.defaultParentPageId || null;
    if (!spaceKey) return res.status(400).json({ error: "spaceKey가 필요합니다." });

    if (!swagger && swaggerUrl) swagger = await fetchJson(swaggerUrl);
    if (!swagger) return res.status(400).json({ error: "swagger 또는 swaggerUrl 필드가 필요합니다." });

    let swaggerObj = typeof swagger === "string" ? JSON.parse(swagger) : swagger;
    swaggerObj = await supplementWithExternalDocs(swaggerObj);
    const sysTitle    = swaggerObj.info?.title || "API";
    const PREFIX      = idPrefix || "INF";
    const tagDescMap  = buildTagDescMap(swaggerObj);

    // 전체 API 목록 수집 + tag별 그룹화
    const allApis = [];
    const tagMap  = {};
    for (const [p, methods] of Object.entries(swaggerObj.paths || {})) {
      for (const [method, op] of Object.entries(methods)) {
        if (typeof op !== "object" || Array.isArray(op)) continue;
        const tag = (op.tags || ["기타"])[0];
        if (!tagMap[tag]) tagMap[tag] = [];
        const entry = { method: method.toUpperCase(), path: p, op, tag };
        allApis.push(entry);
        tagMap[tag].push(entry);
      }
    }
    if (!allApis.length) return res.status(400).json({ error: "Swagger에서 API를 찾을 수 없습니다." });

    // 인터페이스 ID 부여 (전체 순번)
    const apisWithId = allApis.map((a, i) => ({
      ...a,
      infId: `${PREFIX}-${String(i + 1).padStart(3, "0")}`,
    }));

    // 기존 페이지 검색 (body.storage 포함)
    async function findPage(pageTitle) {
      const t = encodeURIComponent(pageTitle);
      const k = encodeURIComponent(spaceKey);
      const r = await confRequest(cfg, `/wiki/rest/api/content?title=${t}&spaceKey=${k}&type=page&expand=version,body.storage`);
      const data = JSON.parse(r.body);
      return data.results?.[0] || null;
    }

    // 페이지 생성
    async function createPage(title, bodyXhtml, ancestorId) {
      const payload = {
        type: "page", title,
        space: { key: spaceKey },
        body: { storage: { value: bodyXhtml, representation: "storage" } },
        ...(ancestorId ? { ancestors: [{ id: ancestorId }] } : {}),
      };
      const r = await confRequest(cfg, "/wiki/rest/api/content", "POST", payload);
      return JSON.parse(r.body);
    }

    // 페이지 업데이트
    async function updatePage(pageId, version, title, bodyXhtml) {
      const payload = {
        type: "page", title,
        version: { number: version + 1 },
        body: { storage: { value: bodyXhtml, representation: "storage" } },
      };
      await confRequest(cfg, `/wiki/rest/api/content/${pageId}`, "PUT", payload);
    }

    let created = 0, updated = 0, skipped = 0;
    const results = [];

    // 1. 부모 페이지: "{baseTitle} API 규격서"
    const parentTitle    = extractBaseTitle(sysTitle);
    const parentXhtml    = buildTitlePage(swaggerObj, apisWithId);
    const existingParent = await findPage(parentTitle);
    let parentId;

    if (existingParent) {
      parentId = existingParent.id;
      const existingBody = existingParent.body?.storage?.value || "";
      if (existingBody.trim() !== parentXhtml.trim()) {
        await updatePage(parentId, existingParent.version.number, parentTitle, parentXhtml);
        updated++;
        results.push({ action: "updated", title: parentTitle });
      } else {
        skipped++;
        results.push({ action: "skipped", title: parentTitle });
      }
    } else {
      const created_ = await createPage(parentTitle, parentXhtml, parentPageId);
      parentId = created_.id;
      created++;
      results.push({ action: "created", title: parentTitle });
    }

    // 2. 중간 페이지: swagger별 고유 제목 — 부모의 자식
    const homeTitle    = `${parentTitle} 기능 목록`;
    const existingHome = await findPage(homeTitle);
    let homeId;

    if (existingHome) {
      homeId = existingHome.id;
      results.push({ action: "existing", title: homeTitle });
    } else {
      const createdHome = await createPage(homeTitle, "", parentId);
      homeId = createdHome.id;
      created++;
      results.push({ action: "created", title: homeTitle });
    }

    // 3. 하위 페이지: 태그별 — 마커 기반 병합
    const tagApis = {};
    for (const a of apisWithId) {
      if (!tagApis[a.tag]) tagApis[a.tag] = [];
      tagApis[a.tag].push(a);
    }

    console.log(`[confluence-upload] parentId=${parentId}, homeId=${homeId}, tags=${Object.keys(tagApis).join(",")}`);
    for (const [tag, apis] of Object.entries(tagApis)) {
      const childTitle  = `${tagDescMap[tag] || tag} 정보 조회`;
      const newHeader   = buildTagPageHeader(tag, swaggerObj, tagDescMap);
      console.log(`[confluence-upload] 태그 처리: ${childTitle}`);
      const existingChild = await findPage(childTitle);

      if (existingChild) {
        const existingBody = existingChild.body?.storage?.value || "";
        const { xhtml: mergedXhtml, added, changed, unchanged } = mergeTagPage(existingBody, newHeader, apis, swaggerObj);

        if (added > 0 || changed > 0) {
          await updatePage(existingChild.id, existingChild.version.number, childTitle, mergedXhtml);
          updated++;
          results.push({ action: "updated", title: childTitle, tag, added, changed, unchanged });
        } else {
          skipped++;
          results.push({ action: "skipped", title: childTitle, tag, unchanged });
        }
      } else {
        const childXhtml = buildTagPage(tag, apis, swaggerObj, tagDescMap);
        await createPage(childTitle, childXhtml, homeId);
        created++;
        results.push({ action: "created", title: childTitle, tag });
      }
    }

    const pageUrl = `${cfg.baseUrl}/wiki/spaces/${spaceKey}/pages/${parentId}`;
    res.json({ ok: true, created, updated, skipped, total: apisWithId.length + 1, results, pageUrl });
  } catch (err) {
    console.error("[confluence-upload]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
