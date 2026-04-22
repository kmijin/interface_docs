"use strict";

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Footer, AlignmentType, HeadingLevel, BorderStyle, WidthType,
  ShadingType, VerticalAlign, PageNumber, PageBreak, TableOfContents,
  VerticalMergeType, TableLayoutType,
} = require("docx");

// ── 상수 (프로파일로 재설정 가능) ─────────────────────────────────────────────
let FONT        = "맑은 고딕";
let PAGE_W      = 11906;
let PAGE_H      = 16838;
let MARGIN      = 1440;
let CONTENT_W   = PAGE_W - MARGIN * 2;
let BLACK       = "000000";
let HEADER_BG   = null;   // null = 배경색 없음(기본/md 무채색), 문자열 = 템플릿 색상
let BORDER_CLR  = "000000";
const WHITE     = "FFFFFF";
const CM        = { top: 80, bottom: 80, left: 120, right: 120 };

// 프로파일 적용 — 매 호출마다 기본값으로 리셋 후 적용
// · 양식 없음 → md 스타일(무채색, 배경색 없음)
// · 양식 있음 → 템플릿의 폰트·레이아웃·색상 반영
function applyProfile(profile) {
  FONT       = "맑은 고딕";
  PAGE_W     = 11906;
  PAGE_H     = 16838;
  MARGIN     = 1440;
  BLACK      = "000000";
  HEADER_BG  = null;
  BORDER_CLR = "000000";

  if (!profile) { CONTENT_W = PAGE_W - MARGIN * 2; return; }

  if (profile.font)               FONT       = profile.font;
  if (profile.colors?.text)       BLACK      = profile.colors.text;
  if (profile.colors?.headerBg)   HEADER_BG  = profile.colors.headerBg;
  if (profile.colors?.border)     BORDER_CLR = profile.colors.border;
  if (profile.layout?.pageWidth)  PAGE_W     = profile.layout.pageWidth;
  if (profile.layout?.pageHeight) PAGE_H     = profile.layout.pageHeight;
  if (profile.layout?.margins)    MARGIN     = profile.layout.margins.top || MARGIN;
  CONTENT_W = PAGE_W
    - (profile.layout?.margins?.left  || MARGIN)
    - (profile.layout?.margins?.right || MARGIN);
}

// ── 테두리 헬퍼 (BORDER_CLR 반영) ────────────────────────────────────────────
function mkBorder(size = 4) { return { style: BorderStyle.SINGLE, size, color: BORDER_CLR }; }
function mkNoBorder()       { return { style: BorderStyle.NONE,   size: 0, color: WHITE }; }
function mkThinBorders()    { const b = mkBorder(2); return { top: b, bottom: b, left: b, right: b }; }
function mkAllBorders()     { const b = mkBorder(4); return { top: b, bottom: b, left: b, right: b }; }
function mkNoBorders()      { const b = mkNoBorder(); return { top: b, bottom: b, left: b, right: b }; }

// ── 폰트/단락 헬퍼 ────────────────────────────────────────────────────────────
function run(text, opts = {}) {
  return new TextRun({ text: String(text ?? ""), font: FONT, color: BLACK, size: 20, ...opts });
}
function para(children, opts = {}) {
  if (typeof children === "string") children = [run(children)];
  return new Paragraph({ children: Array.isArray(children) ? children : [children], ...opts });
}

// md 스타일 가이드: 헤딩은 맑은 고딕, 검정, 볼드 — 유채색 금지
function heading1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children: [new TextRun({ text, font: FONT, color: BLACK, bold: true, size: 28 })],
    spacing: { before: 240, after: 120 },
  });
}
function heading2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    children: [new TextRun({ text, font: FONT, color: BLACK, bold: true, size: 24 })],
    spacing: { before: 200, after: 100 },
  });
}
function heading3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    children: [new TextRun({ text, font: FONT, color: BLACK, bold: true, size: 22 })],
    spacing: { before: 160, after: 80 },
  });
}

// ── 표 헬퍼 ───────────────────────────────────────────────────────────────────
function cell(content, opts = {}) {
  const {
    bold = false, shading = null, colSpan, rowSpan, width,
    align = AlignmentType.LEFT, vAlign = VerticalAlign.CENTER,
    borders = mkThinBorders(),
  } = opts;
  let children;
  if (typeof content === "string") {
    children = [new Paragraph({
      alignment: align,
      children: [new TextRun({ text: content, font: FONT, color: BLACK, bold, size: 20 })],
    })];
  } else if (Array.isArray(content) && content.every(c => c instanceof Paragraph)) {
    children = content;
  } else {
    children = content;
  }
  const cellOpts = { children, borders, margins: CM, verticalAlign: vAlign };
  if (shading)    cellOpts.shading      = shading;
  if (colSpan > 1) cellOpts.columnSpan  = colSpan;
  if (rowSpan > 1) cellOpts.rowSpan     = rowSpan;
  if (width)      cellOpts.width        = { size: width, type: WidthType.DXA };
  return new TableCell(cellOpts);
}

