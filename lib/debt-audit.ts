/**
 * 감사보고서 원문(HTML 표)에서 이자부부채를 낸다 — 분류 규칙은 debt.ts(parseBs·classify)와 같다.
 *
 * 1. 재무상태표 본문(audit-bs.ts) → parseBs
 * 2. 본문에 리스부채 행이 없으면 주석 표에서 유동/비유동 리스부채를 찾는다.
 * 3. 차입금이 '금융부채' 한 줄에 묶여 있으면 주석 표에서 차입금·사채 행을 찾는다.
 * 주석 표는 회사마다 모양이 달라 찾은 표·행을 결과의 notes 에 남겨 원문 확인이 쉽도록 한다.
 */
import { DartError, downloadDocument } from "./dart.js";
import { parseBs, classify, type DebtResult, type DebtLine, type DebtLike, type Section, type DebtCategory } from "./debt.js";
import { extractBalanceSheet, extractStatement, tableGrid, cleanName, parseAmount } from "./audit-bs.js";

export interface AuditDebt {
  total: number; lines: DebtLine[]; debtLike: DebtLike[]; notes: string[]; checks: string[];
  completeness: "full" | "partial"; completenessReason: string | null; unitLabel: string; title: string;
  heldForSale: number | null; financialLike: boolean; noBs?: boolean;
}

const norm = (s: string) => s.replace(/\s/g, "");
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const plain = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&(#\d+|[a-zA-Z]+);/g, (m, e: string) => (e[0] === "#" ? String.fromCodePoint(Number(e.slice(1))) : ENT[e] ?? m)).replace(/\s+/g, " ");
const eok = (v: number) => `${(v / 1e8).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}억`;

function unitBefore(text: string): number | null {
  const all = Array.from(text.matchAll(/단\s*위\s*[:：]?\s*(억\s*원|백만\s*원|천\s*원|원|USD|달러|\$)/g));
  const m = all[all.length - 1];
  if (!m) return null;
  const u = m[1].replace(/\s/g, "");
  return u === "억원" ? 1e8 : u === "백만원" ? 1e6 : u === "천원" ? 1e3 : u === "원" ? 1 : NaN;
}

export interface NoteTable { start: number; rows: string[][]; headRows: number; unit: number | null; context: string; headText: string }

export function noteTables(xml: string, from: number): NoteTable[] {
  const out: NoteTable[] = [];
  const re = /<TABLE\b[^>]*>[\s\S]*?<\/TABLE>/gi;
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const g = tableGrid(m[0]);
    // 바로 앞 글: 앞쪽 큰 표(다른 표의 본문)는 빼고, 단위만 적힌 작은 표는 남긴다
    const raw = xml.slice(Math.max(0, m.index - 4000), m.index).replace(/<TABLE\b[\s\S]*?<\/TABLE>/gi, tb => (tb.length > 1500 ? " " : tb));
    const before = plain(raw);
    const head = g.rows.slice(0, Math.max(1, g.headRows)).map(r => r.join(" ")).join(" ");
    out.push({ start: m.index, rows: g.rows, headRows: g.headRows, unit: unitBefore(before + " " + head) ?? unitBefore(g.rows.slice(0, 2).map(r => r.join(" ")).join(" ")), context: before.slice(-400), headText: norm(head) });
  }
  return out;
}

/** 전기 표(당기 표 다음에 따로 나오는 '전기말' 표)인지: 바로 앞 제목에 전기만 있고 당기가 없거나, 머리에 전기만 있음.
 * '당기말 및 전기말 현재 …' 같은 설명문은 당기 표다(실측: 오버데어코리아 2025). */
export function priorYearTable(t: NoteTable): boolean {
  // '당기말 및 전기말 현재 …' 같은 두 해 설명은 빼고, 바로 앞 글에서 마지막으로 나온 해 표기가 전기면 전기 표
  const c = norm(t.context.slice(-120)).replace(/당(기|분기|반기)말?(및|과|와|,|ㆍ|·)전(기|분기|반기)말?/g, "");
  const lastCur = Math.max(c.lastIndexOf("당기"), c.lastIndexOf("당분기"), c.lastIndexOf("당반기"));
  const lastPrior = Math.max(c.lastIndexOf("전기"), c.lastIndexOf("전분기"), c.lastIndexOf("전반기"));
  if (lastPrior >= 0 && lastPrior > lastCur && lastPrior >= c.length - 40) return true;
  const h = norm(t.headText);
  return !!h && /전기/.test(h) && !/당기/.test(h);
}

