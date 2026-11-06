/**
 * 감사보고서 원문 표에서 가치평가 입력값(손익·현금흐름·재무상태표 주요 계정)을 읽는다.
 *
 * 왜(2026-11-05 사용자 결정): 감사보고서만 내는 비상장 외감법인은 정기보고서·XBRL 이 없어 dart_ebitda_inputs·
 * 외부 valuation_get_data 로 실적·현금·자본을 받을 수 없다. 이자부부채(debt-audit.ts)와 같은 표 읽기(audit-bs.ts)를 쓴다.
 *
 * 당기·전기 칸을 함께 읽어 한 보고서로 2개 연도를 낸다. 감가상각비는 현금흐름표(조정 항목) → 현금흐름 주석 순으로 찾는다.
 */
import { extractStatement, tableGrid, cleanName, keyName, parseAmount, type Statement, type StmtRow } from "./audit-bs.js";
import { noteTables, priorYearTable, labels, auditReportsUntil, auditOpinion, debtFromAuditXml, type NoteTable, type AuditReport } from "./debt-audit.js";
import { DartError, resolveCorp, downloadDocument } from "./dart.js";
import { summarize, near, type VerifyItem, type Verification } from "./verify.js";

export interface YearFin {
  period: "당기" | "전기";
  revenue: number | null; operatingIncome: number | null; pretaxIncome: number | null; netIncome: number | null; netIncomeParent: number | null;
  depreciation: number | null; amortization: number | null; rightOfUseDepreciation: number | null; investmentPropertyDepreciation: number | null;
  depreciationAmortization: number | null; ebitda: number | null;
  operatingCashFlow: number | null; capexTangible: number | null; capexIntangible: number | null;
  cash: number | null; shortTermDeposits: number | null; receivables: number | null; inventories: number | null; payables: number | null;
  totalAssets: number | null; totalLiabilities: number | null; totalEquity: number | null; equityParent: number | null; nci: number | null;
}
export interface AuditFin {
  years: YearFin[]; unitLabel: string;
  sources: Record<string, string>;   // 항목 → 읽은 표·행
  warnings: string[];
  found: { bs: boolean; is: boolean; cf: boolean };
  checks: VerifyItem[];             // 검산 결과(verify.ts) — getAuditFinancials 에서 감사의견·연도 연결·이자부부채 검산을 더해 요약
}

const norm = (s: string) => s.replace(/\s/g, "");
// 이름이 맞는 첫 행 — 값이 빈 제목 행('영업활동현금흐름' 머리 등)은 건너뛰고 값이 있는 행을 고른다
const first = (st: Statement | null, re: RegExp, from = 0) => {
  if (!st) return null;
  let blank: { row: StmtRow; i: number } | null = null;
  for (let i = from; i < st.rows.length; i++) if (re.test(st.rows[i].key)) { if (st.rows[i].cur !== null || st.rows[i].prev !== null) return { row: st.rows[i], i }; blank = blank ?? { row: st.rows[i], i }; }
  return blank;
};
const signFix = (row: StmtRow, v: number | null) => (v !== null && v > 0 && /손실$/.test(row.key) && !/이익/.test(row.key) ? -v : v);

const BS_PICK = (k: string[]) => k.some(n => /^(부채총계|부채합계)$/.test(n)) && k.some(n => /^(자본총계|자본합계|부채와자본총계|자본과부채총계|부채및자본총계)$/.test(n));
const OP = /^영업(이익|손실|손익)(\((이익|손실)\))?$/;
const NI = /^(연결)?(당기|분기|반기)?순(이익|손실|손익)(\((이익|손실)\))?$/;
const IS_PICK = (k: string[]) => k.some(n => OP.test(n)) && k.some(n => NI.test(n) || /^당기순(이익|손실)/.test(n));
const CF_PICK = (k: string[]) => k.some(n => /영업활동/.test(n)) && k.some(n => /투자활동/.test(n));

const DEP = /^(유형자산)?감가상각비(\(유형자산\))?$/;
const AMO = /^무형자산(상각비|상각|감가상각비)$/;
const ROU = /^(사용권자산|리스자산)(감가)?상각비$/;
const IPD = /^투자부동산(감가)?상각비$/;
const TANG = /^(토지|건물|구축물|기계장치|차량운반구|비품|공구와기구|공구기구|건설중인자산|시설장치|집기비품|선박|항공기|유형자산|기타유형자산|금형|공기구비품|시설물)의?(취득|증가)$/;
const INTANG = /^(무형자산|소프트웨어|개발비|산업재산권|특허권|기타무형자산|회원권)의?(취득|증가)$/;