// 헤더 셀: 양식 없음 → Bold만(무채색), 양식 있음 → 템플릿 배경색 적용
function headerCell(text, width, colSpan) {
  const shading = HEADER_BG
    ? { fill: HEADER_BG, type: ShadingType.CLEAR, color: BLACK }
    : null;
  return cell(text, { bold: true, shading, width, align: AlignmentType.CENTER, colSpan });
}

// 파라미터 타입 라벨 (표 위에 붙는 굵은 소제목)
function paramLabel(text) {
  return new Paragraph({
    children: [new TextRun({ text, font: FONT, color: BLACK, bold: true, size: 20 })],
    spacing: { before: 120, after: 40 },
  });
}

// ── 계층형 파라미터 표 (다중 H열 + 물리적 수직 병합) ─────────────────────────
// 열 구성: [H0 | H1 | ... | Hn | Name | Type | Req/Nullable | Description | 비고]
// H열은 계층 깊이만큼 추가되며 너비는 ~0.4cm (220 DXA)
const H_W  = 220;   // 계층 마커 열 너비 (~0.39cm)
const HC_W = [1100, 900, 3106, 1600]; // Type, Req, Desc, 비고 (Name은 동적 계산)

// 스키마 → 트리 노드 { name, type, req, desc, children[] }
function buildSchemaTree(schema, components, name, reqList = []) {
  if (!schema) return null;
  const resolved = schema.$ref ? resolveRef(schema.$ref, components) || schema : schema;
  const type = getSchemaType(schema, components);
  const req  = reqList.includes(name) ? "Y" : "N";
  const desc = resolved.description || schema.description || "";
  const extra = [];
  if (resolved.maxLength) extra.push(`maxLength: ${resolved.maxLength}`);
  if (resolved.minimum  !== undefined) extra.push(`min: ${resolved.minimum}`);
  if (resolved.maximum  !== undefined) extra.push(`max: ${resolved.maximum}`);

  let children = [];
  if (resolved.type === "array" && resolved.items) {
    const items = resolved.items.$ref ? resolveRef(resolved.items.$ref, components) || resolved.items : resolved.items;
    if (items?.properties)
      children = Object.entries(items.properties).map(([k, v]) => buildSchemaTree(v, components, k, items.required || [])).filter(Boolean);
  } else if (resolved.type === "object" || resolved.properties) {
    children = Object.entries(resolved.properties || {}).map(([k, v]) => buildSchemaTree(v, components, k, resolved.required || [])).filter(Boolean);
  } else if (resolved.$ref) {
    const r2 = resolveRef(resolved.$ref, components);
    if (r2?.properties)
      children = Object.entries(r2.properties).map(([k, v]) => buildSchemaTree(v, components, k, r2.required || [])).filter(Boolean);
  }
  return { name, type, req, desc, bigoNote: extra.join(", "), children };
}

// 트리 노드의 총 행 수 (자신 + 모든 자손)
function countRows(node) {
  if (!node.children.length) return 1;
  return 1 + node.children.reduce((s, c) => s + countRows(c), 0);
}

// 트리 최대 깊이 (루트=0)
function getMaxDepth(nodes, d = 0) {
  let max = d;
  for (const node of nodes) {
    if (node.children.length > 0)
      max = Math.max(max, getMaxDepth(node.children, d + 1));
  }
  return max;
}

// vMerge 연속 셀 (rowSpan 점유된 칸의 하위 행에 필요)
function mergeContCell(w) {
  return new TableCell({
    verticalMerge: VerticalMergeType.CONTINUE,
    width: { size: w, type: WidthType.DXA },
    borders: mkThinBorders(),
    children: [new Paragraph({ children: [] })],
  });
}

// vMerge 시작 셀 (부모 노드의 H열) — verticalMerge만 사용, rowSpan 중복 제거
function mergeStartCell(w) {
  return new TableCell({
    verticalMerge: VerticalMergeType.RESTART,
    width: { size: w, type: WidthType.DXA },
    borders: mkThinBorders(),
    margins: CM,
    children: [new Paragraph({ children: [] })],
  });
}