/** 머리에서 당기 칸 찾기('당기'·'당기말'·'당분기'·'당반기'·날짜). 못 찾으면 -1 */
function currentCol(t: NoteTable): number {
  const width = Math.max(...t.rows.map(r => r.length));
  const head = t.rows.slice(0, Math.max(1, t.headRows));
  for (let c = 1; c < width; c++) { const h = norm(head.map(r => r[c] ?? "").join("")); if (/당기|당\(?기\)?말|당분기|당반기|^\d{4}[.\-년]\s*\d{1,2}[.\-월]/.test(h) && !/전기/.test(h)) return c; }
  return -1;
}
/** 행의 이름 칸들: 첫 숫자 칸 앞의 글 칸(병합된 묶음 이름 + 세부 이름). 뒤쪽(세부)부터 */
export function labels(row: string[]): { label: string; idx: number }[] {
  const out: { label: string; idx: number }[] = [];
  for (let c = 0; c < row.length; c++) {
    const v = (row[c] ?? "").trim();
    if (!v) continue;
    if (parseAmount(v) !== null) break;
    out.push({ label: cleanName(v).replace(/\s*\(\*\d*\)\s*$/, ""), idx: c });
  }
  return out.reverse();
}
/** 당기 값: 머리에 당기 칸이 있으면 그 칸(0이어도), 없으면 이름 칸 뒤 첫 0 아닌 숫자 */
function firstValue(t: NoteTable, row: string[], from = 1): number | null {
  const cur = currentCol(t);
  if (cur >= from && (row[cur] ?? "").trim()) { const v = parseAmount(row[cur]); if (v !== null) return v; }
  for (let c = from; c < row.length; c++) { if (!(row[c] ?? "").trim()) continue; const v = parseAmount(row[c]); if (v !== null && v !== 0) return v; }
  return null;
}

const LEASE_CUR = /^(유동리스부채|리스부채[(\-]?유동\)?|유동성(장기)?리스부채|단기리스부채|유동성금융리스부채|금융리스부채[(\-]?유동\)?|리스유동부채)$/;
const LEASE_NON = /^(비유동성?(금융)?리스부채|리스부채[(\-]?비유동\)?|장기리스부채|금융리스부채[(\-]?비유동\)?|비유동금융리스부채|리스비유동부채)$/;

type LeaseHit = { cur: number; non: number; total: number; where: string };
const leaseHit = (c: number, n: number, u: number, where: string): LeaseHit => ({ cur: c * u, non: n * u, total: (c + n) * u, where });

/** 주석에서 리스부채(유동·비유동). 확실한 모양부터 전체 표를 차례로 본다(각 모양 안에서는 당기 표가 먼저 나온다).
 * 1. '유동리스부채'·'리스부채(비유동)' 같은 행  2. 유동·비유동 묶음 행 아래 '리스부채' 행  3. '리스부채' 행 + 유동·비유동 칸  4. 리스 표의 '유동'·'비유동' 행 */
