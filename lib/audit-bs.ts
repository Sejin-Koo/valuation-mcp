/**
 * 감사보고서(·사업보고서 첨부 감사보고서) 원문 HTML 표에서 재무상태표를 읽는다.
 *
 * 왜(2026-11-05 사용자 결정): 감사보고서만 내는 비상장 외감법인은 OpenDART 정형 재무제표(fnlttSinglAcntAll)가 없어
 * 외부 valuation_get_data·자체 dart_interest_bearing_debt 모두 이자부부채를 내지 못했다.
 *
 * 결과 행은 정형 재무제표 행과 같은 모양(account_id·account_nm·amount)으로 돌려준다. 구역 머리 행(유동부채 등)에는
 * 정형 재무제표의 IFRS 태그를 붙여 debt.ts 의 parseBs 를 그대로 쓴다 — 분류 규칙을 한 곳에만 둔다.
 */

export interface HtmlBsRow { account_id: string; account_nm: string; amount: number | null; raw?: string }
export interface HtmlBs { rows: HtmlBsRow[]; unit: number; unitLabel: string; title: string; amountCols: number; warnings: string[] }

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return ENT[e.toLowerCase()] ?? m;
  });
}
const cellText = (s: string) => decode(s.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "")).replace(/[ 　]/g, " ").replace(/\s+/g, " ").trim();