// 다중 H열 계층 행 렌더링 — '부모 독립 행 + 다음 줄 자식 분할' 규칙
// fencedCols  : 조상 vMerge가 점유 중인 H열 인덱스 Set (CONTINUE 셀 생성)
// starterCols : 이번 행에서 처음 RESTART해야 할 H열 인덱스 Set
function renderHierRowsMulti(nodes, depth, maxDepth, fencedCols = new Set(), starterCols = new Set(), nameW = 2000) {
  const rows = [];
  let isFirstSibling = true;

  for (const node of nodes) {
    const hasChildren = node.children.length > 0;

    // ── H열 셀 구성 (depth 이전의 조상 울타리 열들) ──────────────────
    const hCells = [];
    for (let c = 0; c < depth; c++) {
      if (isFirstSibling && starterCols.has(c)) {
        hCells.push(mergeStartCell(H_W));   // 첫 자식 행: RESTART
      } else if (fencedCols.has(c) || starterCols.has(c)) {
        hCells.push(mergeContCell(H_W));    // 이후 자식 행: CONTINUE
      } else {
        hCells.push(cell("", { width: H_W }));
      }
    }

    // 첫 행 이후엔 starterCols → fencedCols로 전환
    const activeFenced = new Set([...fencedCols, ...starterCols]);
    isFirstSibling = false;

    // ── 이름 칸: cells[depth]..cells[name_col] 가로 병합 ──────────────
    // 남은 H열(depth..maxDepth-1) + Name열 = (maxDepth - depth + 1)개 칸 병합
    const spanCols = maxDepth - depth + 1;
    const spanW    = H_W * (maxDepth - depth) + nameW;

    rows.push(new TableRow({ children: [
      ...hCells,
      cell(node.name, { colSpan: spanCols, width: spanW }),
      cell(node.type,     { width: HC_W[0] }),
      cell(node.req,      { width: HC_W[1], align: AlignmentType.CENTER }),
      cell(node.desc,     { width: HC_W[2] }),
      cell(node.bigoNote, { width: HC_W[3] }),
    ]}));

    if (hasChildren) {
      // depth열이 자식들의 울타리가 됨: 첫 자식 행에서 RESTART
      rows.push(...renderHierRowsMulti(
        node.children,
        depth + 1,
        maxDepth,
        activeFenced,       // 기존 조상 울타리 (CONTINUE)
        new Set([depth]),   // 새로 시작할 울타리 (RESTART → 첫 자식 행)
        nameW,
      ));
    }
  }
  return rows;
}

// 계층형 테이블 생성 (schema 트리 기반, 다중 H열)
function makeHierTable(headers, schema, components) {
  // 트리 구성
  const resolved = schema?.$ref ? resolveRef(schema.$ref, components) || schema : schema;
  let props = {}, reqList = [];
  if (resolved) {
    if (resolved.type === "array" && resolved.items) {
      const items = resolved.items.$ref ? resolveRef(resolved.items.$ref, components) || resolved.items : resolved.items;
      props   = items?.properties || {};
      reqList = items?.required   || [];
    } else {
      props   = resolved.properties || {};
      reqList = resolved.required   || [];
    }
  }
  const nodes = Object.entries(props).map(([k, v]) => buildSchemaTree(v, components, k, reqList)).filter(Boolean);

  // 최대 깊이 → H열 수 (부모가 있는 경우만 H열 생성, 없으면 0)
  const maxD = nodes.length ? getMaxDepth(nodes) : 0;

  // Name열 너비: 전체 폭에서 H열*N + 나머지 데이터 열 제거
  const fixedW  = HC_W.reduce((a, b) => a + b, 0); // Type+Req+Desc+비고
  const nameW   = Math.max(800, CONTENT_W - maxD * H_W - fixedW);
  const colWidths = [...Array(maxD).fill(H_W), nameW, ...HC_W];
  const totalW  = colWidths.reduce((a, b) => a + b, 0);

  // 헤더행: H열 전체 + Name열을 가로 병합 → 단일 "Name" 칸 (H열 없으면 일반 셀)
  const nameHdrW  = H_W * maxD + nameW;
  const nameColSpan = maxD + 1;   // H0..H(maxD-1) + Name
  const hdrRow = new TableRow({ children: [
    headerCell(headers[0], nameHdrW, nameColSpan > 1 ? nameColSpan : undefined),
    ...headers.slice(1).map((h, i) => headerCell(h, HC_W[i])),
  ]});

  // 데이터행
  const dataRows = nodes.length
    ? renderHierRowsMulti(nodes, 0, maxD, new Set(), new Set(), nameW)
    : [new TableRow({ children: colWidths.map(w => cell("", { width: w })) })];

  return new Table({ layout: TableLayoutType.FIXED, width: { size: totalW, type: WidthType.DXA }, columnWidths: colWidths, rows: [hdrRow, ...dataRows] });
}

// 파라미터 행(Path/Query) → 단순 평면 테이블 (계층 없음, H열 없음)
function makeParamHierTable(headers, paramRows) {
  const fixedW = HC_W.reduce((a, b) => a + b, 0);
  const nameW  = Math.max(800, CONTENT_W - fixedW);
  const colWidths = [nameW, ...HC_W];
  const totalW = colWidths.reduce((a, b) => a + b, 0);

  const hdrRow = new TableRow({ children: [
    ...headers.map((h, i) => headerCell(h, i === 0 ? nameW : HC_W[i - 1])),
  ]});
  const dataRows = paramRows.length
    ? paramRows.map(row => new TableRow({ children: [
        cell(String(row[0] ?? ""), { width: nameW }),
        ...HC_W.map((w, i) => cell(String(row[i + 1] ?? ""), { width: w })),
      ]}))
    : [new TableRow({ children: colWidths.map(w => cell("", { width: w })) })];

  return new Table({ layout: TableLayoutType.FIXED, width: { size: totalW, type: WidthType.DXA }, columnWidths: colWidths, rows: [hdrRow, ...dataRows] });
}

