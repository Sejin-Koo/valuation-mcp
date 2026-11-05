/**
 * 이자부부채(차입금·사채·전환사채·리스·기타 차입성 부채)를 DART 재무상태표에서 분류한다.
 *
 * 왜 만들었나(2026-11-05 사용자 결정): 외부 서버 valuation_get_data 의 ibd 에만 의존하지 않도록 같은 값을 자체로 낸다.
 * 외부 서버는 시세 조회 방식을 예고 없이 바꾼 일이 있다(2026-10-29 키 없이 시세 수신 → 11-04 키 없으면 null).
 *
 * 출처와 순서
 * 1. 재무상태표 본문 — OpenDART 단일회사 전체 재무제표(fnlttSinglAcntAll). 1초 안팎.
 *    평가기준일까지 접수된 최신 정기보고서(valuation_get_data 와 같은 규칙), 연결 우선·없으면 별도.
 * 2. 주석 보충 — 본문에 리스부채 행이 없거나(기타금융부채 등에 포함), 차입금이 '금융부채' 한 줄에 묶여 있으면
 *    XBRL 원본(fnlttXbrl.xml, 25~40초)의 주석 태그로 채운다.
 *
 * 외부 값과의 대조(2026-11-05 실측, 상장사 표본, 합계): 2025 3분기 90/90, 2026 1분기 52/52, 2026 반기 79/80.
 * 본문 차입금 행에 리스가 이미 들어 있으면(주석 차입·사채 태그 + 리스 태그 = 본문) 리스를 더하지 않는다(LG화학).
 * 3. 정기보고서가 없는 비상장 외감법인은 감사보고서 원문 표로 같은 규칙을 적용한다(debt-audit.ts).
 */
import { DartError, resolveCorp } from "./dart.js";
import { debtFromAuditReport } from "./debt-audit.js";
import { periodicReportsUntil, reprtCode, downloadXbrl, type PeriodicReport, type XbrlDoc } from "./xbrl.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
function key(): string {
  const k = process.env.DART_API_KEY;
  if (!k) throw new DartError("서버 환경변수 DART_API_KEY 가 설정되어 있지 않습니다.", "NO_KEY");
  return k;
}

export type DebtCategory = "borrowings" | "bonds" | "convertible" | "borrowingsAndBonds" | "lease" | "otherDebt";
export type Section = "current" | "nonCurrent" | "unclassified";
export interface DebtLine { section: Section; name: string; amount: number; category: DebtCategory; source: "본문" | "주석"; tag: string }
export interface DebtLike { name: string; amount: number; type: "rcps" | "cps" | "convDerivative" | "unknown" }

export interface DebtResult {
  code: string | null; corp_code: string; name: string | null;
  report: { name: string; rcept_no: string; filed: string; period: string; fs: "CFS" | "OFS" };
  total: number;
  current: [string, number][]; nonCurrent: [string, number][]; unclassified: [string, number][];
  byCategory: Record<DebtCategory, number>;
  lines: DebtLine[];
  debtLike: DebtLike[];
  completeness: "full" | "partial"; completenessReason: string | null;
  notes: string[]; checks: string[];
  excluded: string | null;
}

const CAT_LABEL: Record<DebtCategory, string> = {
  borrowings: "차입금", bonds: "사채", convertible: "전환사채 등", borrowingsAndBonds: "차입금·사채(구분 불가)", lease: "리스부채", otherDebt: "기타 차입성 부채",
};

// ─── 재무상태표 본문 ──────────────────────────────────────

interface BsRow { account_id: string; account_nm: string; amount: number | null }