export function findLease(tables: NoteTable[], unitDefault: number): LeaseHit | null {
  // 변동표(기초·증가·기말)는 기초 잔액을 집을 수 있어 뺀다(실측: 자람테크놀로지 2025 '재무활동에서 생기는 부채의 변동')
  const usable = tables.filter(t => Number.isFinite(t.unit ?? unitDefault) && !priorYearTable(t) && !/기초|증감|변동|재무활동|현금흐름/.test(norm(t.headText) + norm(t.context.slice(-80))));
  const unit = (t: NoteTable) => t.unit ?? unitDefault;
  for (const t of usable) {
    let cur = 0, non = 0, hit = false; let sec: "c" | "n" | null = null; let last: "c" | "n" | null = null;
    // 머리에 유동·비유동 칸이 있는 표는 아래 칸 방식(3)으로 읽는다
    const hn = norm(t.rows.slice(0, Math.max(1, t.headRows)).map(r => r.join("|")).join("|"));
    const colSplit = /비유동/.test(hn) && /(^|\|)(당기말?)?유동/.test(hn);
    for (const r of t.rows.slice(t.headRows)) {
      const ls = labels(r);
      // 리스부채 바로 다음 '현재가치할인차금'은 그 리스부채의 차감(실측: 티플랙스 2025)
      const prevLast = last; last = null;
      if (prevLast && ls.some(l => /현재가치할인차금/.test(norm(l.label)))) { const v = firstValue(t, r, ls[0].idx + 1); if (v) { const neg = -Math.abs(v); if (prevLast === "c") cur += neg; else non += neg; } continue; }
      if (ls.some(l => /^비유동(부채|금융부채)?$/.test(norm(l.label)))) sec = "n"; else if (ls.some(l => /^유동(부채|금융부채)?$/.test(norm(l.label)))) sec = "c";
      else if (ls.length && r.slice(ls[0].idx + 1).every(c => !(c ?? "").trim())) {
        // 값 없는 묶음 제목 행: '기타비유동채무:'·'장기…' → 비유동, '기타채무:'·'유동…' → 유동(실측: 풍산시스템 2025)
        const g = norm(ls[ls.length - 1].label).replace(/[:：]$/, "");
        if (/비유동|장기/.test(g)) sec = "n"; else if (/유동|단기|^기타채무$|^매입채무및기타채무$/.test(g)) sec = "c";
      }
      for (const { label, idx } of ls) {
        const n = norm(label);
        if (LEASE_CUR.test(n)) { const v = firstValue(t, r, idx + 1); if (v) { cur += v; hit = true; last = "c"; } break; }
        if (LEASE_NON.test(n)) { const v = firstValue(t, r, idx + 1); if (v) { non += v; hit = true; last = "n"; } break; }
        // 같은 표에서 묶음(유동·비유동) 아래 그냥 '리스부채'로 적힌 행(실측: 셀트리온 2025 — 유동은 '유동성리스부채', 비유동은 '리스부채')
        if (sec && !colSplit && /^리스부채$/.test(n)) { const v = firstValue(t, r, idx + 1); if (v) { if (sec === "c") cur += v; else non += v; hit = true; last = sec; } break; }
      }
    }
    if (hit) return leaseHit(cur, non, unit(t), "주석 표의 유동·비유동 리스부채 행");
  }
  for (const t of usable) {
    // 금융부채 범주표처럼 '유동'·'비유동' 묶음 아래 '리스부채' 행(실측: 휴젤·셀트리온 2025)
    if (!/장부금액|당기|\d{4}\.\d{2}|금융부채/.test(norm(t.headText)) || /만기|현금흐름|1년|개월/.test(norm(t.headText) + norm(t.context.slice(-120)))) continue;
    let sec: "c" | "n" | null = null; let c4 = 0, n4 = 0, hit4 = false;
    for (const r of t.rows.slice(t.headRows)) {
      const ls = labels(r).map(l => norm(l.label));
      if (ls.some(l => /^비유동(부채|금융부채)?$|비유동금융부채계?$/.test(l))) sec = "n";
      else if (ls.some(l => /^유동(부채|금융부채)?$|^유동금융부채계?$/.test(l))) sec = "c";
      const lab = labels(r).find(l => /^(리스부채|금융리스부채)$/.test(norm(l.label)));
      if (lab && sec) { const v = firstValue(t, r, lab.idx + 1); if (v) { if (sec === "c") c4 += v; else n4 += v; hit4 = true; } }
    }
    if (hit4) return leaseHit(c4, n4, unit(t), "금융부채 주석 표의 유동·비유동 묶음 아래 리스부채 행");
  }
  for (const t of usable) {
    // '리스부채' 행 + 머리에 유동·비유동 칸(두 줄 머리 '당기말' 아래 '유동·비유동·합계'도 — 앞 묶음 칸)
    const width = Math.max(...t.rows.map(r => r.length));
    const head = t.rows.slice(0, Math.max(1, t.headRows));
    let cc = -1, nc = -1;
    for (let c = 1; c < width; c++) { const h = norm(head.map(r => r[c] ?? "").join("")).replace(/\((주|\*)[^)]*\)/g, ""); if (cc < 0 && /유동(부채)?$/.test(h) && !/비유동(부채)?$/.test(h) && !/전기/.test(h)) cc = c; else if (nc < 0 && /비유동(부채)?$/.test(h) && !/전기/.test(h)) nc = c; }
    if (cc > 0 && nc > 0) for (const r of t.rows.slice(t.headRows)) {
      if (labels(r).some(l => /^(리스부채|금융리스부채)$/.test(norm(l.label)))) {
        const c = parseAmount(r[cc] ?? "") ?? 0, nn = parseAmount(r[nc] ?? "") ?? 0;
        if (c || nn) return leaseHit(c, nn, unit(t), "주석 표의 리스부채 행(유동·비유동 칸)");
      }
    }
  }
  for (const t of usable) {
    // 리스부채 설명 바로 뒤 작은 표의 '유동'·'비유동' 행(묶음 이름 없이 그 두 행만)
    const ctx = norm(t.context.slice(-160) + t.headText);
    if (!/리스부채/.test(ctx) || /만기|할인전|현금흐름|이자비용|변동|증감/.test(ctx)) continue;
    const body = t.rows.slice(t.headRows).filter(r => labels(r).length);
    if (body.length > 4) continue;
    const by = new Map<string, number>();
    for (const r of body) { const ls = labels(r); if (ls.length !== 1) continue; const v = firstValue(t, r, ls[0].idx + 1); const n = norm(ls[0].label); if (v !== null && !by.has(n)) by.set(n, v); }
    if (by.has("유동") && by.has("비유동")) return leaseHit(by.get("유동")!, by.get("비유동")!, unit(t), "리스부채 주석 표의 유동·비유동 행");
  }
  return null;
}