/** 표 하나를 칸 격자로 펼친다(colspan·rowspan 반영). 머리 행 수도 함께. */
export function tableGrid(tbl: string): { rows: string[][]; headRows: number } {
  const trs = Array.from(tbl.matchAll(/<TR\b[^>]*>([\s\S]*?)<\/TR>/gi), m => ({ body: m[1], idx: m.index ?? 0 }));
  const theadEnd = (() => { const m = tbl.match(/<\/THEAD>/i); return m ? (m.index ?? 0) : -1; })();
  const grid: string[][] = [];
  const pending: Map<number, { text: string; left: number }> = new Map(); // rowspan 이월
  let headRows = 0;
  trs.forEach((tr, r) => {
    if (theadEnd >= 0 && tr.idx < theadEnd) headRows = r + 1;
    const row: string[] = [];
    let c = 0;
    const take = () => { while (pending.has(c)) { const p = pending.get(c)!; row[c] = p.text; if (--p.left <= 0) pending.delete(c); c++; } };
    for (const m of tr.body.matchAll(/<(TD|TH|TE|TU)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
      take();
      const attrs = m[2];
      const cs = Number((attrs.match(/COLSPAN="?(\d+)/i) ?? [])[1] ?? 1);
      const rs = Number((attrs.match(/ROWSPAN="?(\d+)/i) ?? [])[1] ?? 1);
      const t = cellText(m[3]);
      for (let k = 0; k < cs; k++) {
        row[c + k] = k === 0 ? t : "";
        if (rs > 1) pending.set(c + k, { text: k === 0 ? t : "", left: rs - 1 });
      }
      c += cs;
    }
    take();
    grid.push(row.map(x => x ?? ""));
  });
  return { rows: grid, headRows };
}

const norm = (s: string) => s.replace(/\s/g, "");
/** 계정명 앞 번호(Ⅰ. 1. (1) 가. ① 등)와 공백을 뗀다 */
export function cleanName(s: string): string {
  let t = s.replace(/[ 　]/g, " ").trim();
  for (let i = 0; i < 3; i++) {
    t = t.replace(/^([ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ]+|[IVXivxl]+(?=\s*[.．])|\d{1,2}|[가나다라마바사아자차카타파하]|[A-Za-z])\s*[.．)]\s*/, "")
      .replace(/^\(\s*(\d{1,2}|[가나다라마바사아자차카타파하]|[A-Za-z])\s*\)\s*/, "")
      .replace(/^[①-⑳㉠-㉭㈀-㈍]\s*/, "")
      .trim();
  }
  // 글자마다 띄운 이름(예: '단 기 차 입 금(주석6)')은 붙인다
  const m = t.match(/^([^(]*?)(\s*\(.*)?$/);
  if (m && /^(\S\s+){2,}\S$/.test(m[1].trim())) t = m[1].replace(/\s+/g, "") + (m[2] ?? "").trim();
  return t;
}
/** 구역 판정·분류용: 공백과 끝의 주석 번호 표기 '(주석 3,4)' '(주5)' 를 뗀다 */
export const keyName = (s: string) => s.replace(/\s/g, "").replace(/\((주석?|註|Note)[^)]*\)+$/i, "");

/** "1,234" "(1,234)" "△1,234" "-1,234" "-" → 숫자. 숫자가 아니면 null */
export function parseAmount(s: string): number | null {
  let t = s.replace(/\s/g, "");
  if (!t) return null;
  if (/^[-–—]+$/.test(t)) return 0;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (/^[△▲-]/.test(t)) { neg = true; t = t.slice(1); }
  if (!/^\d{1,3}(,\d{3})*(\.\d+)?$|^\d+(\.\d+)?$/.test(t)) return null;
  const v = Number(t.replace(/,/g, ""));
  return Number.isFinite(v) ? (neg ? -v : v) : null;
}

const UNIT: [RegExp, number, string][] = [
  [/억\s*원/, 1e8, "억원"], [/백만\s*원/, 1e6, "백만원"], [/천\s*원/, 1e3, "천원"], [/원/, 1, "원"],
];
function findUnit(text: string): { unit: number; label: string } | null {
  const m = text.match(/\(\s*단\s*위\s*[:：]?\s*([^)]*)\)/) ?? text.match(/단\s*위\s*[:：]\s*([^\s,)]+\s*[^\s,)]*)/);
  if (!m) return null;
  for (const [re, u, l] of UNIT) if (re.test(m[1])) return { unit: u, label: l };
  return null;
}

// 구역 머리 행 → 정형 재무제표의 구역 태그(parseBs 의 MARK 와 같은 이름)
const SECTION: [RegExp, string][] = [
  [/^(유동부채|유동부채합계|유동부채총계)$/, "ifrs-full_CurrentLiabilities"],
  [/^(비유동부채|고정부채|장기부채|비유동부채합계|고정부채합계)$/, "ifrs-full_NoncurrentLiabilities"],
  [/^(부채)$/, "ifrs-full_Liabilities"],
  [/^(부채총계|부채합계|부채계)$/, "ifrs-full_Liabilities"],
  [/^(자본|자본총계|자본합계|자본계|자본과부채총계|부채와자본총계|부채및자본총계|자본및부채총계)$/, "ifrs-full_Equity"],
  [/^(자산|자산총계|자산합계|유동자산|비유동자산|고정자산)$/, "ifrs-full_Assets"],
];
// '부채총계' 다음에 오는 행이 유동성 배열의 부채 블록으로 잡히지 않게: parseBs 는 Liabilities 를 'unclassified' 시작으로 본다.
// 합계 행은 구역을 닫는 것이므로 별도 표시로 바꾼다.
const CLOSE = /^(부채총계|부채합계|부채계|유동부채합계|유동부채총계|비유동부채합계|고정부채합계)$/;

/** 재무상태표 표 찾기: 행 이름에 부채총계(합계)와 자본(총계)이 함께 있는 첫 표. 앞쪽 제목·단위 표의 글도 함께 본다. */
export function extractBalanceSheet(xml: string): HtmlBs | null {
  const tables = Array.from(xml.matchAll(/<TABLE\b[^>]*>([\s\S]*?)<\/TABLE>/gi), m => ({ html: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
  for (let i = 0; i < tables.length; i++) {
    const { rows, headRows } = tableGrid(tables[i].html);
    const names = rows.map(r => norm(cleanName(r[0] ?? "")));
    const liabTot = names.findIndex(n => /^(부채총계|부채합계)$/.test(n));
    const eqIdx = names.findIndex(n => /^(자본총계|자본합계|부채와자본총계|자본과부채총계|부채및자본총계)$/.test(n));
    if (liabTot < 0 || eqIdx < 0) continue;
    // 제목·단위: 이 표 바로 앞 글(앞 표 2개까지)
    const before = xml.slice(Math.max(0, (tables[i - 2]?.start ?? tables[i].start - 3000)), tables[i].start);
    const ctxText = cellText(before + rows.slice(0, headRows).map(r => r.join(" ")).join(" "));
    const unit = findUnit(ctxText) ?? findUnit(cellText(rows.slice(0, 3).map(r => r.join(" ")).join(" ")));
    const title = (ctxText.match(/(연\s*결\s*)?(재\s*무\s*상\s*태\s*표|대\s*차\s*대\s*조\s*표)/) ?? [""])[0].replace(/\s/g, "");
    const warnings: string[] = [];
    // 칸 구성: 머리 행에서 '주석' 칸과 금액 칸을 가린다
    const width = Math.max(...rows.map(r => r.length));
    const head = rows.slice(0, Math.max(headRows, 1));
    const headText = (c: number) => norm(head.map(r => r[c] ?? "").join(" "));
    let noteCol = -1;
    for (let c = 1; c < width; c++) if (/^주석|^주$|^註/.test(headText(c))) { noteCol = c; break; }
    let amountCols = Array.from({ length: width - 1 }, (_, k) => k + 1).filter(c => c !== noteCol);
    // 머리 행이 없거나 '과목' 머리가 표 안에 있으면 숫자가 실제로 들어오는 칸만 남긴다
    const numericCount = (c: number) => rows.filter(r => parseAmount(r[c] ?? "") !== null && (r[c] ?? "").trim() !== "").length;
    amountCols = amountCols.filter(c => numericCount(c) > 0);
    if (noteCol < 0 && amountCols.length % 2 === 1 && amountCols.length >= 3) {
      // 주석 칸 머리를 못 찾았는데 금액 칸이 홀수면 첫 칸이 주석 번호일 가능성 — 값이 작은 정수뿐이면 뺀다
      const c0 = amountCols[0];
      const vals = rows.map(r => parseAmount(r[c0] ?? "")).filter((v): v is number => v !== null);
      if (vals.length && vals.every(v => Number.isInteger(v) && Math.abs(v) < 100)) { amountCols = amountCols.slice(1); warnings.push("주석 번호 칸을 머리 없이 판정"); }
    }
    if (!amountCols.length) continue;
    const curCols = amountCols.slice(0, Math.max(1, Math.floor(amountCols.length / 2)));
    if (amountCols.length === 1) warnings.push("금액 칸이 하나뿐 — 당기 값으로 봄");
    const out: HtmlBsRow[] = [];
    for (let r = headRows; r < rows.length; r++) {
      const row = rows[r];
      const nm = cleanName(row[0] ?? "");
      if (!nm) continue;
      const n = keyName(nm);
      if (/^(과목|계정과목|구분)$/.test(n)) continue;
      let amount: number | null = null; let raw = "";
      for (const c of curCols) { const v = parseAmount(row[c] ?? ""); if (v !== null && (row[c] ?? "").trim() !== "") { amount = v; raw = row[c]; break; } }
      const sec = SECTION.find(([re]) => re.test(n));
      if (sec) {
        // 합계 행은 그 구역을 닫는다 — 다음 구역 머리가 올 때까지 아무 구역도 아님
        out.push({ account_id: CLOSE.test(n) ? "ifrs-full_Equity" : sec[1], account_nm: nm, amount }); // Equity = 구역 없음(parseBs MARK)
        continue;
      }
      out.push({ account_id: "", account_nm: nm.replace(/\s*\((주석?|註|Note)[^)]*\)+\s*$/i, "").trim(), amount: amount === null ? null : amount * (unit?.unit ?? 1), raw });
    }
    if (!unit) warnings.push("단위 표기를 찾지 못해 원으로 봄 — 원문 확인");
    return { rows: out, unit: unit?.unit ?? 1, unitLabel: unit?.label ?? "원(추정)", title, amountCols: amountCols.length, warnings };
  }
  return null;
}