async function fetchBs(corp_code: string, years: string[], reprt_code: string): Promise<{ rows: BsRow[]; fs: "CFS" | "OFS"; year: string }> {
  for (const fs of ["CFS", "OFS"] as const) {
    for (const y of years) {
      const url = `https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json?crtfc_key=${key()}&corp_code=${corp_code}&bsns_year=${y}&reprt_code=${reprt_code}&fs_div=${fs}`;
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new DartError(`DART 재무제표 HTTP ${res.status}`);
      const d: any = await res.json();
      if (d.status === "013") continue;
      if (d.status !== "000") throw new DartError(`DART 재무제표 오류 ${d.status}: ${String(d.message ?? "").slice(0, 100)}`, d.status);
      const rows = (d.list as any[]).filter(x => x.sj_div === "BS").map(x => {
        const t = String(x.thstrm_amount ?? "").replace(/,/g, "").trim();
        const n = t === "" || t === "-" ? null : Number(t);
        return { account_id: String(x.account_id), account_nm: String(x.account_nm).trim(), amount: Number.isFinite(n as number) ? (n as number) : null };
      });
      if (rows.length) return { rows, fs, year: y };
    }
  }
  throw new DartError("DART 에 이 보고서의 재무상태표가 없습니다(정형 재무제표 미제공 — 원문 확인 필요).", "NO_BS");
}

const MARK: Record<string, Section | null> = {
  "ifrs-full_CurrentLiabilities": "current",
  "ifrs-full_NoncurrentLiabilities": "nonCurrent",
  // 유동/비유동 구분이 없는(유동성 배열) 회사는 부채 항목이 '부채총계'나 '자본과부채총계' 다음에 온다(실측: 스팩)
  "ifrs-full_Liabilities": "unclassified",
  "ifrs-full_EquityAndLiabilities": "unclassified",
  "ifrs-full_Equity": null, "ifrs-full_EquityAttributableToOwnersOfParent": null,
  "ifrs-full_Assets": null, "ifrs-full_CurrentAssets": null, "ifrs-full_NoncurrentAssets": null,
};

const EXCL = /채권|자산|보증금|충당|보증부채|파생|매입채무|미지급|선수|예수|이연|당기법인세|확정급여|종업원|기타비금융|계약부채|반품|임대보증/;
const CATCH_ALL = /^(기타)?(유동|비유동|단기|장기)?금융부채$/;
const CONTRA = /할인발행차금|전환권조정|신주인수권조정|교환권조정|현재가치할인차금|사채할인/;

type Cls = DebtCategory | "debtLike" | null;
export function classify(nm: string, aid: string): Cls {
  const n = nm.replace(/\s/g, "");
  if (/상환우선주|전환우선주/.test(n)) return "debtLike";
  if (EXCL.test(n) && !/차입|사채/.test(n)) return null;
  if (/리스(유동|비유동|장기|단기)?부채/.test(n) || aid.includes("LeaseLiabilities")) return "lease";
  if (/전환권조정|신주인수권조정|교환권조정/.test(n)) return "convertible";
  if (/유동화/.test(n)) return "otherDebt";
  if (/전환사채|신주인수권부사채|교환사채/.test(n) || /Convertible|Exchangeable|Warrant/.test(aid)) return "convertible";
  if (/사채할인발행차금|사채상환할증금/.test(n)) return "bonds";
  if (n.includes("사채") && n.includes("차입")) return /사채포함|사채제외/.test(n) ? "borrowings" : "borrowingsAndBonds";
  if (n.includes("사채") || /Bonds/.test(aid)) return "bonds";
  if (/차입|유동성장기부채/.test(n) || /Borrowings|LoansReceived/.test(aid)) return "borrowings";
  return null;
}

function debtLikeType(nm: string): DebtLike["type"] {
  const n = nm.replace(/\s/g, "");
  if (/상환전환우선주|전환상환우선주|상환우선주/.test(n)) return "rcps";
  if (/전환우선주/.test(n)) return "cps";
  if (/전환권|파생/.test(n)) return "convDerivative";
  return "unknown";
}

interface BsParse { lines: DebtLine[]; catchAll: { section: Section; name: string; amount: number }[]; debtLike: DebtLike[]; heldForSale: number | null; hasSections: boolean; financialLike: boolean }