// ── JSON 코드 블록 ─────────────────────────────────────────────────────────────
function makeJsonBlock(title, jsonStr) {
  const lines = (jsonStr || "").split("\n");
  const runs  = lines.flatMap((line, i) => {
    const r = new TextRun({ text: line, font: "Courier New", size: 18, color: BLACK });
    return i < lines.length - 1 ? [r, new TextRun({ break: 1 })] : [r];
  });
  return [
    para(title, { spacing: { before: 60, after: 20 } }),
    new Paragraph({ children: runs, spacing: { before: 40, after: 40 }, indent: { left: 360 } }),
  ];
}

// ── API 기본 정보 표 ───────────────────────────────────────────────────────────
function makeApiInfoTable(method, uri, desc) {
  const colW = [1200, 4226, 3600];
  const total = colW.reduce((a, b) => a + b, 0);
  return new Table({
    width: { size: total, type: WidthType.DXA }, columnWidths: colW,
    rows: [
      new TableRow({ children: ["Method", "URI", "Description"].map((t, i) => headerCell(t, colW[i])) }),
      new TableRow({ children: [cell(method.toUpperCase(), { width: colW[0] }), cell(uri, { width: colW[1] }), cell(desc, { width: colW[2] })] }),
    ],
  });
}

// ── Response Code 표 ──────────────────────────────────────────────────────────
function getHttpStatusText(code) {
  const map = { "200": "OK", "201": "Created", "204": "No Content", "400": "Bad Request", "401": "Unauthorized", "403": "Forbidden", "404": "Not Found", "500": "Internal Server Error" };
  return map[String(code)] || "";
}

function makeResponseCodeTable(responses) {
  const colW  = [1200, 1800, 4326, 1700];
  const total = colW.reduce((a, b) => a + b, 0);
  const hRow  = new TableRow({
    children: ["상태 코드", "상태 메시지", "설명", "비고"].map((t, i) => headerCell(t, colW[i])),
  });
  const dataRows = Object.entries(responses || {}).map(([code, resp]) =>
    new TableRow({ children: [
      cell(String(code),                         { width: colW[0] }),
      cell(getHttpStatusText(code),              { width: colW[1] }),
      cell(resp.description || "",               { width: colW[2] }),
      cell("",                                   { width: colW[3] }),
    ]})
  );
  if (dataRows.length === 0)
    dataRows.push(new TableRow({ children: colW.map(w => cell("", { width: w })) }));
  return new Table({ layout: TableLayoutType.FIXED, width: { size: total, type: WidthType.DXA }, columnWidths: colW, rows: [hRow, ...dataRows] });
}

// ── 스키마 유틸 ───────────────────────────────────────────────────────────────
// Swagger 2.0: definitions / OpenAPI 3.x: components.schemas 통합
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
  // #/components/schemas/Foo  OR  #/definitions/Foo
  const name = ref.replace(/^#\/(components\/schemas|definitions)\//, "");
  return components?.schemas?.[name] || null;
}

// 요청 바디 스키마 (Swagger 2.0 + OpenAPI 3.x)
function getRequestBodySchema(op) {
  if (op.requestBody?.content?.["application/json"]?.schema)
    return op.requestBody.content["application/json"].schema;
  const bodyParam = (op.parameters || []).find(p => p.in === "body");
  return bodyParam?.schema || null;
}

// 응답 바디 스키마 (Swagger 2.0 + OpenAPI 3.x)
function getResponseSchema(op) {
  // OpenAPI 3.x
  for (const code of ["200", "201"]) {
    const s = op.responses?.[code]?.content?.["application/json"]?.schema;
    if (s) return s;
  }
  // Swagger 2.0
  for (const code of ["200", "201"]) {
    const s = op.responses?.[code]?.schema;
    if (s) return s;
  }
  return null;
}

function getSchemaType(schema, components) {
  if (!schema) return "Object";
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, components);
    return resolved ? getSchemaType(resolved, components) : schema.$ref.split("/").pop();
  }
  if (schema.type === "array") {
    return `Array<${schema.items ? getSchemaType(schema.items, components) : "Object"}>`;
  }
  return schema.type || "Object";
}