/** 차입금 구성 주석 표에 리스부채가 함께 들어 있으면(본문 차입금 행에 리스 포함) 리스를 따로 더하지 않는다(실측: LG화학·비츠로테크 2025).
 * 판정: 앞 제목에 '차입금'이 있는 표에서 차입 행 + 리스 행의 당기 합이 본문 차입 합과 같고, 차입 행만으로는 다를 때. */
function leaseInsideBorrowings(tables: NoteTable[], bsDebt: number, unitDefault: number): boolean {
  if (!bsDebt) return false;
  const tol = Math.max(1e6, Math.abs(bsDebt) * 0.0005);
  for (const t of tables) {
    const near = norm(t.context.slice(-120));
    if (!/차입금/.test(near) || /변동|증감|재무활동|만기|이자|담보|보증/.test(near.slice(-60))) continue;
    if (priorYearTable(t)) continue;
    const u = t.unit ?? unitDefault;
    let b = 0, l = 0;
    for (const r of t.rows.slice(t.headRows)) {
      const lab = labels(r)[0];
      if (!lab) continue;
      const n = norm(lab.label);
      const isL = LEASE_CUR.test(n) || LEASE_NON.test(n) || /^리스부채$/.test(n);
      const isB = !isL && BORROW_ROW.test(n);
      if (!isL && !isB) continue;
      const v = firstValue(t, r, lab.idx + 1);
      if (!v) continue;
      if (isL) l += v * u; else b += v * u;
    }
    if (l && b && Math.abs(b + l - bsDebt) <= tol && Math.abs(b - bsDebt) > tol) return true;
  }
  return false;
}

/** 주석에서 포괄 금융부채 안의 차입금·사채 행.
 * 후보 표: 행 이름이 차입금·사채 계정인 표(차입금 내역 표, 금융부채 범주표, 유동성위험 만기표, 자본관리 표).
 * 담보·보증·특수관계 거래·이자율·변동·금융비용 표는 뺀다. 차입금 주석 표가 있으면 그것을, 없으면 처음 나온 후보를 쓴다.
 * 첫 숫자 칸(당기말 장부금액)을 읽는다. 실측(2026-11-05): 에이치디현대이앤에프 '장기금융부채' = 유동성위험 표의 장기차입금 장부금액. */