/** 현금흐름 주석(영업에서 창출된 현금·조정 항목) 표의 상각비 행. 감가상각비 행이 있는 첫 표를 쓴다 */
function noteDa(tables: NoteTable[]): { re: RegExp; name: string; cur: number | null; prev: number | null }[] {
  for (const t of tables) {
    if (!t.unit || priorYearTable(t)) continue;
    if (!/현금흐름|영업활동|창출된현금|영업으로부터/.test(norm(t.context.slice(-250)))) continue;
    const hits: { re: RegExp; name: string; cur: number | null; prev: number | null }[] = [];
    for (const r of t.rows.slice(t.headRows)) {
      const l = labels(r)[0]; if (!l) continue;
      const k = keyName(l.label);
      for (const x of [DEP, AMO, ROU, IPD]) if (x.test(k) && !hits.some(h => h.re === x)) {
        const nums = r.slice(l.idx + 1).map(c => ({ t: (c ?? "").trim(), v: parseAmount(c ?? "") })).filter(z => z.t && z.v !== null);
        hits.push({ re: x, name: k, cur: nums[0] ? nums[0].v! * t.unit! : null, prev: nums[1] ? nums[1].v! * t.unit! : null });
      }
    }
    if (hits.some(h => h.re === DEP)) return hits;
  }
  return [];
}

/** 자산 변동표(유형·무형·사용권·투자부동산)의 당기 상각 합계 — '합계' 칸, 없으면 행의 숫자 합 */
type RollKind = "ppe" | "intangible" | "rou" | "ip";
function rollForward(tables: NoteTable[]): Partial<Record<RollKind, { v: number; src: string }>> {
  const out: Partial<Record<RollKind, { v: number; src: string }>> = {};
  // 바로 앞 제목에서 마지막으로 나온 자산 이름으로 표 종류를 정한다(실측: 텔레칩스 2025 — 무형자산 표 앞 설명에 '사용권자산'이 섞여 있음)
  const kindOf = (ctx: string, head: string): RollKind | null => {
    if (!/변동|증감|기초|기말/.test(ctx.slice(-150) + head)) return null;
    const c = ctx.slice(-150);
    const pos: [RollKind, number][] = [["rou", c.lastIndexOf("사용권자산")], ["ip", c.lastIndexOf("투자부동산")], ["intangible", c.lastIndexOf("무형자산")], ["ppe", Math.max(c.lastIndexOf("유형자산") - (c.lastIndexOf("무형자산") === c.lastIndexOf("유형자산") - 1 ? 9999 : 0), -1)]];
    const best = pos.filter(([, i]) => i >= 0).sort((a, b) => b[1] - a[1])[0];
    if (best) return best[0];
    if (/토지|건물|기계장치/.test(head)) return "ppe";
    return null;
  };
  for (const t of tables) {
    if (!t.unit || priorYearTable(t)) continue;
    const near = norm(t.context.slice(-200)), head = norm(t.headText);
    if (/전기|전반기/.test(near.slice(-15)) && !/당기/.test(near.slice(-15))) continue;
    const kind = kindOf(near, head);
    if (!kind || out[kind]) continue;
    const width = Math.max(...t.rows.map(r => r.length));
    const hrows = t.rows.slice(0, Math.max(1, t.headRows));
    let totCol = -1;
    for (let c = width - 1; c >= 1; c--) if (/^(합계|계|총계|합)$/.test(norm(hrows.map(r => r[c] ?? "").join("")).replace(/\(.*\)/, ""))) { totCol = c; break; }
    for (const r of t.rows.slice(t.headRows)) {
      const l = labels(r)[0]; if (!l) continue;
      const k = keyName(l.label).replace(/\(\*\d*\)$/, "");
      if (!/^(감가상각비|감가상각|상각비|상각|상각액|무형자산상각비|감가상각누계액의증가)$/.test(k)) continue;
      let v: number | null = null;
      if (totCol > l.idx) v = parseAmount(r[totCol] ?? "");
      if (v === null) { const nums = r.slice(l.idx + 1).map(c => parseAmount(c ?? "")).filter((x): x is number => x !== null); if (nums.length) v = nums.reduce((a, b) => a + Math.abs(b), 0); }
      if (v) { out[kind] = { v: Math.abs(v) * t.unit, src: `${kind === "ppe" ? "유형자산" : kind === "intangible" ? "무형자산" : kind === "rou" ? "사용권자산" : "투자부동산"} 변동표 '${l.label}'` }; break; }
    }
    if (out[kind]) continue;
    // 가로형 변동표: 칸이 '기초·취득·감가상각비·기말', 행이 자산 종류 → '합계' 행의 상각 칸(실측: HMM 2025)
    let depCol = -1;
    for (let c = 1; c < width; c++) if (/^(감가)?상각(비|액)?(\(\*\d*\))?$/.test(norm(hrows.map(r => r[c] ?? "").join("")).replace(/^(당기|전기)/, ""))) { depCol = c; break; }
    if (depCol > 0) {
      const tot = t.rows.slice(t.headRows).find(r => labels(r).some(l => /^(합계|계|총계|합)$/.test(keyName(l.label))));
      const v = tot ? parseAmount(tot[depCol] ?? "") : null;
      if (v) out[kind] = { v: Math.abs(v) * t.unit, src: `${kind === "ppe" ? "유형자산" : kind === "intangible" ? "무형자산" : kind === "rou" ? "사용권자산" : "투자부동산"} 변동표 합계 행의 상각 칸` };
    }
  }
  return out;
}