// 스키마 → 표 행 flatten (dot-path 방식)
function flattenSchema(schema, components, prefix = "", requiredList = []) {
  if (!schema) return [];
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, components);
    return resolved ? flattenSchema(resolved, components, prefix, requiredList) : [[prefix || "Object", "Object", "N", "", ""]];
  }
  if (schema.type === "array") {
    const itemSchema = schema.items || {};
    const resolvedItem = itemSchema.$ref ? resolveRef(itemSchema.$ref, components) : itemSchema;
    const fieldName   = prefix ? `${prefix}[]` : "[]";
    const rows = [[fieldName, `Array<${resolvedItem?.title || "Object"}>`, "N", schema.description || "", ""]];
    if (resolvedItem?.properties) {
      for (const [key, val] of Object.entries(resolvedItem.properties)) {
        const isReq = (resolvedItem.required || []).includes(key) ? "Y" : "N";
        rows.push(...flattenSchema(val, components, `${fieldName}.${key}`, resolvedItem.required || []));
        if (rows.length && rows[rows.length - 1][0] === `${fieldName}.${key}`) rows[rows.length - 1][2] = isReq;
      }
    }
    return rows;
  }
  if (schema.type === "object" || schema.properties) {
    const rows = [];
    for (const [key, val] of Object.entries(schema.properties || {})) {
      const fieldName = prefix ? `${prefix}.${key}` : key;
      const isReq     = (schema.required || requiredList || []).includes(key) ? "Y" : "N";
      const type      = getSchemaType(val, components);
      const desc      = val.description || "";
      const extra     = [];
      if (val.maxLength)           extra.push(`maxLength: ${val.maxLength}`);
      if (val.minimum  !== undefined) extra.push(`min: ${val.minimum}`);
      if (val.maximum  !== undefined) extra.push(`max: ${val.maximum}`);
      rows.push([fieldName, type, isReq, desc, extra.join(", ")]);
      if ((val.type === "object" || val.properties) && val.properties)
        rows.push(...flattenSchema(val, components, fieldName, val.required || []));
      else if (val.type === "array")
        rows.push(...flattenSchema(val, components, fieldName, []));
      else if (val.$ref) {
        const resolved = resolveRef(val.$ref, components);
        if (resolved && (resolved.type === "object" || resolved.properties))
          rows.push(...flattenSchema(resolved, components, fieldName, resolved.required || []));
      }
    }
    return rows;
  }
  // primitive
  const extra = [];
  if (schema.maxLength)           extra.push(`maxLength: ${schema.maxLength}`);
  if (schema.minimum !== undefined) extra.push(`min: ${schema.minimum}`);
  if (schema.maximum !== undefined) extra.push(`max: ${schema.maximum}`);
  return [[prefix, schema.type || "Object", requiredList.includes(prefix) ? "Y" : "N", schema.description || "", extra.join(", ")]];
}

// parameter[] → 표 행 (Swagger 2.0: type 직접 / OpenAPI 3.x: schema.type)
function buildParamRows(parameters, inType) {
  return (parameters || [])
    .filter(p => p.in === inType)
    .map(p => {
      const type    = p.schema?.type || p.type || "String";
      const maxLen  = p.schema?.maxLength ?? p.maxLength;
      return [
        p.name || "",
        type,
        p.required ? "Y" : "N",
        p.description || "",
        maxLen != null ? `maxLength: ${maxLen}` : "",
      ];
    });
}

// ── JSON 예시 추출 (Swagger 2.0 + OpenAPI 3.x) ───────────────────────────────
function extractRequestExample(op) {
  // OpenAPI 3.x
  const content = op.requestBody?.content?.["application/json"];
  if (content) {
    if (content.examples) {
      const first = Object.values(content.examples)[0];
      if (first?.value != null) return JSON.stringify(first.value, null, 2);
    }
    if (content.example != null) return JSON.stringify(content.example, null, 2);
  }
  // Swagger 2.0 body parameter example
  const bodyParam = (op.parameters || []).find(p => p.in === "body");
  if (bodyParam?.examples?.["application/json"] != null)
    return JSON.stringify(bodyParam.examples["application/json"], null, 2);
  return null;
}

function extractResponseExample(op) {
  for (const code of ["200", "201"]) {
    const resp = op.responses?.[code];
    if (!resp) continue;
    // OpenAPI 3.x
    const content = resp.content?.["application/json"];
    if (content) {
      if (content.example != null) return JSON.stringify(content.example, null, 2);
      if (content.examples) {
        const first = Object.values(content.examples)[0];
        if (first?.value != null) return JSON.stringify(first.value, null, 2);
      }
    }
    // Swagger 2.0 response examples
    if (resp.examples?.["application/json"] != null)
      return JSON.stringify(resp.examples["application/json"], null, 2);
  }
  return null;
}

// ── Mock 데이터 자동 생성 (예시 없을 때) ──────────────────────────────────────
function generateMock(schema, components, depth = 0) {
  if (depth > 5) return null;
  if (!schema) return "sample";
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, components);
    return resolved ? generateMock(resolved, components, depth + 1) : {};
  }
  if (schema.example !== undefined) return schema.example;
  if (schema.enum)    return schema.enum[0];
  switch (schema.type) {
    case "integer":
    case "number":  return 0;
    case "boolean": return false;
    case "array": {
      const item = schema.items ? generateMock(schema.items, components, depth + 1) : "sample";
      return [item];
    }
    case "object": {
      const obj = {};
      for (const [k, v] of Object.entries(schema.properties || {}))
        obj[k] = generateMock(v, components, depth + 1);
      return obj;
    }
    default: return "sample";
  }
}

function buildMockFromSchema(schema, components) {
  if (!schema) return null;
  try {
    return JSON.stringify(generateMock(schema, components), null, 2);
  } catch { return null; }
}

