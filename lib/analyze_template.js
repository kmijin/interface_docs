"use strict";

/**
 * .docx 템플릿을 분석해서 문서 구조/스타일 프로파일을 추출합니다.
 * 반환값(templateProfile)은 generate_from_swagger.js에서 사용됩니다.
 */

const JSZip = require("jszip");

// ── XML 파싱 유틸 ──────────────────────────────────────────────────────────────
function attr(el, ns, name) {
  // el이 문자열이면 정규식으로 속성 추출
  const full = `${ns}:${name}`;
  const re = new RegExp(`${full.replace(":", "\\:")}="([^"]*)"`, "g");
  const m = re.exec(el);
  return m ? m[1] : null;
}

function allText(xml) {
  return xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function extractAttr(tag, attrName) {
  const re = new RegExp(`${attrName}="([^"]*)"`, "i");
  const m = re.exec(tag);
  return m ? m[1] : null;
}

// ── styles.xml 파싱 ────────────────────────────────────────────────────────────
function parseStyles(stylesXml) {
  const styles = {};

  // 헤딩 스타일 추출 (Heading 1~3)
  const styleRe = /<w:style[^>]*w:styleId="([^"]*)"[^>]*>([\s\S]*?)<\/w:style>/g;
  let m;
  while ((m = styleRe.exec(stylesXml)) !== null) {
    const id = m[1];
    const body = m[2];
    if (!id.match(/Heading[123]|heading[123]|제목[123]/i)) continue;

    const sizeM = /<w:sz w:val="(\d+)"/.exec(body);
    const colorM = /<w:color w:val="([0-9A-Fa-f]{6})"/.exec(body);
    const boldM = /<w:b\/>|<w:b w:val="true"/.exec(body);
    const fontM = /<w:rFonts[^>]*w:ascii="([^"]*)"/.exec(body);
    const beforeM = /<w:before w:val="(\d+)"/.exec(body);
    const afterM = /<w:after w:val="(\d+)"/.exec(body);

    styles[id] = {
      size: sizeM ? parseInt(sizeM[1]) : null,
      color: colorM ? colorM[1] : null,
      bold: !!boldM,
      font: fontM ? fontM[1] : null,
      spaceBefore: beforeM ? parseInt(beforeM[1]) : null,
      spaceAfter: afterM ? parseInt(afterM[1]) : null,
    };
  }

  // 기본 폰트
  const defFontM = /<w:docDefaults>[\s\S]*?w:ascii="([^"]*)"/.exec(stylesXml);
  const defFont = defFontM ? defFontM[1] : "맑은 고딕";

  // Normal 스타일의 기본 색상
  const normalStyleM = /<w:style[^>]*w:styleId="Normal"[^>]*>([\s\S]*?)<\/w:style>/.exec(stylesXml);
  const defColorM = normalStyleM ? /<w:color w:val="([0-9A-Fa-f]{6})"/.exec(normalStyleM[1]) : null;
  const defColor = defColorM ? defColorM[1] : "000000";

  return { headings: styles, defaultFont: defFont, defaultColor: defColor };
}

