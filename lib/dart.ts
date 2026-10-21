/**
 * DART 사업보고서 "II. 사업의 내용" 추출.
 *
 * 원본 내려받기·압축 해제·인코딩 판별은 dart-mcp/lib/document_client.js 를 옮겨 왔다(같은 저장소 주인의 코드).
 * 이 파일이 새로 하는 일은 두 가지다.
 * 1. 섹션 경계 — 제목 글자가 아니라 DART 구조코드로 자른다. TITLE 태그의 AASSOCNOTE 가
 *    "D-0-2-0-0"(II. 사업의 내용)인 곳부터 "D-0-3-0-0"(III. 재무에 관한 사항) 직전까지.
 *    구조코드가 없는 문서는 제목 글자(II./Ⅱ. 사업의 내용)로 대체한다.
 * 2. 표 → 마크다운 — COLSPAN·ROWSPAN 을 펼쳐 격자로 만든 뒤 마크다운 표로 쓴다.
 *    DART 는 문단을 1열짜리 표에 넣어 배치하는 경우가 많아(실측: 신세계아이앤씨 2025 사업보고서),
 *    한 행에 값이 있는 칸이 하나뿐인 표는 표가 아니라 문단으로 쓴다.
 *
 * 원문은 요청 처리 동안만 메모리에 있고 저장하지 않는다.
 */
import AdmZip from "adm-zip";
import { readFileSync } from "node:fs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

export class DartError extends Error {
  constructor(message: string, readonly code?: string) { super(message); this.name = "DartError"; }
}

function key(): string {
  const k = process.env.DART_API_KEY;
  if (!k) throw new DartError("서버 환경변수 DART_API_KEY 가 설정되어 있지 않습니다.", "NO_KEY");
  return k;
}

// ─── 상장사 대응표 ─────────────────────────────────────────

interface ListedCorp { stock_code: string; corp_code: string; corp_name: string; modify_date: string }
let listed: Map<string, ListedCorp> | null = null;
function listedMap(): Map<string, ListedCorp> {
  if (!listed) {
    const raw = JSON.parse(readFileSync(new URL("../data/listed-corps.json", import.meta.url), "utf8"));
    listed = new Map((raw.list as ListedCorp[]).map(x => [x.stock_code, x]));
  }
  return listed;
}

export function resolveCorp(input: { stock_code?: string; corp_code?: string }): { corp_code: string; stock_code: string | null; corp_name: string | null } {
  if (input.corp_code) {
    if (!/^\d{8}$/.test(input.corp_code)) throw new DartError(`corp_code 는 8자리입니다: ${input.corp_code}`);
    const hit = Array.from(listedMap().values()).find(x => x.corp_code === input.corp_code);
    return { corp_code: input.corp_code, stock_code: hit?.stock_code ?? null, corp_name: hit?.corp_name ?? null };
  }
  if (input.stock_code) {
    const hit = listedMap().get(input.stock_code);
    if (!hit) throw new DartError(`종목코드 ${input.stock_code} 를 DART 상장사 대응표에서 찾지 못했습니다(비상장사면 corp_code 로 주십시오).`, "NOT_LISTED");
    return { corp_code: hit.corp_code, stock_code: hit.stock_code, corp_name: hit.corp_name };
  }
  throw new DartError("stock_code 또는 corp_code 가 필요합니다.");
}

// ─── 보고서 찾기 ──────────────────────────────────────────

export interface ReportRef { rcept_no: string; report_nm: string; rcept_dt: string; corp_name: string }

/** 결산연도(year)의 사업보고서. 보고서명이 "(year.MM)"인 것 중 최종본(정정 반영). */
export async function findAnnualReport(corp_code: string, year: string): Promise<ReportRef> {
  const y = Number(year);
  const url = `https://opendart.fss.or.kr/api/list.json?crtfc_key=${key()}&corp_code=${corp_code}&bgn_de=${y}0101&end_de=${y + 1}1231&pblntf_detail_ty=A001&last_reprt_at=Y&page_count=100`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new DartError(`DART 공시목록 HTTP ${res.status}`);
  const d: any = await res.json();
  if (d.status === "013") throw new DartError(`${year} 결산 사업보고서가 DART 에 없습니다(아직 제출 전이거나 사업보고서 제출 대상이 아님).`, "NO_REPORT");
  if (d.status !== "000") throw new DartError(`DART 공시목록 오류 ${d.status}: ${String(d.message ?? "").slice(0, 100)}`, d.status);
  const hits = (d.list as any[]).filter(r => /사업보고서/.test(r.report_nm) && r.report_nm.includes(`(${year}.`));
  if (!hits.length) throw new DartError(`${year} 결산 사업보고서를 찾지 못했습니다(조회된 보고서: ${(d.list as any[]).map(r => r.report_nm).slice(0, 5).join(", ")}).`, "NO_REPORT");
  hits.sort((a, b) => (a.rcept_dt < b.rcept_dt ? 1 : -1));
  const h = hits[0];
  return { rcept_no: h.rcept_no, report_nm: h.report_nm.trim(), rcept_dt: h.rcept_dt, corp_name: h.corp_name };
}