export function parseBs(rows: BsRow[], opt: { attachContra?: boolean } = {}): BsParse {
  let sec: Section | null = null;
  let lines: DebtLine[] = []; let catchAll: BsParse["catchAll"] = []; const debtLike: DebtLike[] = [];
  let heldForSale: number | null = null;
  let lastWasDebt = false;
  const hasSections = rows.some(r => r.account_id === "ifrs-full_CurrentLiabilities" || r.account_id === "ifrs-full_NoncurrentLiabilities");
  const financialLike = !hasSections && rows.some(r => /예수부채|보험계약부채|투자계약부채|고객예탁금|예수금/.test(r.account_nm.replace(/\s/g, "")));
  for (const r of rows) {
    if (r.account_id in MARK) { sec = MARK[r.account_id]; continue; }
    if (r.account_id === "ifrs-full_LiabilitiesIncludedInDisposalGroupsClassifiedAsHeldForSale" || /매각예정.*부채/.test(r.account_nm)) { heldForSale = r.amount; continue; }
    if (!sec || !r.amount) continue;
    let c = classify(r.account_nm, r.account_id);
    // 감사보고서 원문: 차입금 바로 뒤의 '현재가치할인차금' 등은 그 차입금의 차감계정(실측: 영산클린에너지 2025)
    const prev = lines[lines.length - 1];
    if (!c && opt.attachContra && CONTRA.test(r.account_nm.replace(/\s/g, "")) && prev && prev.section === sec && lastWasDebt) c = prev.category;
    lastWasDebt = false;
    if (c === "debtLike") { debtLike.push({ name: r.account_nm, amount: r.amount, type: debtLikeType(r.account_nm) }); continue; }
    if (c) {
      let v = r.amount;
      if (CONTRA.test(r.account_nm.replace(/\s/g, "")) && v > 0) v = -v; // 차감계정은 본계정 범주에 음수로
      lines.push({ section: sec, name: r.account_nm, amount: v, category: c, source: "본문", tag: r.account_id }); lastWasDebt = true;
    } else if (CATCH_ALL.test(r.account_nm.replace(/\s/g, ""))) catchAll.push({ section: sec, name: r.account_nm, amount: r.amount });
  }
  // 유동/비유동 구분이 있는 회사는 구분 밖 행을 쓰지 않는다(실측: 케이프 — 증권업 부채 블록의 차입부채는 금융업 차입)
  if (hasSections) { lines = lines.filter(l => l.section !== "unclassified"); catchAll = catchAll.filter(c => c.section !== "unclassified"); }
  // 부모 합계 행 제거 — 바로 뒤 연속 행들의 합과 같으면 부모로 본다(실측: 스팩 '차입부채' = 전환사채 + 전환권조정)
  const keep: DebtLine[] = [];
  lines.forEach((l, i) => {
    // 자식이 한 줄이면 부모 이름이 묶음 이름('차입부채' 등)일 때만 — 금액이 우연히 같은 바로 다음 한 줄을 부모로 오인하지 않게
    // (실측: 메디픽셀 감사보고서 장기차입금 = 신주인수권부사채 5억 / 스팩 '차입부채' = 전환사채 한 줄)
    const generic = /^(차입부채|차입금|차입금및사채|사채및차입금|금융부채|이자부부채)$/.test(l.name.replace(/\s/g, ""));
    let s = 0, parent = false;
    for (let j = i + 1; j < lines.length && lines[j].section === l.section; j++) { s += lines[j].amount; if ((j > i + 1 || generic) && Math.abs(s - l.amount) <= 1) { parent = true; break; } }
    if (!parent) keep.push(l);
  });
  return { lines: keep, catchAll, debtLike, heldForSale, hasSections, financialLike };
}

// ─── 주석(XBRL 시점값) ───────────────────────────────────

const OK_DIMS = new Set(["ConsolidatedMember", "SeparateMember", "ReportedAmountMember"]);