// ── 표지 ──────────────────────────────────────────────────────────────────────
// md 규칙: 단일 칸 표, 28pt(타이틀) + 20pt(시스템명), 검정 실선 테두리
function buildCoverPage(swagger) {
  const sysTitle = swagger.info?.title?.replace(/^[^\w가-힣]*/, "") || "API";
  const version  = swagger.info?.version || "v1.0";
  const today    = new Date().toISOString().slice(0, 10);

  // 단일 칸 표 (제목 박스)
  const titleTable = new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [CONTENT_W],
    rows: [new TableRow({
      children: [new TableCell({
        borders:  mkAllBorders(),
        margins:  { top: 400, bottom: 400, left: 600, right: 600 },
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing:   { before: 200, after: 160 },
            children:  [new TextRun({ text: "시스템 인터페이스 정의서", font: FONT, bold: true, size: 56, color: BLACK })],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing:   { before: 160, after: 200 },
            children:  [new TextRun({ text: sysTitle, font: FONT, bold: true, size: 40, color: BLACK })],
          }),
        ],
      })],
    })],
  });

  // 문서 정보 표 (4행)
  const colW = [2200, 6826];
  const infoTable = new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: colW,
    rows: [
      new TableRow({ children: [headerCell("문서 번호", colW[0]), cell("",      { width: colW[1] })] }),
      new TableRow({ children: [headerCell("문서 버전", colW[0]), cell(version, { width: colW[1] })] }),
      new TableRow({ children: [headerCell("작성 일자", colW[0]), cell(today,   { width: colW[1] })] }),
      new TableRow({ children: [headerCell("작성자",   colW[0]), cell(swagger.info?.contact?.name || "", { width: colW[1] })] }),
    ],
  });

  return [
    para(""), para(""), para(""), para(""), para(""), para(""),
    titleTable,
    para(""), para(""),
    infoTable,
    new Paragraph({ children: [new PageBreak()] }),
  ];
}

// ── 승인이력 / 개정이력 ───────────────────────────────────────────────────────
// 이력 섹션 제목: Heading 미적용(목차 제외), 중앙 정렬 굵은 텍스트
function historyTitle(text) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 160, after: 120 },
    children: [new TextRun({ text, font: FONT, bold: true, size: 24, color: BLACK })],
  });
}

function buildApprovalHistory() {
  const colW  = [1800, 2000, 1800, 1800, 1626];
  const total = colW.reduce((a, b) => a + b, 0);
  return [
    historyTitle("승인이력"),
    new Table({
      width: { size: total, type: WidthType.DXA }, columnWidths: colW,
      rows: [
        new TableRow({ children: ["수행역할", "소속", "이름", "날짜", "서명"].map((t, i) => headerCell(t, colW[i])) }),
        new TableRow({ children: colW.map(w => cell("", { width: w })) }),
      ],
    }),
    para(""),
  ];
}

function buildRevisionHistory(swagger) {
  const today   = new Date().toISOString().slice(0, 10);
  const version = swagger.info?.version || "v1.0";
  const colW    = [1500, 4526, 1800, 1200];
  const total   = colW.reduce((a, b) => a + b, 0);
  return [
    historyTitle("개정 이력"),
    new Table({
      width: { size: total, type: WidthType.DXA }, columnWidths: colW,
      rows: [
        new TableRow({ children: ["버전", "변경내용", "날짜", "담당자"].map((t, i) => headerCell(t, colW[i])) }),
        new TableRow({ children: [cell(version, { width: colW[0] }), cell("최초 작성", { width: colW[1] }), cell(today, { width: colW[2] }), cell("", { width: colW[3] })] }),
      ],
    }),
    para(""),
    new Paragraph({ children: [new PageBreak()] }),
  ];
}

// ── 목차 ─────────────────────────────────────────────────────────────────────
// md 규칙: TOC \o "1-2" — Heading 1·2만 수집, Heading 3은 본문에만 노출
function buildTOC() {
  // md 규칙: '목차' 제목에는 Heading 스타일 미적용 → 목차 자체가 TOC에 포함되지 않도록
  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 160, after: 120 },
      children: [new TextRun({ text: "목차", font: FONT, color: BLACK, bold: true, size: 28 })],
    }),
    new TableOfContents("목차", { hyperlink: true, headingStyleRange: "1-2" }),
    new Paragraph({ children: [new PageBreak()] }),
  ];
}