const BORROW_ROW = /^(유동성)?(단기|장기)?(차입금|사채)(및사채)?(\((유동|비유동)\))?$|^총차입금$|^유동성장기(차입금|부채)$|^(유동성)?(전환|신주인수권부|교환)사채$/;
function findBorrow(tables: NoteTable[], unitDefault: number): { lines: DebtLine[]; where: string } | null {
  let fallback: { lines: DebtLine[]; where: string } | null = null;
  for (const t of tables) {
    const u = t.unit ?? unitDefault;
    if (!Number.isFinite(u)) continue;
    const head = norm(t.context.slice(-100));
    const near = head + norm(t.headText);
    if (/특수관계|거래|담보|보증|약정|한도|이자율|변동|증감|민감도|비용|수익|손익|상환계획|연도별|발행조건|전환조건|사업결합|식별가능|취득일|종속기업|관계기업|공동기업|요약재무|매각예정|처분자산/.test(near)) continue;
    if (priorYearTable(t)) continue;
    // 만기별 현금흐름 표는 장부금액 칸이 있을 때만(실측: 셀트리온 2025 — 첫 칸이 '6개월 이하')
    if (/개월|년이하|년초과|년이내|1년|만기/.test(norm(t.headText)) && !/장부금액/.test(norm(t.headText))) continue;
    const got: { name: string; amount: number }[] = [];
    for (const r of t.rows.slice(t.headRows)) {
      const l = labels(r).find(x => BORROW_ROW.test(norm(x.label)));
      if (!l) continue;
      const v = firstValue(t, r, l.idx + 1);
      if (v) got.push({ name: l.label, amount: v * u });
    }
    if (!got.length) continue;
    // 총계와 구성이 함께 있으면 구성만
    const parts = got.filter(g => !/^총차입금$|^차입금및사채$/.test(norm(g.name)));
    const use = parts.length ? parts : got;
    const lines: DebtLine[] = use.map(g => {
      const n = norm(g.name);
      const section: Section = /^(유동|단기)|유동성|\(유동\)/.test(n) ? "current" : /^(비유동|장기)|\(비유동\)/.test(n) ? "nonCurrent" : "unclassified";
      return { section, name: `${g.name}(주석)`, amount: g.amount, category: (classify(g.name, "") ?? "borrowings") as DebtCategory, source: "주석", tag: "" };
    });
    const nearCtx = norm(t.context.slice(-160));
    const dedicated = /차입금|사채/.test(nearCtx) && !/자본관리|자본조달|순부채|부채비율|유동성위험|만기/.test(nearCtx);
    const res = { lines, where: dedicated ? "차입금·사채 주석 표" : "금융부채 주석 표(장부금액)" };
    if (dedicated) return res;
    fallback = fallback ?? res;
  }
  return fallback;
}

/** 포괄 금융부채 행 금액이 차입금·사채 주석 표의 합계와 같으면 그 행 전체가 차입금이다(실측: 사조씨푸드 2025 '단기금융부채' = 단기차입금 표 합계) */
function matchCatchAll(tables: NoteTable[], catchAll: { section: Section; name: string; amount: number }[]): DebtLine[] {
  const out: DebtLine[] = [];
  for (const c of catchAll) {
    for (const t of tables) {
      const u = t.unit;
      if (!u || !Number.isFinite(u)) continue;
      const near = norm(t.context.slice(-160));
      if (!/차입금|사채/.test(near) || /담보|보증|특수관계|자본관리|순차입|만기|이자율/.test(near.slice(-60))) continue;
      const hit = t.rows.slice(t.headRows).some(r => {
        const l = labels(r).find(x => /^(합계|계|소계|총계)$/.test(norm(x.label)));
        if (!l) return false;
        const v = firstValue(t, r, l.idx + 1);
        return v !== null && Math.abs(v * u - c.amount) <= Math.max(u, Math.abs(c.amount) * 0.0005);
      });
      if (hit) { out.push({ section: c.section, name: c.name, amount: c.amount, category: /사채/.test(near) && !/차입금/.test(near) ? "bonds" : "borrowings", source: "본문", tag: "" }); break; }
    }
  }
  return out;
}

/** 감사의견: 감사보고서 앞부분의 의견 단락 제목으로 판정 */
export function auditOpinion(xml: string): "적정" | "한정" | "부적정" | "의견거절" | null {
  const t = plain(xml.slice(0, 60_000)).replace(/\s/g, "");
  if (/의견거절근거|의견을표명하지않습니다/.test(t)) return "의견거절";
  if (/부적정의견근거|부적정의견/.test(t)) return "부적정";
  if (/한정의견근거|한정의견/.test(t)) return "한정";
  if (/감사의견|공정하게표시하고있습니다/.test(t)) return "적정";
  return null;
}