export function financialsFromAuditXml(xml: string): AuditFin {
  const warnings: string[] = []; const sources: Record<string, string> = {};
  const bs = extractStatement(xml, BS_PICK);
  const is = extractStatement(xml, IS_PICK, bs?.start ?? 0) ?? extractStatement(xml, IS_PICK);
  const cf = extractStatement(xml, CF_PICK, is?.start ?? bs?.start ?? 0) ?? extractStatement(xml, CF_PICK);
  for (const [nm, st] of [["재무상태표", bs], ["손익계산서", is], ["현금흐름표", cf]] as const) {
    if (!st) warnings.push(`${nm} 표를 찾지 못함`);
    else for (const w of st.warnings) warnings.push(`${nm}: ${w}`);
  }
  const years: YearFin[] = (["당기", "전기"] as const).map(period => {
    const pick = (st: Statement | null, re: RegExp, label: string, from = 0) => {
      const h = first(st, re, from);
      if (!h) return { v: null as number | null, i: -1 };
      const v = period === "당기" ? h.row.cur : h.row.prev;
      if (period === "당기") sources[label] = `${st!.title || "표"} '${h.row.name}'`;
      return { v: signFix(h.row, v), i: h.i };
    };
    const y: YearFin = {
      period,
      revenue: pick(is, /^(매출액|매출|수익\(매출액\)|매출액\(수익\)|영업수익|영업수익\(매출액\)|매출액\(영업수익\)|수익|매출및지분법손익|매출액및지분법손익)$/, "매출").v,
      operatingIncome: pick(is, OP, "영업이익").v,
      pretaxIncome: pick(is, /^법인세(비용)?(차감|공제)전(계속)?(영업|사업)?(순)?(이익|손실|손익)(\((이익|손실)\))?$/, "법인세차감전이익").v,
      netIncome: null, netIncomeParent: null,
      depreciation: null, amortization: null, rightOfUseDepreciation: null, investmentPropertyDepreciation: null, depreciationAmortization: null, ebitda: null,
      operatingCashFlow: pick(cf, /^영업활동(으로인한|에서발생한|으로부터의|으로부터|에서창출된)?(순)?현금(흐름|유입|유출)/, "영업활동현금흐름").v,
      capexTangible: null, capexIntangible: null,
      cash: pick(bs, /^현금및현금(성)?자산$|^현금및현금등가물$|^현금및예금$/, "현금및현금성자산").v,
      shortTermDeposits: pick(bs, /^단기금융상품$|^단기예금$|^단기예치금$/, "단기금융상품").v,
      receivables: pick(bs, /^매출채권(및기타(유동)?채권)?$|^외상매출금$/, "매출채권").v,
      inventories: pick(bs, /^(유동)?재고자산$/, "재고자산").v,
      payables: pick(bs, /^매입채무(및기타(유동)?채무)?$|^외상매입금$/, "매입채무").v,
      totalAssets: pick(bs, /^자산총계$|^자산합계$/, "자산총계").v,
      totalLiabilities: pick(bs, /^부채총계$|^부채합계$/, "부채총계").v,
      totalEquity: pick(bs, /^자본총계$|^자본합계$/, "자본총계").v,
      equityParent: pick(bs, /^(?!.*비지배)(지배기업|지배회사|지배주주).*(지분|자본|부분|소유주)$/, "지배기업소유주지분").v,
      nci: pick(bs, /^비지배(주주)?지분$/, "비지배지분").v,
    };
    // 순이익: 법인세차감전 이후 첫 '당기순이익' 행, 지배주주 귀속은 그 뒤 '지배기업…' 행(없으면 순이익)
    const ptI = first(is, /^법인세(비용)?(차감|공제)전/)?.i ?? 0;
    const niH = first(is, NI, ptI) ?? first(is, /^당기순(이익|손실)/, ptI);
    if (niH) {
      y.netIncome = signFix(niH.row, period === "당기" ? niH.row.cur : niH.row.prev);
      if (period === "당기") sources["당기순이익"] = `${is!.title || "표"} '${niH.row.name}'`;
      // '당기순이익의 귀속' 머리가 있으면 그 아래 첫 지배 행, 없으면 '총포괄손익의 귀속' 머리 전까지의 첫 지배 행(실측: 에코프로비엠 2025 — 총포괄손익 합계 행이 귀속 머리보다 앞)
      const isPar = (k: string) => /(지배기업|지배회사|지배주주|소유주)/.test(k) && !/비지배/.test(k) && !/주당/.test(k);
      const hdr = is!.rows.findIndex((r, i) => i > niH.i && /순(이익|손실|손익).*귀속/.test(r.key) && !/총포괄/.test(r.key));
      const stop = is!.rows.findIndex((r, i) => i > niH.i && /총포괄.*귀속/.test(r.key));
      const par = hdr >= 0 ? is!.rows.findIndex((r, i) => i > hdr && isPar(r.key)) : is!.rows.findIndex((r, i) => i > niH.i && (stop < 0 || i < stop) && isPar(r.key));
      if (par >= 0) { const r = is!.rows[par]; y.netIncomeParent = period === "당기" ? r.cur : r.prev; if (period === "당기") sources["지배주주순이익"] = `${is!.title || "표"} '${r.name}'`; }
      else y.netIncomeParent = y.netIncome;
    }
    // 감가상각비: 현금흐름표 조정 항목 → 현금흐름 주석
    const da = (re: RegExp, label: string) => { const h = first(cf, re); if (!h) return null; if (period === "당기") sources[label] = `${cf!.title || "현금흐름표"} '${h.row.name}'`; const v = period === "당기" ? h.row.cur : h.row.prev; return v === null ? null : Math.abs(v); };
    y.depreciation = da(DEP, "감가상각비"); y.amortization = da(AMO, "무형자산상각비"); y.rightOfUseDepreciation = da(ROU, "사용권자산상각비"); y.investmentPropertyDepreciation = da(IPD, "투자부동산상각비");
    // 유형·무형자산 취득(투자활동, 양수로)
    const sumRows = (re: RegExp, label: string) => {
      if (!cf) return null;
      const rows = cf.rows.filter(r => re.test(r.key));
      if (!rows.length) return null;
      const one = rows.find(r => /^(유형자산|무형자산)의?(취득|증가)$/.test(r.key));
      const use = one ? [one] : rows;
      if (period === "당기") sources[label] = `${cf.title || "현금흐름표"} ${use.map(r => `'${r.name}'`).join("+")}`;
      return use.reduce((a, r) => a + Math.abs((period === "당기" ? r.cur : r.prev) ?? 0), 0);
    };
    y.capexTangible = sumRows(TANG, "유형자산 취득"); y.capexIntangible = sumRows(INTANG, "무형자산 취득");
    return y;
  });
  // 현금흐름표에 상각비 행이 없으면(K-IFRS: 조정 합계만 표시) 현금흐름 주석에서
  const noteAt = xml.search(/<TITLE[^>]*>\s*주\s*석\s*<\/TITLE>/i);
  const tables = noteTables(xml, noteAt >= 0 ? noteAt : (cf?.start ?? 0));
  if (years[0].depreciation === null && years[0].amortization === null) {
    for (const h of noteDa(tables)) {
      const key = h.re === DEP ? "depreciation" : h.re === AMO ? "amortization" : h.re === ROU ? "rightOfUseDepreciation" : "investmentPropertyDepreciation";
      (years[0] as any)[key] = h.cur === null ? null : Math.abs(h.cur); (years[1] as any)[key] = h.prev === null ? null : Math.abs(h.prev);
      sources[{ depreciation: "감가상각비", amortization: "무형자산상각비", rightOfUseDepreciation: "사용권자산상각비", investmentPropertyDepreciation: "투자부동산상각비" }[key]!] = `현금흐름 주석 '${h.name}'`;
    }
  }
  // 자산 변동표로 보완(당기만): 현금흐름 쪽에 없거나, 사용권자산 상각이 감가상각비에 들어 있는지 판정
  const rf = rollForward(tables);
  const y0 = years[0];
  const tol = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e6, Math.abs(b) * 0.01);
  const fromCf = y0.depreciation !== null;
  // 현금흐름 쪽 감가상각비가 유형자산 변동표의 30%에도 못 미치면 다른 표(판관비 등)를 집은 것으로 보고 변동표 값을 쓴다(실측: 송원산업 2025)
  if (fromCf && rf.ppe && y0.depreciation! < rf.ppe.v * 0.3) { warnings.push(`현금흐름 쪽 감가상각비 ${Math.round(y0.depreciation!).toLocaleString("ko-KR")}원이 유형자산 변동표(${Math.round(rf.ppe.v).toLocaleString("ko-KR")}원)보다 작아 변동표 값을 씀`); y0.depreciation = rf.ppe.v; sources["감가상각비"] = rf.ppe.src; }
  if (y0.depreciation === null && rf.ppe) { y0.depreciation = rf.ppe.v; sources["감가상각비"] = rf.ppe.src; }
  if (y0.amortization === null && rf.intangible) { y0.amortization = rf.intangible.v; sources["무형자산상각비"] = rf.intangible.src; }
  // 투자부동산 상각은 현금흐름의 감가상각비에 들어 있는 경우가 많아, 감가상각비를 변동표로 채운 경우에만 더한다
  if (y0.investmentPropertyDepreciation === null && rf.ip && !fromCf) { y0.investmentPropertyDepreciation = rf.ip.v; sources["투자부동산상각비"] = rf.ip.src; }
  if (y0.rightOfUseDepreciation === null && rf.rou) {
    // 감가상각비 = 유형자산 변동표 → 따로 더함 / = 유형 + 사용권 → 이미 포함 / 판정할 수 없으면 더하지 않음(XBRL 도구와 같은 보수적 처리)
    if (y0.depreciation === null) { y0.rightOfUseDepreciation = rf.rou.v; sources["사용권자산상각비"] = rf.rou.src; }
    else if (rf.ppe && tol(y0.depreciation, rf.ppe.v) && !tol(y0.depreciation, rf.ppe.v + rf.rou.v)) { y0.rightOfUseDepreciation = rf.rou.v; sources["사용권자산상각비"] = `${rf.rou.src} — 감가상각비(=유형자산 변동표)와 별도라 더함`; }
    else if (rf.ppe && tol(y0.depreciation, rf.ppe.v + rf.rou.v)) sources["사용권자산상각비"] = `${rf.rou.src} — 감가상각비에 포함(따로 더하지 않음)`;
    else { sources["사용권자산상각비"] = `${rf.rou.src} — 감가상각비 포함 여부 판정 불가(더하지 않음)`; warnings.push(`사용권자산 상각 ${Math.round(rf.rou.v).toLocaleString("ko-KR")}원이 감가상각비에 들어 있는지 판정하지 못해 더하지 않음 — 리스부채를 순차입금에 넣었다면 원문 확인`); }
  }
  for (const y of years) {
    const parts = [y.depreciation, y.amortization, y.rightOfUseDepreciation, y.investmentPropertyDepreciation].filter((v): v is number => v !== null);
    // 유형자산 감가상각비를 못 찾으면 합계를 내지 않는다(사용권자산 상각만으로 EBITDA 를 만들지 않게 — 실측: 디오 2025)
    y.depreciationAmortization = y.depreciation !== null && parts.length ? parts.reduce((a, b) => a + b, 0) : null;
    y.ebitda = y.operatingIncome !== null && y.depreciationAmortization !== null ? y.operatingIncome + y.depreciationAmortization : null;
    if (y.totalAssets !== null && y.totalLiabilities !== null && y.totalEquity !== null && Math.abs(y.totalAssets - y.totalLiabilities - y.totalEquity) > Math.max(1e6, Math.abs(y.totalAssets) * 0.0005))
      warnings.push(`${y.period}: 자산총계 ≠ 부채총계 + 자본총계 — 표 읽기 확인 필요`);
    if (y.equityParent === null && y.totalEquity !== null) y.equityParent = y.totalEquity - (y.nci ?? 0); // 지배기업 행이 없는 표(자본총계 − 비지배지분)
  }
  if (years[0].depreciationAmortization === null) warnings.push("감가상각비를 현금흐름표·현금흐름 주석에서 찾지 못함 — EBITDA 미계산(유형자산 주석 확인)");
  if (years[0].revenue === null) warnings.push("매출 행을 찾지 못함(업종별 계정명 확인)");

  // ── 검산(2026-11-06): 표 안의 합계 관계가 맞는지. 안 맞으면 표 읽기(칸·단위·행) 오류일 가능성이 크다 ──
  const checks: VerifyItem[] = [];
  const V = (item: string, message: string) => checks.push({ level: "verify", item, message });
  const W = (item: string, message: string) => checks.push({ level: "warn", item, message });
  const fmt = (v: number) => Math.round(v).toLocaleString("ko-KR");
  for (const [nm, st] of [["재무상태표", bs], ["손익계산서", is], ["현금흐름표", cf]] as const) {
    if (!st) V(nm, "표를 찾지 못함 — 이 표에서 읽는 항목은 비어 있음");
    else if (st.warnings.some(w => /단위 표기/.test(w))) V(nm, "단위(원·천원·백만원) 표기를 찾지 못해 원으로 봄 — 금액 자릿수 확인");
    else if (st.warnings.some(w => /기간 표기가 하나뿐/.test(w))) W(nm, "기간 표기가 하나뿐인 표(설립 첫 해 등) — 모든 금액 칸을 당기로 봄");
    else if (st.warnings.some(w => /주석 번호 칸을 머리 없이/.test(w))) W(nm, "주석 번호 칸을 머리 없이 판정함");
  }
  const val = (st: Statement | null, re: RegExp, per: 0 | 1) => { const h = first(st, re); if (!h) return null; const v = per === 0 ? h.row.cur : h.row.prev; return v === null ? null : signFix(h.row, v); };
  for (const per of [0, 1] as const) {
    const y = years[per]; const tag = per === 0 ? "" : "(전기)";
    if (y.totalAssets !== null && y.totalLiabilities !== null && y.totalEquity !== null && !near(y.totalAssets, y.totalLiabilities + y.totalEquity))
      V(`재무상태표${tag}`, `자산총계 ${fmt(y.totalAssets)} ≠ 부채총계 ${fmt(y.totalLiabilities)} + 자본총계 ${fmt(y.totalEquity)}`);
    const ca = val(bs, /^유동자산(합계|총계)?$/, per), nca = val(bs, /^(비유동자산|고정자산)(합계|총계)?$/, per);
    // 매각예정 자산·부채가 유동·비유동 밖에 따로 있으면 더해서 본다(실측: 엑셈·SFA 2025)
    const held = (re: RegExp) => (bs?.rows ?? []).filter(r => re.test(r.key)).reduce((a, r) => a + ((per === 0 ? r.cur : r.prev) ?? 0), 0);
    const hA = held(/매각예정.*자산|처분자산집단.*자산/), hL = held(/매각예정.*부채|처분자산집단.*부채/);
    if (ca !== null && nca !== null && y.totalAssets !== null && !near(ca + nca, y.totalAssets) && !near(ca + nca + hA, y.totalAssets)) V(`재무상태표${tag}`, `유동자산 + 비유동자산 ${fmt(ca + nca)} ≠ 자산총계 ${fmt(y.totalAssets)}`);
    const cl = val(bs, /^유동부채(합계|총계)?$/, per), ncl = val(bs, /^(비유동부채|고정부채)(합계|총계)?$/, per);
    if (cl !== null && ncl !== null && y.totalLiabilities !== null && !near(cl + ncl, y.totalLiabilities) && !near(cl + ncl + hL, y.totalLiabilities)) V(`재무상태표${tag}`, `유동부채 + 비유동부채 ${fmt(cl + ncl)} ≠ 부채총계 ${fmt(y.totalLiabilities)}`);
    const cogs = val(is, /^매출원가$|^영업원가$/, per), gp = val(is, /^매출총(이익|손실|손익)(\((이익|손실)\))?$/, per);
    if (y.revenue !== null && cogs !== null && gp !== null && !near(y.revenue - Math.abs(cogs), gp) && !near(y.revenue + cogs, gp)) V(`매출${tag}`, `매출 ${fmt(y.revenue)} − 매출원가 ${fmt(Math.abs(cogs))} ≠ 매출총이익 ${fmt(gp)}`);
    const tax = val(is, /^(법인세(비용|수익|비용\(수익\)|등|비용\(이익\))|법인세)$/, per);
    const disc = is?.rows.some(r => /중단영업/.test(r.key));
    if (!disc && y.pretaxIncome !== null && tax !== null && y.netIncome !== null && !near(y.pretaxIncome - tax, y.netIncome) && !near(y.pretaxIncome + tax, y.netIncome))
      V(`당기순이익${tag}`, `법인세차감전이익 ${fmt(y.pretaxIncome)} − 법인세 ${fmt(tax)} ≠ 당기순이익 ${fmt(y.netIncome)}`);
    if (y.operatingIncome !== null && y.revenue !== null && y.revenue > 0 && y.operatingIncome > y.revenue) V(`영업이익${tag}`, `영업이익 ${fmt(y.operatingIncome)}이 매출 ${fmt(y.revenue)}보다 큼 — 행 착오 가능`);
  }
  // 구역 세부 합계: 유동자산·비유동자산·유동부채·비유동부채 아래 행들의 합 = 구역 소계(행 하나를 잘못 읽으면 여기서 걸린다).
  // 일반기업회계기준의 중간 소계(당좌자산 등) 때문에 합이 소계의 2배가 되는 표, 매각예정 행이 섞인 표는 맞는 것으로 본다(실측: 상장·비상장 175개 문서 구역 675개 중 671개 통과, 나머지 4개는 매각예정).
  if (bs) for (const per of [0, 1] as const) {
    const rows = bs.rows; const HEAD = /^(유동자산|비유동자산|고정자산|유동부채|비유동부채|고정부채)$/;
    const END = /^(자산총계|부채총계|자본|자본총계|부채|자산|유동자산|비유동자산|고정자산|유동부채|비유동부채|고정부채|자산합계|부채합계)$|합계$|총계$/;
    const v = (r: StmtRow) => (per === 0 ? r.cur : r.prev);
    for (let i = 0; i < rows.length; i++) {
      if (!HEAD.test(rows[i].key)) continue;
      let sub = v(rows[i]); let j = i + 1; const vals: number[] = []; let held = 0;
      for (; j < rows.length && !END.test(rows[j].key); j++) { const x = v(rows[j]); if (x !== null) { vals.push(x); if (/매각예정|처분자산집단/.test(rows[j].key)) held += x; } }
      if (sub === null && j < rows.length && /(합계|총계)$/.test(rows[j].key) && rows[j].key.startsWith(rows[i].key.slice(0, 3))) sub = v(rows[j]);
      if (sub === null || !vals.length) continue;
      const tot = vals.reduce((a, b) => a + b, 0);
      // 부모 행(바로 뒤 연속 행들의 합과 같은 행)을 뺀 합도 본다
      const keep = vals.slice();
      for (let a2 = 0; a2 < keep.length; a2++) { let t = 0; for (let b = a2 + 1; b < keep.length; b++) { t += keep[b]; if (b > a2 + 1 && near(t, keep[a2])) { keep[a2] = 0; break; } } }
      const tot2 = keep.reduce((a, b) => a + b, 0);
      if ([tot, tot - held, tot / 2, (tot - held) / 2, tot2, tot2 - held].some(t => near(t, sub!))) continue;
      (per ? W : V)(`재무상태표${per ? "(전기)" : ""}`, `${rows[i].name} 아래 행들의 합 ${fmt(tot)} ≠ ${rows[i].name} ${fmt(sub)} — 행 하나를 잘못 읽었을 수 있음`);
    }
  }
  // 단위를 잘못 읽으면 합계 검산이 그대로 맞으므로 크기로 본다: 외부감사 대상인데 자산총계가 10억 원 미만이면 단위 확인
  if (years[0].totalAssets !== null && Math.abs(years[0].totalAssets) < 1e9) W("단위", `자산총계 ${fmt(years[0].totalAssets)}원 — 외부감사 대상 회사로는 매우 작음, 원문 단위(원·천원·백만원) 확인`);
  // 핵심 항목을 못 찾으면 주의(값이 비어 보이는 것과 별개로 이유를 남긴다)
  const y0k = years[0];
  for (const [k, label] of [["revenue", "매출"], ["operatingIncome", "영업이익"], ["pretaxIncome", "법인세차감전이익"], ["netIncome", "당기순이익"], ["cash", "현금및현금성자산"], ["operatingCashFlow", "영업활동현금흐름"], ["depreciationAmortization", "감가상각비"]] as const)
    if (y0k[k] === null && (k !== "depreciationAmortization" || cf)) W(label, "해당 행을 찾지 못함 — 업종별 계정명이 다를 수 있음");
  // 감가상각비: 주석·변동표에서 읽었거나 판정을 보류했으면 주의
  for (const [k, v] of Object.entries(sources)) if (/상각/.test(k) && /주석|변동표/.test(v) && !/포함\(따로 더하지 않음\)/.test(v)) W(k, `현금흐름표가 아니라 ${v.replace(/ — .*/, "")}에서 읽음`);
  for (const w of warnings) if (/사용권자산 상각 .*판정하지 못해/.test(w)) W("사용권자산상각비", w);
  for (const w of warnings) if (/변동표 값을 씀/.test(w)) W("감가상각비", w);
  if (rf.ppe && y0.depreciation !== null && sources["감가상각비"] && !/변동표/.test(sources["감가상각비"]) && (y0.depreciation > rf.ppe.v * 1.5 || y0.depreciation < rf.ppe.v * 0.5))
    W("감가상각비", `현금흐름 감가상각비 ${fmt(y0.depreciation)}와 유형자산 변동표 ${fmt(rf.ppe.v)}가 크게 다름`);
  return { years, unitLabel: bs?.unitLabel ?? is?.unitLabel ?? "", sources, warnings, found: { bs: !!bs, is: !!is, cf: !!cf }, checks };
}