// ── document.xml 파싱 ─────────────────────────────────────────────────────────
function parseDocument(docXml) {
  const sections = [];
  const tableColors = new Set();
  const fonts = new Set();
  let pageW = null, pageH = null;
  const margins = {};

  // 페이지 크기/여백
  const pgSzM = /<w:pgSz[^>]*>/.exec(docXml);
  if (pgSzM) {
    const wM = /w:w="(\d+)"/.exec(pgSzM[0]);
    const hM = /w:h="(\d+)"/.exec(pgSzM[0]);
    if (wM) pageW = parseInt(wM[1]);
    if (hM) pageH = parseInt(hM[1]);
  }
  const pgMar = /<w:pgMar[^>]*>/.exec(docXml);
  if (pgMar) {
    const tm = /w:top="(\d+)"/.exec(pgMar[0]);
    const bm = /w:bottom="(\d+)"/.exec(pgMar[0]);
    const lm = /w:left="(\d+)"/.exec(pgMar[0]);
    const rm = /w:right="(\d+)"/.exec(pgMar[0]);
    if (tm) margins.top = parseInt(tm[1]);
    if (bm) margins.bottom = parseInt(bm[1]);
    if (lm) margins.left = parseInt(lm[1]);
    if (rm) margins.right = parseInt(rm[1]);
  }

  // 제목/헤딩 단락 추출
  const paraRe = /<w:p[ >]([\s\S]*?)<\/w:p>/g;
  let pm;
  while ((pm = paraRe.exec(docXml)) !== null) {
    const pBody = pm[1];
    const styleM = /<w:pStyle w:val="([^"]*)"/.exec(pBody);
    const style = styleM ? styleM[1] : "Normal";
    const text = allText(pBody).replace(/\s+/g, " ").trim();
    if (!text) continue;

    if (style.match(/Heading|heading|제목/i)) {
      const levelM = style.match(/(\d)$/);
      sections.push({
        level: levelM ? parseInt(levelM[1]) : 1,
        text,
        style,
      });
    }

    // 폰트 수집
    const fontM = /w:ascii="([^"]*)"/.exec(pBody);
    if (fontM) fonts.add(fontM[1]);
  }

  // 표 셀 배경색 수집 (헤더 회색 등)
  const shadingRe = /w:fill="([0-9A-Fa-f]{6})"/g;
  let sm;
  while ((sm = shadingRe.exec(docXml)) !== null) {
    const c = sm[1].toUpperCase();
    if (c !== "FFFFFF" && c !== "AUTO") tableColors.add(c);
  }

  // 표 테두리 색 수집
  const borderColorRe = /<w:(?:top|bottom|left|right|insideH|insideV)[^>]*w:color="([0-9A-Fa-f]{6})"/g;
  const borderColors = new Set();
  let bc;
  while ((bc = borderColorRe.exec(docXml)) !== null) {
    borderColors.add(bc[1].toUpperCase());
  }

  // 텍스트박스 내 제목 텍스트 추출 (표지 제목 등)
  const txbxRe = /<w:txbxContent>([\s\S]*?)<\/w:txbxContent>/g;
  const coverTexts = [];
  let txm;
  while ((txm = txbxRe.exec(docXml)) !== null) {
    const t = allText(txm[1]).trim();
    if (t) coverTexts.push(t);
  }

  return {
    sections,
    tableColors: [...tableColors],
    borderColors: [...borderColors],
    coverTexts,
    fonts: [...fonts],
    pageLayout: { width: pageW, height: pageH, margins },
  };
}

// ── 표 구조 분석 ──────────────────────────────────────────────────────────────
function analyzeTables(docXml) {
  const tables = [];
  const tableRe = /<w:tbl>([\s\S]*?)<\/w:tbl>/g;
  let tm;
  while ((tm = tableRe.exec(docXml)) !== null) {
    const tBody = tm[1];

    // 컬럼 수
    const colRe = /<w:gridCol/g;
    const cols = (tBody.match(colRe) || []).length;

    // 컬럼 너비
    const colWidths = [];
    const cwRe = /<w:gridCol[^>]*w:w="(\d+)"/g;
    let cw;
    while ((cw = cwRe.exec(tBody)) !== null) colWidths.push(parseInt(cw[1]));

    // 헤더 배경색
    const firstRowM = /<w:tr>([\s\S]*?)<\/w:tr>/.exec(tBody);
    const headerBg = firstRowM ? (/<w:fill="([0-9A-Fa-f]{6})"/.exec(firstRowM[1]) || [])[1] : null;

    // 헤더 셀 텍스트
    const headerTexts = [];
    if (firstRowM) {
      const cellRe = /<w:tc>([\s\S]*?)<\/w:tc>/g;
      let cellM;
      while ((cellM = cellRe.exec(firstRowM[1])) !== null) {
        headerTexts.push(allText(cellM[1]).trim());
      }
    }

    tables.push({ cols, colWidths, headerBg, headerTexts });
  }
  return tables;
}

// ── 섹션 구조 추론 ────────────────────────────────────────────────────────────
function inferSectionStructure(sections) {
  // 섹션 타입 매핑
  const TYPE_MAP = [
    { pattern: /승인\s*이력/, type: "approval_history" },
    { pattern: /개정\s*이력/, type: "revision_history" },
    { pattern: /목\s*차/, type: "toc" },
    { pattern: /개요|overview/i, type: "overview" },
    { pattern: /연동\s*방법|연동방법|인터페이스\s*방법/, type: "connection_method" },
    { pattern: /인터페이스\s*정보|인터페이스정보/, type: "interface_info" },
    { pattern: /인터페이스\s*상세|상세|detail/i, type: "interface_detail" },
    { pattern: /서버\s*정보|server/i, type: "server_info" },
    { pattern: /기본\s*정보|기본정보/, type: "basic_info" },
  ];

  return sections.map(sec => {
    let type = "unknown";
    for (const { pattern, type: t } of TYPE_MAP) {
      if (pattern.test(sec.text)) { type = t; break; }
    }
    return { ...sec, type };
  });
}