/** 기준일 시점(instant)의 값 중 연결/별도·보고금액 축만 있는 것. 키 = 태그 */
export function instantFacts(doc: XbrlDoc | string, instant: string, scope: "C" | "S"): Map<string, number> {
  const xml = typeof doc === "string" ? doc : doc.instance;
  const ctx = new Map<string, "C" | "S" | "N" | null>();
  for (const m of xml.matchAll(/<xbrli:context\s+id="([^"]+)"\s*>([\s\S]*?)<\/xbrli:context>/g)) {
    const b = m[2];
    const inst = (b.match(/<xbrli:instant>([^<]+)</) ?? [])[1];
    if (inst !== instant) { ctx.set(m[1], null); continue; }
    const dims = Array.from(b.matchAll(/dimension="[^"]+"\s*>([^<]+)</g), x => x[1].split(":").pop()!.trim());
    if (dims.some(d => !OK_DIMS.has(d))) { ctx.set(m[1], null); continue; }
    ctx.set(m[1], dims.includes("ConsolidatedMember") ? "C" : dims.includes("SeparateMember") ? "S" : "N");
  }
  const out = new Map<string, number>(); const exact = new Set<string>();
  for (const m of xml.matchAll(/<([A-Za-z][\w-]*):([A-Za-z]\w*)\b([^>]*?)>([^<]*)<\/\1:\2>/g)) {
    const c = (m[3].match(/contextRef="([^"]+)"/) ?? [])[1];
    const sc = c ? ctx.get(c) : null;
    if (!sc || (sc !== scope && sc !== "N")) continue;
    const v = Number(m[4].trim());
    if (!m[4].trim() || !Number.isFinite(v)) continue;
    const tag = m[2];
    if (sc === scope) { out.set(tag, v); exact.add(tag); } else if (!exact.has(tag)) out.set(tag, v);
  }
  return out;
}

// ─── 조립 ────────────────────────────────────────────────

const isoEnd = (yyyymm: string) => new Date(Date.UTC(Number(yyyymm.slice(0, 4)), Number(yyyymm.slice(4)), 0)).toISOString().slice(0, 10);
const eok = (v: number) => `${(v / 1e8).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}억`;