// ─── 도구용 조립 ──────────────────────────────────────────


export interface AuditFinResult {
  code: string | null; corp_code: string; name: string | null; fs: "CFS" | "OFS"; unitLabel: string; opinion: string | null;
  reports: { name: string; rcept_no: string; filed: string; period: string }[];
  years: (YearFin & { fiscalYear: string; source: string })[];
  interestBearingDebt: { total: number; lease: number; completeness: string; lines: { section: string; name: string; amount: number; category: string; source: string }[]; notes: string[]; checks: string[] } | null;
  netDebt: number | null;
  sources: Record<string, string>; warnings: string[];
  monthsSinceFiscalEnd: number;
  verification: Verification;
}

/** 기준일까지 접수된 최신 감사보고서(연결 우선)와, 3개 연도가 필요하면 그 전 해 감사보고서로 연도별 재무를 낸다 */
export async function getAuditFinancials(input: { stock_code?: string; corp_code?: string; valuation_date: string; years?: number }): Promise<AuditFinResult> {
  const corp = resolveCorp({ stock_code: input.stock_code, corp_code: input.corp_code });
  const until = input.valuation_date.replace(/-/g, "");
  const reps = await auditReportsUntil(corp.corp_code, until);
  if (!reps.length) throw new DartError(`${until} 까지 접수된 감사보고서 공시가 없습니다. 사업·반기·분기보고서를 내는 회사는 감사보고서가 정기보고서에 첨부되므로 dart_ebitda_inputs·valuation_get_data 를 쓰십시오.`, "NO_REPORT");
  const latest = reps[0];
  const sameKind = reps.filter(r => r.consolidated === latest.consolidated);
  const prevRep: AuditReport | undefined = (input.years ?? 3) >= 3 ? sameKind.find(r => r.periodEnd < latest.periodEnd) : undefined;
  const read = async (r: AuditReport) => {
    const files = await downloadDocument(r.rcept_no);
    for (const f of files) { const a = financialsFromAuditXml(f.xml); if (a.found.bs || a.found.is) return { a, xml: f.xml }; }
    return { a: financialsFromAuditXml(files[0]?.xml ?? ""), xml: files[0]?.xml ?? "" };
  };
  const [cur, prev] = await Promise.all([read(latest), prevRep ? read(prevRep) : Promise.resolve(null)]);
  const fy = (p: string, back: number) => `${Number(p.slice(0, 4)) - back}.${p.slice(4)}`;
  const years: AuditFinResult["years"] = [
    { ...cur.a.years[0], fiscalYear: fy(latest.periodEnd, 0), source: latest.report_nm },
    { ...cur.a.years[1], fiscalYear: fy(latest.periodEnd, 1), source: `${latest.report_nm} 전기 칸` },
  ];
  if (prev) years.push({ ...prev.a.years[1], fiscalYear: fy(prevRep!.periodEnd, 1), source: `${prevRep!.report_nm} 전기 칸` });
  // 전기 칸의 상각비는 현금흐름표에 행이 있을 때만 나온다 — 전 해 보고서의 당기 값으로 채운다
  if (prev && years[1].depreciationAmortization === null && prev.a.years[0].depreciationAmortization !== null) {
    const p0 = prev.a.years[0];
    Object.assign(years[1], { depreciation: p0.depreciation, amortization: p0.amortization, rightOfUseDepreciation: p0.rightOfUseDepreciation, investmentPropertyDepreciation: p0.investmentPropertyDepreciation, depreciationAmortization: p0.depreciationAmortization, ebitda: years[1].operatingIncome !== null && p0.depreciationAmortization !== null ? years[1].operatingIncome + p0.depreciationAmortization : null });
  }
  const d = debtFromAuditXml(cur.xml);
  const ibd = d.noBs ? null : {
    total: d.total, lease: d.lines.filter(l => l.category === "lease").reduce((a, l) => a + l.amount, 0), completeness: d.completeness,
    lines: d.lines.map(l => ({ section: l.section, name: l.name, amount: l.amount, category: l.category, source: l.source })), notes: d.notes, checks: d.checks,
  };
  const y0 = years[0];
  const netDebt = ibd && y0.cash !== null ? ibd.total - y0.cash - (y0.shortTermDeposits ?? 0) : null;
  const months = (Number(until.slice(0, 4)) - Number(latest.periodEnd.slice(0, 4))) * 12 + Number(until.slice(4, 6)) - Number(latest.periodEnd.slice(4));
  const warnings = [...cur.a.warnings, ...(prev ? prev.a.warnings.filter(w => !/감가상각비를/.test(w)).map(w => `[${prevRep!.report_nm}] ${w}`) : [])];
  const op = auditOpinion(cur.xml);
  if (op && op !== "적정") warnings.unshift(`감사의견 ${op} — 재무제표 금액을 그대로 믿기 어려움`);
  const checks: VerifyItem[] = [...cur.a.checks, ...(prev ? prev.a.checks.filter(c => !/전기/.test(c.item)).map(c => ({ ...c, item: `${years[2]?.fiscalYear ?? "전전기"} ${c.item}` })).filter(c => c.level === "verify") : [])];
  if (op && op !== "적정") checks.push({ level: "verify", item: "감사의견", message: `감사의견 ${op} — 재무제표 금액 자체를 그대로 믿기 어려움` });
  // 연도 연결: 올해 보고서의 전기 칸 = 작년 보고서의 당기 칸(다르면 재작성이거나 어느 한쪽 읽기 오류)
  if (prev) {
    const p0 = prev.a.years[0], y1 = years[1];
    for (const [k, label] of [["revenue", "매출"], ["operatingIncome", "영업이익"], ["netIncome", "당기순이익"], ["totalAssets", "자산총계"], ["totalEquity", "자본총계"]] as const) {
      const a = y1[k], b = p0[k];
      if (a !== null && b !== null && !near(a, b, 0.001)) checks.push({ level: Math.abs(a - b) > Math.max(Math.abs(b) * 0.05, 1e8) ? "verify" : "warn", item: `${label}(${y1.fiscalYear})`, message: `올해 보고서 전기 칸 ${Math.round(a).toLocaleString("ko-KR")} ≠ 작년 보고서 당기 칸 ${Math.round(b).toLocaleString("ko-KR")} — 전기 재작성이거나 표 읽기 오류` });
    }
  }
  if (months > 3) warnings.push(`결산일(${fy(latest.periodEnd, 0)}) 기준 값 — 평가기준일과 ${months}개월 차이. 반기 가결산 등 최근 자료가 있으면 그것을 우선`);
  return {
    code: corp.stock_code, corp_code: corp.corp_code, name: corp.corp_name ?? latest.corp_name, fs: latest.consolidated ? "CFS" : "OFS", unitLabel: cur.a.unitLabel, opinion: op,
    reports: [latest, ...(prevRep ? [prevRep] : [])].map(r => ({ name: r.report_nm, rcept_no: r.rcept_no, filed: r.rcept_dt, period: r.periodEnd })),
    years, interestBearingDebt: ibd, netDebt, sources: cur.a.sources, warnings, monthsSinceFiscalEnd: months,
    verification: summarize([...checks, ...(ibd ? ibdChecks(ibd, y0.totalLiabilities) : [])]),
  };
}