export function debtFromAuditXml(xml: string): AuditDebt {
  const bs = extractBalanceSheet(xml);
  const op = auditOpinion(xml);
  if (!bs) return { total: 0, lines: [], debtLike: [], notes: [], checks: [op && op !== "적정" ? `감사의견 ${op} — 재무제표 표가 없거나 신뢰할 수 없음` : "원문에서 재무상태표 표를 찾지 못함"], completeness: "partial", completenessReason: "재무상태표 미인식", unitLabel: "", title: "", heldForSale: null, financialLike: false, noBs: true };
  const p = parseBs(bs.rows as any, { attachContra: true });
  const notes: string[] = []; const checks: string[] = [...bs.warnings.map(w => `재무상태표 읽기: ${w}`)];
  if (op && op !== "적정") checks.unshift(`감사의견 ${op} — 재무제표 금액을 그대로 믿기 어려움`);
  let completeness: AuditDebt["completeness"] = "full"; let reason: string | null = null;
  const lines = p.lines.map(l => ({ ...l, tag: "" }));
  const needLease = !lines.some(l => l.category === "lease");
  const needBorrow = !lines.some(l => l.category !== "lease") && p.catchAll.length > 0;
  if (needLease || needBorrow) {
    // 주석은 'TITLE 주석' 뒤부터 — 현금흐름표의 '장기차입금의 증가' 같은 행을 집지 않게(실측: 에이치디현대이앤에프 2025)
    const bsAt = Math.max(0, xml.search(/부\s*채\s*총\s*계|부\s*채\s*합\s*계/));
    const noteRe = /<TITLE[^>]*>\s*주\s*석\s*<\/TITLE>/gi; noteRe.lastIndex = bsAt;
    const nm = noteRe.exec(xml);
    const tables = noteTables(xml, nm ? nm.index : bsAt);
    if (needLease && leaseInsideBorrowings(tables, lines.filter(x => x.category !== "lease").reduce((a, x) => a + x.amount, 0), bs.unit)) {
      notes.push("주석 차입금 구성 표에 리스부채가 들어 있어(본문 차입금 행에 포함) 리스부채를 따로 더하지 않음");
    } else if (needLease) {
      const l = findLease(tables, bs.unit);
      if (l && l.total) {
        if (l.cur) lines.push({ section: "current", name: "리스부채(주석)", amount: l.cur, category: "lease", source: "주석", tag: "" });
        if (l.non) lines.push({ section: "nonCurrent", name: "리스부채(주석)", amount: l.non, category: "lease", source: "주석", tag: "" });
        notes.push(`본문에 리스부채 행이 없어 ${l.where}을 넣음`);
      }
    }
    const matched = needBorrow ? matchCatchAll(tables, p.catchAll) : [];
    if (matched.length) {
      lines.push(...matched);
      notes.push(`본문 '${matched.map(m => m.name).join("·")}' 금액이 차입금 주석 표 합계와 같아 전액 차입금으로 봄`);
      // 맞지 않은 포괄 행이 다른 구역에 남으면 그 구역만 주석 차입 행으로 채운다(실측: 비엠티 2025 — 장기금융부채만 표 합계와 일치)
      const rest = p.catchAll.filter(c => !matched.some(m => m.name === c.name && m.amount === c.amount) && !matched.some(m => m.section === c.section));
      if (rest.length) {
        const b = findBorrow(tables, bs.unit);
        const add = (b?.lines ?? []).filter(l => rest.some(r => r.section === l.section));
        if (add.length) { lines.push(...add); notes.push(`본문 '${rest.map(r => r.name).join("·")}' 안의 차입금·사채는 ${b!.where}로 산정`); }
      }
    } else if (needBorrow) {
      const b = findBorrow(tables, bs.unit);
      if (b) { lines.push(...b.lines); notes.push(`본문 '${p.catchAll.map(c => c.name).join("·")}' 안의 차입금·사채를 ${b.where}로 산정`); }
      else { completeness = "partial"; reason = "포괄 금융부채 안의 차입금 미확인"; checks.push(`주석에서 차입금·사채 표를 찾지 못함 — ${p.catchAll.map(c => `${c.name} ${eok(c.amount)}`).join(", ")} 원문 확인`); }
    }
  }
  for (const l of lines) if (l.source === "본문" && /금융부채|채무/.test(norm(l.name))) checks.push(`비차입 부채와 묶인 차입 행 — 전액 포함, 원문 확인: ${l.name} ${eok(l.amount)}`);
  const total = lines.reduce((s, l) => s + l.amount, 0);
  return { total, lines, debtLike: p.debtLike, notes, checks, completeness, completenessReason: reason, unitLabel: bs.unitLabel, title: bs.title, heldForSale: p.heldForSale, financialLike: p.financialLike };
}

// ─── 감사보고서 찾기·조립 ─────────────────────────────────