// ── 섹션 1: 시스템 인터페이스 개요 ────────────────────────────────────────────
// ── 섹션 1: 시스템 인터페이스 개요 ────────────────────────────────────────────
function buildSection1(swagger) {
  const sysTitle = swagger.info?.title?.replace(/^[^\w가-힣]*/, "") || "API";
  const desc     = (swagger.info?.description || "")
    .replace(/<[^>]*>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
  return [
    heading1("1. 시스템 인터페이스 개요"),
    heading2("1.1. 개요"),
    para(`본 문서는 ${sysTitle}의 API Communication을 기술한 문서이다.`),
    para(`본 문서를 기준으로 ${sysTitle} 구성을 위한 데이터 연동을 진행한다.`),
    ...(desc ? [para(desc)] : []),
    para(""),
  ];
}

// ── 섹션 2: 시스템 인터페이스 연동 방법 ────────────────────────────────────────
function buildSection2(swagger) {
  const servers   = swagger.servers || [];
  const svrColW   = [3500, 5526];
  const svrTotal  = svrColW.reduce((a, b) => a + b, 0);
  const svrRows   = servers.length > 0
    ? servers.map(s => new TableRow({ children: [cell(s.url || "", { width: svrColW[0] }), cell(s.description || "", { width: svrColW[1] })] }))
    : [new TableRow({ children: svrColW.map(w => cell("", { width: w })) })];

  const reqColW  = [2200, 2000, 1500, 3326];
  const reqTotal = reqColW.reduce((a, b) => a + b, 0);

  return [
    heading1("2. 시스템 인터페이스 연동 방법"),
    heading2("2.1. 서버정보"),
    new Table({
      width: { size: svrTotal, type: WidthType.DXA }, columnWidths: svrColW,
      rows: [
        new TableRow({ children: ["URL", "설명"].map((t, i) => headerCell(t, svrColW[i])) }),
        ...svrRows,
      ],
    }),
    para(""),
    heading2("2.2. REQUEST 정보"),
    new Table({
      width: { size: reqTotal, type: WidthType.DXA }, columnWidths: reqColW,
      rows: [
        new TableRow({ children: ["항목", "값", "필수여부", "설명"].map((t, i) => headerCell(t, reqColW[i])) }),
        new TableRow({ children: reqColW.map(w => cell("", { width: w })) }),
      ],
    }),
    para(""),
  ];
}

// ── 섹션 3: 시스템 인터페이스 정보 ─────────────────────────────────────────────
function buildSection3(swagger, idPrefix) {
  const paths     = swagger.paths || {};
  const ID_PREFIX = idPrefix || "INF";

  // 3.1 기본정보
  const infoColW  = [2200, 6826];
  const infoTotal = infoColW.reduce((a, b) => a + b, 0);
  const infoTable = new Table({
    width: { size: infoTotal, type: WidthType.DXA }, columnWidths: infoColW,
    rows: [
      new TableRow({ children: ["항목", "내용"].map((t, i) => headerCell(t, infoColW[i])) }),
      new TableRow({ children: [cell("시스템명", { width: infoColW[0] }), cell(swagger.info?.title || "", { width: infoColW[1] })] }),
      new TableRow({ children: [cell("버전", { width: infoColW[0] }), cell(swagger.info?.version || "", { width: infoColW[1] })] }),
      new TableRow({ children: [cell("설명", { width: infoColW[0] }), cell((swagger.info?.description || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(), { width: infoColW[1] })] }),
    ],
  });

  // 3.2 인터페이스 정보 목록
  const listColW  = [1500, 1200, 3500, 2826];
  const listTotal = listColW.reduce((a, b) => a + b, 0);
  const tagOrder  = [];
  const tagMap    = {};
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (typeof op !== "object" || Array.isArray(op)) continue;
      const tag = (op.tags || ["기타"])[0];
      if (!tagMap[tag]) { tagMap[tag] = []; tagOrder.push(tag); }
      tagMap[tag].push({ path, method, op });
    }
  }
  let listIdx  = 1;
  const listRows = [];
  for (const tag of tagOrder) {
    for (const { path, method, op } of tagMap[tag]) {
      const infId = `${ID_PREFIX}-${String(listIdx).padStart(3, "0")}`;
      listRows.push(new TableRow({ children: [
        cell(infId,                { width: listColW[0] }),
        cell(method.toUpperCase(), { width: listColW[1] }),
        cell(op.summary || "",     { width: listColW[2] }),
        cell(path,                 { width: listColW[3] }),
      ]}));
      listIdx++;
    }
  }
  const listTable = new Table({
    width: { size: listTotal, type: WidthType.DXA }, columnWidths: listColW,
    rows: [
      new TableRow({ children: ["인터페이스 ID", "Method", "설명", "URI"].map((t, i) => headerCell(t, listColW[i])) }),
      ...(listRows.length > 0 ? listRows : [new TableRow({ children: listColW.map(w => cell("", { width: w })) })]),
    ],
  });

  return [
    heading1("3. 시스템 인터페이스 정보"),
    heading2("3.1. 기본정보"),
    infoTable,
    para(""),
    heading2("3.2. 인터페이스 정보 목록"),
    para("문서 목차로 대체합니다."),
    para(""),
  ];
}