/** 이자부부채 검산: 부채총계를 넘으면 행 착오, 일부 미확인이면 원문 확인, 주석에서 읽은 행은 주의 */
export function ibdChecks(d: { total: number; completeness: string; lines: { name: string; amount: number; source: string }[]; checks: string[] }, totalLiabilities: number | null): VerifyItem[] {
  const out: VerifyItem[] = [];
  if (totalLiabilities !== null && d.total > totalLiabilities * 1.0005) out.push({ level: "verify", item: "이자부부채", message: `이자부부채 ${Math.round(d.total).toLocaleString("ko-KR")}가 부채총계 ${Math.round(totalLiabilities).toLocaleString("ko-KR")}보다 큼 — 행 착오` });
  if (d.completeness === "partial") out.push({ level: "verify", item: "이자부부채", message: "포괄 금융부채 안의 차입금을 확인하지 못함 — 차입 일부가 빠졌을 수 있음" });
  const noted = d.lines.filter(l => l.source === "주석");
  if (noted.length) out.push({ level: "warn", item: "이자부부채", message: `주석에서 읽은 행: ${noted.map(l => `${l.name} ${Math.round(l.amount).toLocaleString("ko-KR")}`).join(", ")}` });
  for (const c of d.checks) if (!/감사의견/.test(c)) out.push({ level: /찾지 못함/.test(c) ? "verify" : "warn", item: "이자부부채", message: c });
  return out;
}