// ── 메인 분석 함수 ────────────────────────────────────────────────────────────
async function analyzeTemplate(buffer) {
  const zip = await JSZip.loadAsync(buffer);

  // 필수 파일 읽기
  const docXmlFile = zip.file("word/document.xml");
  const stylesXmlFile = zip.file("word/styles.xml");

  if (!docXmlFile) throw new Error("word/document.xml을 찾을 수 없습니다.");

  const docXml = await docXmlFile.async("string");
  const stylesXml = stylesXmlFile ? await stylesXmlFile.async("string") : "";

  // 분석
  const docInfo = parseDocument(docXml);
  const styleInfo = parseStyles(stylesXml);
  const tables = analyzeTables(docXml);
  const structuredSections = inferSectionStructure(docInfo.sections);

  // 지배적인 폰트 결정
  const fontCounts = {};
  [...docInfo.fonts, styleInfo.defaultFont].forEach(f => { if (f) fontCounts[f] = (fontCounts[f] || 0) + 1; });
  const dominantFont = Object.entries(fontCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "맑은 고딕";

  // 헤더 셀 배경색 (가장 많이 쓰인 것)
  const bgColorCounts = {};
  docInfo.tableColors.forEach(c => { bgColorCounts[c] = (bgColorCounts[c] || 0) + 1; });
  tables.forEach(t => { if (t.headerBg) bgColorCounts[t.headerBg] = (bgColorCounts[t.headerBg] || 0) + 1; });
  const headerBgColor = Object.entries(bgColorCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "D9D9D9";

  // 테두리 색상
  const borderColor = docInfo.borderColors.find(c => c !== "FFFFFF") || "000000";

  // 헤딩 스타일 추출
  const headingStyles = {};
  for (const [id, s] of Object.entries(styleInfo.headings)) {
    const levelM = id.match(/(\d)$/);
    if (levelM) headingStyles[`h${levelM[1]}`] = s;
  }

  // 표 구조 요약 (API 상세 표 탐지: 5열 표 찾기)
  const apiDetailTable = tables.find(t => t.cols === 5) || null;
  const apiInfoTable = tables.find(t => t.cols >= 3 && t.cols <= 4 &&
    t.headerTexts.some(h => /method|uri|desc/i.test(h))) || null;

  // 페이지 레이아웃
  const layout = {
    pageWidth: docInfo.pageLayout.width || 11906,
    pageHeight: docInfo.pageLayout.height || 16838,
    margins: {
      top: docInfo.pageLayout.margins?.top || 1440,
      bottom: docInfo.pageLayout.margins?.bottom || 1440,
      left: docInfo.pageLayout.margins?.left || 1440,
      right: docInfo.pageLayout.margins?.right || 1440,
    },
  };

  // 표지 정보
  const coverInfo = {
    texts: docInfo.coverTexts,
    infoTableFields: [], // 표지 정보 표의 행 레이블
  };
  // 표지 정보 표 추출 (2열 표이면서 첫 열이 레이블인 경우)
  const infoTable = tables.find(t => t.cols === 2 && t.headerTexts.some(h => /문서|번호|버전|작성/.test(h)));
  if (infoTable) coverInfo.infoTableFields = infoTable.headerTexts;

  return {
    font: dominantFont,
    colors: {
      headerBg: headerBgColor,
      border: borderColor,
      text: styleInfo.defaultColor,
    },
    headingStyles,
    layout,
    sections: structuredSections,
    tables: {
      apiDetailHeaders: apiDetailTable?.headerTexts || [],
      apiInfoHeaders: apiInfoTable?.headerTexts || [],
      allTables: tables.map(t => ({ cols: t.cols, headers: t.headerTexts })),
    },
    cover: coverInfo,
    raw: {
      sectionCount: structuredSections.length,
      tableCount: tables.length,
      detectedSectionTypes: [...new Set(structuredSections.map(s => s.type).filter(t => t !== "unknown"))],
    },
  };
}

module.exports = { analyzeTemplate };