export async function getInterestBearingDebt(input: { stock_code?: string; corp_code?: string; valuation_date: string; deadline: number }): Promise<DebtResult> {
  const corp = resolveCorp({ stock_code: input.stock_code, corp_code: input.corp_code });
  const until = input.valuation_date.replace(/-/g, "");
  const all = await periodicReportsUntil(corp.corp_code, until);
  // 정기보고서가 없는 회사(감사보고서만 내는 비상장 외감법인)는 감사보고서 원문 표로 낸다(2026-11-05)
  if (!all.length) return debtFromAuditReport(corp, until);
  const annuals = all.filter(r => r.kind === "annual");
  const fyEndMonth = annuals.length ? Number(annuals[0].periodEnd.slice(4)) : 12;
  const target: PeriodicReport = all[0];
  const rc = reprtCode(target, fyEndMonth);
  const py = target.periodEnd.slice(0, 4);
  // 사업연도 표기: 12월 결산은 기말 연도. 결산월이 다른 회사는 시작 연도로 매기는 일이 있어 둘 다 시도한다.
  const years = fyEndMonth === 12 ? [py] : [py, String(Number(py) - 1)];
  const bs = await fetchBs(corp.corp_code, years, rc);
  const p = parseBs(bs.rows);
  const notes: string[] = []; const checks: string[] = [];
  let completeness: DebtResult["completeness"] = "full"; let reason: string | null = null;

  const base = {
    code: corp.stock_code, corp_code: corp.corp_code, name: corp.corp_name ?? target.corp_name,
    report: { name: target.report_nm, rcept_no: target.rcept_no, filed: target.rcept_dt, period: target.periodEnd, fs: bs.fs },
  };
  if (p.financialLike) {
    return { ...base, total: 0, current: [], nonCurrent: [], unclassified: [], byCategory: zeroCats(), lines: [], debtLike: [], completeness: "partial", completenessReason: null, notes: [], checks: [],
      excluded: "금융업 재무상태표(유동/비유동 구분 없이 예수부채·보험계약부채 등) — 이자부부채·EV 배수가 맞지 않는 업종이라 계산하지 않음" };
  }

  const lines = p.lines;
  const needLease = !lines.some(l => l.category === "lease");
  const needBorrow = !lines.some(l => l.category !== "lease") && p.catchAll.length > 0;
  if (needLease || needBorrow) {
    const scope = bs.fs === "CFS" ? "C" : "S";
    let nf: Map<string, number> | null = null;
    try { nf = instantFacts(await downloadXbrl(target.rcept_no, rc, input.deadline), isoEnd(target.periodEnd), scope); }
    catch (e) { checks.push(`주석(XBRL)을 받지 못해 보충하지 못함 — ${(e as Error).message}`); }
    if (nf) {
      // 본문 차입금 행에 리스가 이미 들어 있는지: 본문 차입 합 = 주석 차입·사채 태그 합 + 리스 태그 이면 포함(실측: LG화학 2025 '차입금' 행 = 차입금·사채 + 리스)
      const inside = (sec: Section, lease: number | undefined, borrowAlts: string[][], bondAlts: string[][]) => {
        if (!lease) return false;
        const bs = lines.filter(l => l.section === sec && l.category !== "lease").reduce((a, l) => a + l.amount, 0);
        const tol = Math.max(1e6, Math.abs(bs) * 0.0005);
        if (bs <= 0) return false;
        const sums = (alts: string[][]) => alts.map(alt => alt.reduce((a, t) => a + (nf!.get(t) ?? 0), 0));
        // 태그 묶음 중 하나라도 '차입·사채 + 리스 = 본문, 차입·사채 ≠ 본문' 이면 리스 포함
        for (const b of sums(borrowAlts)) for (const d of [0, ...sums(bondAlts)]) {
          if (!(b + d)) continue;
          if (Math.abs(b + d + lease - bs) <= tol && Math.abs(b + d - bs) > tol) return true;
        }
        return false;
      };
      if (needLease) {
        let cl = nf.get("CurrentLeaseLiabilities"), nl = nf.get("NoncurrentLeaseLiabilities");
        const tl = nf.get("LeaseLiabilities");
        const inC = inside("current", cl, [["ShorttermBorrowings", "CurrentPortionOfLongtermBorrowings"], ["ShorttermBorrowings", "CurrentLoansReceivedAndCurrentPortionOfNoncurrentLoansReceived"], ["CurrentLoansReceivedAndCurrentPortionOfNoncurrentLoansReceived"], ["CurrentBorrowingsAndCurrentPortionOfNoncurrentBorrowings"]], [["CurrentBondsIssuedAndCurrentPortionOfNoncurrentBondsIssued"]]);
        const inN = inside("nonCurrent", nl, [["NoncurrentPortionOfNoncurrentLoansReceived"], ["NoncurrentPortionOfOtherNoncurrentBorrowings"], ["LongtermBorrowings"]], [["NoncurrentPortionOfNoncurrentBondsIssued"]]);
        if (inC || inN) {
          notes.push(`본문 차입금 행에 리스부채가 포함돼 있어(주석 차입·사채 + 리스 = 본문 금액) ${inC && inN ? "" : inC ? "유동 " : "비유동 "}리스부채를 따로 더하지 않음`);
          if (inC) cl = undefined;
          if (inN) nl = undefined;
        }
        if (cl || nl) {
          if (cl) lines.push({ section: "current", name: "리스부채(주석)", amount: cl, category: "lease", source: "주석", tag: "ifrs-full:CurrentLeaseLiabilities" });
          if (nl) lines.push({ section: "nonCurrent", name: "리스부채(주석)", amount: nl, category: "lease", source: "주석", tag: "ifrs-full:NoncurrentLeaseLiabilities" });
          notes.push("본문에 리스부채 행이 없어 주석 리스부채를 넣음 — 본문 기타금융부채·기타부채 등에 포함된 것으로 봄");
        } else if (tl && !inC && !inN) {
          lines.push({ section: "unclassified", name: "리스부채(주석, 유동 구분 없음)", amount: tl, category: "lease", source: "주석", tag: "ifrs-full:LeaseLiabilities" });
          notes.push("본문에 리스부채 행이 없어 주석 리스부채 총액을 넣음(유동·비유동 구분 없음)");
        }
      }
      if (needBorrow) {
        // 같은 금액을 두 번 세지 않도록 합계 태그가 있으면 그것을, 없으면 구성 태그를 쓴다
        // (실측: 한국전자홀딩스 2026 반기 — 유동은 CurrentBorrowingsAndCurrentPortionOfNoncurrentBorrowings 한 태그로만 공시)
        const pick = (alts: string[][]): [string, number][] => {
          for (const alt of alts) { const got = alt.map(t => [t, nf!.get(t) ?? 0] as [string, number]).filter(([, v]) => v); if (got.length) return got; }
          return [];
        };
        const groups: [Section, DebtCategory, string[][]][] = [
          ["current", "borrowings", [["CurrentBorrowingsAndCurrentPortionOfNoncurrentBorrowings"], ["ShorttermBorrowings", "CurrentPortionOfLongtermBorrowings"], ["CurrentLoansReceivedAndCurrentPortionOfNoncurrentLoansReceived"]]],
          ["current", "bonds", [["CurrentBondsIssuedAndCurrentPortionOfNoncurrentBondsIssued"]]],
          ["nonCurrent", "borrowings", [["LongtermBorrowings"], ["NoncurrentPortionOfNoncurrentLoansReceived"]]],
          ["nonCurrent", "bonds", [["NoncurrentPortionOfNoncurrentBondsIssued"]]],
        ];
        let found = 0;
        for (const [section, category, alts] of groups) for (const [tag, v] of pick(alts)) {
          lines.push({ section, name: `${CAT_LABEL[category]}(주석)`, amount: v, category, source: "주석", tag: `ifrs-full:${tag}` }); found += v;
        }
        const totalNote = nf.get("Borrowings") ?? (((nf.get("LoansReceived") ?? 0) + (nf.get("BondsIssued") ?? 0)) || undefined);
        if (totalNote && totalNote - found > 1) {
          lines.push({ section: "unclassified", name: "차입금·사채(주석 총계 잔액, 구역 미상)", amount: totalNote - found, category: "borrowingsAndBonds", source: "주석", tag: "ifrs-full:Borrowings 또는 LoansReceived+BondsIssued" });
          checks.push(`주석 차입금 총계 ${eok(totalNote)} 중 유동·비유동 태그가 없는 ${eok(totalNote - found)}를 '구역 미상'으로 넣음 — 원문 확인 권장`);
          found = totalNote;
        }
        notes.push(`본문 '${p.catchAll.map(c => c.name).join("·")}' 안의 차입금·사채를 주석 금액으로 산정`);
        if (!found) {
          completeness = "partial"; reason = "포괄 금융부채 안의 차입금 미확인";
          checks.push(`주석에서도 차입금·사채 금액을 찾지 못함 — 포괄 금융부채(${p.catchAll.map(c => `${c.name} ${eok(c.amount)}`).join(", ")})에 차입이 없거나 비표준 태그`);
        }
      }
    } else if (needBorrow) { completeness = "partial"; reason = "주석을 받지 못해 포괄 금융부채 안의 차입금 미확인"; }
  }
  if (p.heldForSale) notes.push(`매각예정 처분자산집단 부채 ${eok(p.heldForSale)}은 이자부부채에 넣지 않음 — 차입 포함 여부는 주석 확인`);
  // 실측: 광명전기 '기타유동금융부채 및 유동성장기부채' — 차입 아닌 금액이 섞였을 수 있다
  for (const l of lines) if (l.source === "본문" && /금융부채|채무/.test(l.name.replace(/\s/g, "")))
    checks.push(`비차입 부채와 묶인 차입 행 — 전액 포함, 원문 확인: ${l.name} ${eok(l.amount)}`);

  const byCategory = zeroCats();
  for (const l of lines) byCategory[l.category] += l.amount;
  const sum = (s: Section) => {
    const m = new Map<string, number>();
    for (const l of lines.filter(x => x.section === s)) m.set(CAT_LABEL[l.category], (m.get(CAT_LABEL[l.category]) ?? 0) + l.amount);
    return Array.from(m.entries());
  };
  const total = lines.reduce((s, l) => s + l.amount, 0);
  return { ...base, total, current: sum("current"), nonCurrent: sum("nonCurrent"), unclassified: sum("unclassified"), byCategory, lines, debtLike: p.debtLike,
    completeness, completenessReason: reason, notes, checks, excluded: null };
}

function zeroCats(): Record<DebtCategory, number> {
  return { borrowings: 0, bonds: 0, convertible: 0, borrowingsAndBonds: 0, lease: 0, otherDebt: 0 };
}