// ─── 원본 내려받기 (dart-mcp 에서 옮김) ───────────────────

/** maxDuration 300초 안에서 한 번에 예산을 몰아준다 — 짧게 여러 번보다 길게 한 번이 낫다(dart-mcp 실측). */
const DOWNLOAD_TIMEOUT_MS = 240_000;

export async function downloadDocument(rcept_no: string): Promise<{ name: string; xml: string; encoding: string }[]> {
  if (!/^\d{14}$/.test(rcept_no)) throw new DartError(`rcept_no 는 14자리입니다: ${rcept_no}`);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DOWNLOAD_TIMEOUT_MS);
  let buf: Buffer;
  try {
    const res = await fetch(`https://opendart.fss.or.kr/api/document.xml?crtfc_key=${key()}&rcept_no=${rcept_no}`, { headers: { "User-Agent": UA }, signal: ac.signal });
    if (!res.ok) throw new DartError(`DART 원본 HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    if (e instanceof DartError) throw e;
    throw new DartError(`DART 원본 내려받기 실패(${(e as Error).name === "AbortError" ? `${DOWNLOAD_TIMEOUT_MS / 1000}초 초과` : (e as Error).message}). 대형 사업보고서는 DART 서버에서 지연되는 일이 있습니다 — 잠시 뒤 다시 호출하십시오.`, "DOWNLOAD");
  } finally {
    clearTimeout(timer);
  }
  if (buf.length < 100 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new DartError(`DART 원본이 zip 이 아닙니다: ${buf.toString("utf8", 0, Math.min(buf.length, 200))}`, "NOT_ZIP");
  }
  return new AdmZip(buf).getEntries().map(e => ({ name: e.entryName, ...decodeXml(e.getData()) }));
}

function decodeXml(buf: Buffer): { xml: string; encoding: string } {
  const utf8 = new TextDecoder("utf-8").decode(buf);
  const bad = (s: string) => { let n = 0; const t = s.slice(0, 200_000); for (const ch of t) if (ch === "�") n++; return t.length ? n / t.length : 0; };
  const r = bad(utf8);
  if (r < 0.001) return { xml: utf8, encoding: "utf-8" };
  try {
    const kr = new TextDecoder("euc-kr").decode(buf);
    if (bad(kr) < r) return { xml: kr, encoding: "euc-kr" };
  } catch { /* euc-kr 미지원 런타임 */ }
  return { xml: utf8, encoding: "utf-8" };
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s: string) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === "#") { const c = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(c) ? String.fromCodePoint(c) : m; }
    return ENT[e] ?? m;
  });
}
const clean = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/[ \t ]+/g, " ").replace(/\s*\n\s*/g, " ").trim();

// ─── 섹션 절단 ────────────────────────────────────────────

interface Title { pos: number; end: number; note: string; text: string }
function titles(xml: string): Title[] {
  const out: Title[] = [];
  for (const m of xml.matchAll(/<TITLE\b([^>]*)>([\s\S]*?)<\/TITLE>/g)) {
    const note = (m[1].match(/AASSOCNOTE="([^"]*)"/) ?? [])[1] ?? "";
    out.push({ pos: m.index!, end: m.index! + m[0].length, note, text: clean(m[2]) });
  }
  return out;
}

// 구조코드는 문서 종류마다 따로 매겨진다 — 사업보고서에 함께 든 감사보고서도 2장이 D-0-2-0-0 이다(2026-10-21 실측).
// 그래서 코드만으로 판정하지 않고 제목에 "사업의 내용"이 있는지 함께 본다.
const PART2_TEXT = /^(II|Ⅱ)\s*\.\s*사업의\s*내용/;
const IS_PART2 = (t: Title) => PART2_TEXT.test(t.text.replace(/\s+/g, " "));
const IS_PART3_OR_LATER = (t: Title) => /^D-0-[3-9]-0-0$|^D-0-1\d-0-0$/.test(t.note) || /^(III|Ⅲ|IV|Ⅳ|V|Ⅴ)\s*\.\s*/.test(t.text);

export interface Subsection { index: number; title: string; markdown: string; chars: number }

export function extractBusinessSection(files: { name: string; xml: string }[]): { file: string; method: string; subsections: Subsection[] } {
  // 본문 파일(접수번호.xml)을 먼저, 첨부(접수번호_NNNNN.xml)는 뒤에 본다.
  const ordered = [...files].sort((a, b) => Number(/_\d+\.xml$/i.test(a.name)) - Number(/_\d+\.xml$/i.test(b.name)));
  for (const f of ordered) {
    const ts = titles(f.xml);
    const i = ts.findIndex(IS_PART2);
    if (i < 0) continue;
    const startTitle = ts[i];
    const j = ts.findIndex((t, k) => k > i && IS_PART3_OR_LATER(t));
    const endPos = j >= 0 ? ts[j].pos : f.xml.length;
    const inside = ts.filter(t => t.pos > startTitle.pos && t.pos < endPos);
    const method = startTitle.note === "D-0-2-0-0" ? "제목+구조코드(D-0-2-0-0)" : "제목 글자(II. 사업의 내용)";
    const subs: Subsection[] = [];
    const bounds = inside.length ? inside : [];
    // 첫 하위 제목 이전 본문(있으면 "머리말")
    const firstPos = bounds.length ? bounds[0].pos : endPos;
    const lead = toMarkdown(f.xml.slice(startTitle.end, firstPos)).trim();
    if (lead) subs.push({ index: 0, title: "(머리말)", markdown: lead, chars: lead.length });
    bounds.forEach((t, k) => {
      const segEnd = k + 1 < bounds.length ? bounds[k + 1].pos : endPos;
      const md = toMarkdown(f.xml.slice(t.end, segEnd)).trim();
      subs.push({ index: k + 1, title: t.text, markdown: md, chars: md.length });
    });
    return { file: f.name, method, subsections: subs };
  }
  throw new DartError("문서에서 'II. 사업의 내용' 장을 찾지 못했습니다(사업보고서가 아니거나 형식이 다른 공시일 수 있습니다).", "NO_SECTION");
}

// ─── 마크다운 변환 ────────────────────────────────────────

/** 중첩을 고려해 최상위 <TABLE>…</TABLE> 구간을 찾는다(실측: 사업의 내용 안에서 표가 3단까지 중첩). */
function topLevelTables(xml: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let depth = 0, st = -1;
  for (const m of xml.matchAll(/<(\/?)TABLE\b[^>]*>/gi)) {
    if (!m[1]) { if (depth === 0) st = m.index!; depth++; }
    else if (depth > 0) { depth--; if (depth === 0) out.push({ start: st, end: m.index! + m[0].length }); }
  }
  return out;
}

const PH = (i: number) => `\u0000T${i}\u0000`;

function tableToMarkdown(tblXml: string): string {
  // 안쪽 표를 자리표시로 바꿔 두고 바깥 표만 격자로 만든다.
  const inner = tblXml.slice(tblXml.indexOf(">") + 1, tblXml.lastIndexOf("</"));
  const nested = topLevelTables(inner);
  const innerMd: string[] = [];
  let body = "";
  let last = 0;
  nested.forEach((t, i) => { body += inner.slice(last, t.start) + PH(i); innerMd.push(tableToMarkdown(inner.slice(t.start, t.end))); last = t.end; });
  body += inner.slice(last);

  const rows: { cells: { text: string; colspan: number; rowspan: number }[]; head: boolean }[] = [];
  const headEnd = body.search(/<\/THEAD>/i);
  for (const rm of body.matchAll(/<TR\b[^>]*>([\s\S]*?)<\/TR>/gi)) {
    const cells = [];
    for (const cm of rm[1].matchAll(/<(TD|TH|TE|TU)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
      const cs = Number((cm[2].match(/COLSPAN="(\d+)"/i) ?? [])[1] ?? 1);
      const rs = Number((cm[2].match(/ROWSPAN="(\d+)"/i) ?? [])[1] ?? 1);
      cells.push({ text: clean(cm[3]), colspan: Math.max(1, cs), rowspan: Math.max(1, rs) });
    }
    if (cells.length) rows.push({ cells, head: headEnd >= 0 && rm.index! < headEnd });
  }
  const restore = (s: string) => s.replace(/\u0000T(\d+)\u0000/g, (_, i) => `\n\n${innerMd[Number(i)]}\n\n`);
  if (!rows.length) return restore(clean(body));

  // 격자 — 세로 병합은 아래 행에도 같은 값을 채우고(읽는 쪽이 행 단위로 해석할 수 있도록),
  // 가로 병합은 머리행에서만 같은 값을 반복한다(본문 가로 병합은 첫 칸에만).
  const grid: string[][] = [], occ: boolean[][] = [];
  const headRows = rows.filter(r => r.head).length || 1;
  rows.forEach((r, ri) => {
    grid[ri] ??= []; occ[ri] ??= [];
    let c = 0;
    for (const cell of r.cells) {
      while (occ[ri][c]) c++;
      for (let dr = 0; dr < cell.rowspan; dr++) {
        grid[ri + dr] ??= []; occ[ri + dr] ??= [];
        for (let dc = 0; dc < cell.colspan; dc++) {
          occ[ri + dr][c + dc] = true;
          grid[ri + dr][c + dc] = dc === 0 || ri < headRows ? cell.text : "";
        }
      }
      c += cell.colspan;
    }
  });
  const width = Math.max(...grid.map(r => r.length));
  const norm = grid.map(r => Array.from({ length: width }, (_, i) => r[i] ?? ""));
  const filled = (r: string[]) => r.filter(x => x).length;
  const hasNested = nested.length > 0;
  // 배치용 표(행마다 값 있는 칸이 하나 이하)나 안에 표가 든 표는 문단으로 푼다.
  if (width <= 1 || hasNested || norm.every(r => filled(r) <= 1)) {
    return norm.map(r => Array.from(new Set(r.filter(Boolean))).join(" ")).filter(Boolean).map(restore).join("\n\n");
  }
  const esc = (s: string) => s.replace(/\|/g, "\\|");
  const header = Array.from({ length: width }, (_, i) => Array.from(new Set(norm.slice(0, headRows).map(r => r[i]).filter(Boolean))).join(" / "));
  const bodyRows = norm.slice(headRows).filter(r => filled(r) > 0);
  return [
    `| ${header.map(esc).join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...bodyRows.map(r => `| ${r.map(esc).join(" | ")} |`),
  ].join("\n");
}

export function toMarkdown(xml: string): string {
  const parts: string[] = [];
  const tables = topLevelTables(xml);
  let cursor = 0;
  const flushText = (seg: string) => {
    const re = /<TITLE\b[^>]*>[\s\S]*?<\/TITLE>|<IMAGE\b[\s\S]*?<\/IMAGE>|<P\b[^>]*>[\s\S]*?<\/P>/gi;
    let last = 0;
    for (const m of seg.matchAll(re)) {
      const gap = clean(seg.slice(last, m.index)); if (gap) parts.push(gap);
      const head = m[0].slice(1, 6).toUpperCase();
      if (head.startsWith("TITLE")) { const t = clean(m[0]); if (t) parts.push(`### ${t}`); }
      else if (head.startsWith("IMAGE")) { const cap = clean((m[0].match(/<IMG-CAPTION[^>]*>([\s\S]*?)<\/IMG-CAPTION>/i) ?? [])[1] ?? ""); parts.push(`[그림${cap ? `: ${cap}` : ""} — 원문 참조]`); }
      else { const t = clean(m[0]); if (t) parts.push(t); }
      last = m.index! + m[0].length;
    }
    const tail = clean(seg.slice(last)); if (tail) parts.push(tail);
  };
  for (const t of tables) {
    flushText(xml.slice(cursor, t.start));
    const md = tableToMarkdown(xml.slice(t.start, t.end)); if (md.trim()) parts.push(md.trim());
    cursor = t.end;
  }
  flushText(xml.slice(cursor));
  return parts.join("\n\n").replace(/\n{3,}/g, "\n\n");
}