const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
export interface AuditReport { rcept_no: string; report_nm: string; rcept_dt: string; corp_name: string; consolidated: boolean; periodEnd: string }

/** 기준일(포함)까지 접수된 감사보고서·연결감사보고서. 같은 기간·종류는 마지막 접수판(정정 반영)만. 최신 기간 먼저, 같은 기간은 연결 먼저. */
export async function auditReportsUntil(corp_code: string, until: string): Promise<AuditReport[]> {
  const k = process.env.DART_API_KEY;
  if (!k) throw new DartError("서버 환경변수 DART_API_KEY 가 설정되어 있지 않습니다.", "NO_KEY");
  const y = Number(until.slice(0, 4));
  const out: AuditReport[] = [];
  for (let page = 1; page <= 2; page++) {
    const res = await fetch(`https://opendart.fss.or.kr/api/list.json?crtfc_key=${k}&corp_code=${corp_code}&bgn_de=${y - 2}0101&end_de=${until}&pblntf_ty=F&page_no=${page}&page_count=100`, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new DartError(`DART 공시목록 HTTP ${res.status}`);
    const d: any = await res.json();
    if (d.status === "013") break;
    if (d.status !== "000") throw new DartError(`DART 공시목록 오류 ${d.status}: ${String(d.message ?? "").slice(0, 100)}`, d.status);
    for (const r of d.list as any[]) {
      const m = String(r.report_nm).match(/(연결)?감사보고서\s*\((\d{4})\.(\d{2})\)/);
      if (!m) continue;
      out.push({ rcept_no: r.rcept_no, report_nm: String(r.report_nm).trim(), rcept_dt: r.rcept_dt, corp_name: r.corp_name, consolidated: !!m[1], periodEnd: m[2] + m[3] });
    }
    if (Number(d.total_page ?? 1) <= page) break;
  }
  const latest = new Map<string, AuditReport>();
  for (const r of out) {
    const key = `${r.consolidated}:${r.periodEnd}`;
    const p = latest.get(key);
    if (!p || r.rcept_dt > p.rcept_dt || (r.rcept_dt === p.rcept_dt && r.rcept_no > p.rcept_no)) latest.set(key, r);
  }
  return Array.from(latest.values()).sort((a, b) => (a.periodEnd !== b.periodEnd ? (a.periodEnd < b.periodEnd ? 1 : -1) : a.consolidated === b.consolidated ? 0 : a.consolidated ? -1 : 1));
}

const CAT_LABEL: Record<DebtCategory, string> = {
  borrowings: "차입금", bonds: "사채", convertible: "전환사채 등", borrowingsAndBonds: "차입금·사채(구분 불가)", lease: "리스부채", otherDebt: "기타 차입성 부채",
};

/** 정기보고서가 없는 회사: 기준일까지 접수된 최신 감사보고서(연결 우선)로 이자부부채를 낸다. */
/** 재무상태표 검산(2026-11-06): 자산 = 부채 + 자본, 유동 + 비유동 = 부채총계, 이자부부채 ≤ 부채총계. 안 맞으면 '검산:' 으로 시작하는 문장 */
export function bsChecks(xml: string, ibdTotal: number): string[] {
  const st = extractStatement(xml, k => k.some(n => /^(부채총계|부채합계)$/.test(n)) && k.some(n => /^(자본총계|자본합계|부채와자본총계|자본과부채총계|부채및자본총계)$/.test(n)));
  if (!st) return [];
  const get = (re: RegExp) => { const r = st.rows.find(x => re.test(x.key) && x.cur !== null); return r ? r.cur : null; };
  const near = (x: number, y: number) => Math.abs(x - y) <= Math.max(1.5e6, Math.abs(y) * 0.0005);
  const f = (v: number) => Math.round(v).toLocaleString("ko-KR");
  const out: string[] = [];
  const ta = get(/^자산(총계|합계)$/), tl = get(/^부채(총계|합계)$/), te = get(/^자본(총계|합계)$/);
  const cl = get(/^유동부채(합계|총계)?$/), ncl = get(/^(비유동부채|고정부채)(합계|총계)?$/);
  if (ta !== null && tl !== null && te !== null && !near(ta, tl + te)) out.push(`검산: 자산총계 ${f(ta)} ≠ 부채총계 ${f(tl)} + 자본총계 ${f(te)} — 재무상태표 읽기 확인`);
  const hL = st.rows.filter(x => /매각예정.*부채|처분자산집단.*부채/.test(x.key)).reduce((s2, x) => s2 + (x.cur ?? 0), 0);
  if (cl !== null && ncl !== null && tl !== null && !near(cl + ncl, tl) && !near(cl + ncl + hL, tl)) out.push(`검산: 유동부채 + 비유동부채 ${f(cl + ncl)} ≠ 부채총계 ${f(tl)} — 재무상태표 읽기 확인`);
  if (tl !== null && ibdTotal > tl * 1.0005) out.push(`검산: 이자부부채 ${f(ibdTotal)}가 부채총계 ${f(tl)}보다 큼 — 행 착오`);
  if (st.warnings.some(w => /단위 표기/.test(w))) out.push("검산: 단위(원·천원·백만원) 표기를 찾지 못해 원으로 봄 — 금액 자릿수 확인");
  return out;
}

export async function debtFromAuditReport(corp: { corp_code: string; stock_code: string | null; corp_name: string | null }, until: string): Promise<DebtResult> {
  const reps = await auditReportsUntil(corp.corp_code, until);
  if (!reps.length) throw new DartError(`${until} 까지 접수된 정기보고서·감사보고서가 없습니다.`, "NO_REPORT");
  const rep = reps[0];
  const files = await downloadDocument(rep.rcept_no);
  // 본문 파일(감사보고서) — 재무상태표가 잡히는 첫 파일
  let a: AuditDebt | null = null; let ax = "";
  for (const f of files) { const r = debtFromAuditXml(f.xml); if (!r.noBs) { a = r; ax = f.xml; break; } if (!a) { a = r; ax = f.xml; } }
  const res = a!;
  const notes = [...res.notes];
  const checks = [...res.checks, ...bsChecks(ax, res.total)];
  const months = (Number(until.slice(0, 4)) - Number(rep.periodEnd.slice(0, 4))) * 12 + Number(until.slice(4, 6)) - Number(rep.periodEnd.slice(4));
  notes.unshift(`정기보고서(사업·반기·분기)가 없는 회사라 감사보고서 원문 표에서 읽음(단위 ${res.unitLabel}). 결산일 ${rep.periodEnd.slice(0, 4)}.${rep.periodEnd.slice(4)} 기준 값${months > 3 ? ` — 평가기준일과 ${months}개월 차이, 그 사이 차입 변동은 반영되지 않음` : ""}`);
  if (res.heldForSale) notes.push(`매각예정 처분자산집단 부채 ${eok(res.heldForSale)}은 이자부부채에 넣지 않음`);
  if (res.noBs) checks.unshift("감사보고서에서 재무상태표 표를 찾지 못함 — 원문 확인 필요");
  const byCategory: Record<DebtCategory, number> = { borrowings: 0, bonds: 0, convertible: 0, borrowingsAndBonds: 0, lease: 0, otherDebt: 0 };
  for (const l of res.lines) byCategory[l.category] += l.amount;
  const sum = (s: Section) => {
    const m = new Map<string, number>();
    for (const l of res.lines.filter(x => x.section === s)) m.set(CAT_LABEL[l.category], (m.get(CAT_LABEL[l.category]) ?? 0) + l.amount);
    return Array.from(m.entries());
  };
  const base = { code: corp.stock_code, corp_code: corp.corp_code, name: corp.corp_name ?? rep.corp_name, report: { name: rep.report_nm, rcept_no: rep.rcept_no, filed: rep.rcept_dt, period: rep.periodEnd, fs: (rep.consolidated ? "CFS" : "OFS") as "CFS" | "OFS" } };
  if (res.financialLike) return { ...base, total: 0, current: [], nonCurrent: [], unclassified: [], byCategory, lines: [], debtLike: [], completeness: "partial", completenessReason: null, notes, checks,
    excluded: "금융업 재무상태표(유동/비유동 구분 없이 예수부채·보험계약부채 등) — 이자부부채·EV 배수가 맞지 않는 업종이라 계산하지 않음" };
  return { ...base, total: res.total, current: sum("current"), nonCurrent: sum("nonCurrent"), unclassified: sum("unclassified"), byCategory, lines: res.lines, debtLike: res.debtLike,
    completeness: res.noBs ? "partial" : res.completeness, completenessReason: res.noBs ? "재무상태표 미인식" : res.completenessReason, notes, checks, excluded: null };
}