// ── 섹션 3: 시스템 인터페이스 명세서 (API 상세) ───────────────────────────────
// md 규칙:
//   - API 기본 정보는 항상 1번 고정
//   - Request 타입별 개별 Heading3 (Path / Query / Body)
//   - 데이터 없어도 모든 섹션 항상 생성 (빈 표 포함)
//   - JSON 예시는 항상 생성 (Mock 자동 생성)
function buildSection4(swagger, idPrefix) {
  const N          = 4;
  const ID_PREFIX  = idPrefix || "INF";
  const components = getComponents(swagger);
  const paths      = swagger.paths || {};

  const elems = [heading1(`${N}. 시스템 인터페이스 명세서`)];

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

  const PARAM_HDRS = ["Name", "Type", "Required", "Description", "비고"];

  let idx = 1;
  for (const tag of tagOrder) {
    for (const { path, method, op } of tagMap[tag]) {
      const infId   = `${ID_PREFIX}-${String(idx).padStart(3, "0")}`;
      const summary = op.summary || `${method.toUpperCase()} ${path}`;

      elems.push(heading2(`${N}.${idx}. ${summary} (${infId})`));

      let sub = 1; // 동적 소제목 번호

      // ── API 기본 정보 (항상 1번) ─────────────────────────────────────────
      elems.push(heading3(`${N}.${idx}.${sub++}. API 기본 정보`));
      elems.push(makeApiInfoTable(method, path, summary));
      elems.push(para(""));

      const pathParams  = buildParamRows(op.parameters, "path");
      const queryParams = buildParamRows(op.parameters, "query");
      const bodySchema  = getRequestBodySchema(op);
      const respSchema  = getResponseSchema(op);

      // ── Request - Path Parameters (항상 생성) ────────────────────────────
      elems.push(heading3(`${N}.${idx}.${sub++}. Request - Path Parameters`));
      elems.push(makeParamHierTable(PARAM_HDRS, pathParams));
      elems.push(para(""));

      // ── Request - Query Parameters (항상 생성) ───────────────────────────
      elems.push(heading3(`${N}.${idx}.${sub++}. Request - Query Parameters`));
      elems.push(makeParamHierTable(PARAM_HDRS, queryParams));
      elems.push(para(""));

      // ── Request - Body (항상 생성) ────────────────────────────────────────
      elems.push(heading3(`${N}.${idx}.${sub++}. Request - Body`));
      elems.push(makeHierTable(PARAM_HDRS, bodySchema, components));
      elems.push(para(""));

      // ── Response - Body (항상 생성) ───────────────────────────────────────
      elems.push(heading3(`${N}.${idx}.${sub++}. Response - Body`));
      elems.push(makeHierTable(["Name", "Type", "Nullable", "Description", "비고"], respSchema, components));
      elems.push(para(""));

      // ── JSON 예시 (항상 생성) ────────────────────────────────────────────
      elems.push(heading3(`${N}.${idx}.${sub++}. JSON 예시`));
      const reqEx = extractRequestExample(op)
                 || (bodySchema ? buildMockFromSchema(bodySchema, components) : null);
      const resEx = extractResponseExample(op)
                 || (respSchema ? buildMockFromSchema(respSchema, components) : null)
                 || '{\n  "code": 200,\n  "message": "success"\n}';
      if (reqEx) elems.push(...makeJsonBlock("[ Request ]", reqEx));
      elems.push(...makeJsonBlock("[ Response ]", resEx));
      elems.push(para(""));

      idx++;
    }
  }

  return elems;
}

// ── 문서 조립 ─────────────────────────────────────────────────────────────────
function buildDocument(swagger, idPrefix) {
  // md 규칙: Heading 스타일 재정의 — 파란색 제거, 맑은 고딕, 검정색 강제
  return new Document({
    styles: {
      default: {
        document: { run: { font: FONT, size: 20, color: BLACK } },
      },
      paragraphStyles: [
        {
          id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 28, bold: true, font: FONT, color: BLACK },
          paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 0 },
        },
        {
          id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 24, bold: true, font: FONT, color: BLACK },
          paragraph: { spacing: { before: 200, after: 100 }, outlineLevel: 1 },
        },
        {
          id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 22, bold: true, font: FONT, color: BLACK },
          paragraph: { spacing: { before: 160, after: 80 }, outlineLevel: 2 },
        },
      ],
    },
    sections: [{
      properties: {
        page: {
          size:   { width: PAGE_W, height: PAGE_H },
          margin: {
            top:    MARGIN,
            bottom: MARGIN,
            left:   MARGIN,
            right:  MARGIN,
          },
        },
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children:  [new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 18, color: BLACK })],
          })],
        }),
      },
      children: [
        ...buildCoverPage(swagger),
        ...buildApprovalHistory(),
        ...buildRevisionHistory(swagger),
        ...buildTOC(),
        ...buildSection1(swagger),
        ...buildSection2(swagger),
        ...buildSection3(swagger, idPrefix),
        ...buildSection4(swagger, idPrefix),
      ],
    }],
  });
}

module.exports = async function generateFromSwagger(swaggerJson, templateProfile, idPrefix) {
  applyProfile(templateProfile || null);
  const swagger = typeof swaggerJson === "string" ? JSON.parse(swaggerJson) : swaggerJson;
  const doc     = buildDocument(swagger, idPrefix || null);
  return await Packer.toBuffer(doc);
};
