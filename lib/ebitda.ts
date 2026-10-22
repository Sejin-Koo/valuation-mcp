/**
 * EBITDA 입력값(감가상각비·영업이익·매출·지배주주순이익)을 연간 또는 최근 12개월(TTM)로 만든다.
 *
 * - 보고서 선택은 외부 valuation_get_data 와 같은 규칙이다: 평가기준일까지 접수된 최신 정기보고서.
 * - TTM = 직전 사업보고서 연간 + 당기 누적 − 전년 동기 누적(전년 동기는 당기 보고서의 비교 표시 금액).
 * - XBRL 에 감가상각 태그가 없으면(주석 XBRL 미의무 소형사) 원문 주석에서 감가상각비가 든 표 행을 발췌해
 *   돌려준다. 숫자를 자동으로 고르지 않는다 — 회사마다 실린 주석이 달라(실측 8곳 중 비용의 성격별 4,
 *   현금흐름 4, 유형자산 변동표·판관비에만 3) 자동 선택은 틀릴 위험이 크다.
 */
import { DartError, resolveCorp, downloadDocument, toMarkdown } from "./dart.js";
import {
  periodicReportsUntil, reprtCode, downloadXbrl, parseFacts, cumulativePeriod, computeDa, computeFlows, currencyOf, isoEnd,
  type PeriodicReport, type Fact, type Period, type DaResult, type Flows,
} from "./xbrl.js";

export type Basis = "ttm" | "annual" | "latest";

interface PartResult {
  label: string; report: PeriodicReport; period: Period; da: DaResult | null; flows: Flows; sign: 1 | -1;
}

export interface EbitdaResult {
  code: string | null; corp_code: string; name: string | null;
  basis: Basis; fs: "CFS" | "OFS"; currency: string | null; months: number | null;
  reports: { role: string; name: string; rcept_no: string; filed: string }[];
  parts: { label: string; period: string; months: number; depreciationAmortization: number | null; operatingIncome: number | null; revenue: number | null; netIncomeParent: number | null }[];
  depreciationAmortization: number | null;
  depreciationAmortizationExclRightOfUse: number | null;
  operatingIncome: number | null; revenue: number | null; netIncomeParent: number | null;
  ebitda: number | null;
  daComponents: { part: string; item: string; value: number; tag: string; treatment: string }[];
  notesExcerpts: { report: string; heading: string; rows: string[] }[];
  warnings: string[];
  peerRow: Record<string, unknown> | null;
}

const yyyymmdd = (s: string) => s.replace(/-/g, "");

/** 원문 주석에서 감가상각비가 든 표 행 발췌 */
export function noteExcerpts(markdown: string, max = 14): { heading: string; rows: string[] }[] {
  const lines = markdown.split("\n");
  const blocks: { heading: string; header: string; rows: string[]; prio: number }[] = [];
  let heading = "", header = "", unit = "", inTable = false, cur: { heading: string; header: string; rows: string[]; prio: number } | null = null;
  const DA = /(감가상각비|무형자산상각|사용권자산\s*상각|사용권자산\s*감가상각|상각비)/;
  const SKIP = /(누계액|대손|상각후원가|내용연수|상각방법|감가상각방법|환입)/;
  for (const l of lines) {
    if (l.startsWith("|")) {
      if (!inTable) {
        header = l; inTable = true; cur = null;
        const um = l.match(/단위\s*[:：]\s*([^)|\s]+)/); if (um) unit = `(단위: ${um[1]})`;
        continue;
      }
      if (/^\|\s*-{3}/.test(l)) continue;
      if (DA.test(l) && !SKIP.test(l)) {
        if (!cur) {
          const prio = /비용의\s*성격|성격별/.test(heading) ? 3 : /현금흐름|영업활동|영업에서|영업으로부터/.test(heading) ? 2 : /판매비|관리비/.test(heading) ? 1 : 0;
          cur = { heading: unit ? `${heading} ${unit}` : heading, header, rows: [], prio }; blocks.push(cur);
        }
        cur.rows.push(l.length > 300 ? l.slice(0, 300) + "…" : l);
      }
    } else {
      inTable = false; cur = null;
      const um = l.match(/\(?\s*단위\s*[:：]\s*([^)\s]+)\s*\)?/);
      if (um) unit = `(단위: ${um[1]})`;
      const t = l.replace(/^#+\s*/, "").trim();
      if (t && t.length <= 80 && (/^#/.test(l) || /^\(?\d{1,2}(-\d{1,2})?\)?[.)]?\s*\S/.test(t))) { heading = t; if (!um) unit = ""; }
    }
  }
  blocks.sort((a, b) => b.prio - a.prio);
  return blocks.slice(0, max).map(b => ({ heading: b.heading || "(제목 없음)", rows: [b.header, ...b.rows.slice(0, 6)] }));
}

function sumNullable(parts: PartResult[], f: (p: PartResult) => number | null): number | null {
  let s = 0;
  for (const p of parts) { const v = f(p); if (v === null) return null; s += p.sign * v; }
  return s;
}

export async function getEbitdaInputs(input: { stock_code?: string; corp_code?: string; valuation_date?: string; year?: string; basis?: Basis; deadline: number }): Promise<EbitdaResult> {
  const corp = resolveCorp({ stock_code: input.stock_code, corp_code: input.corp_code });
  const warnings: string[] = [];
  const basis: Basis = input.basis ?? (input.year ? "annual" : "ttm");
  const until = input.valuation_date ? yyyymmdd(input.valuation_date) : input.year ? `${Number(input.year) + 1}1231` : new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const all = await periodicReportsUntil(corp.corp_code, until);
  if (!all.length) throw new DartError(`${until} 까지 접수된 정기보고서가 없습니다.`, "NO_REPORT");
  const annuals = all.filter(r => r.kind === "annual");
  const fyEndMonth = annuals.length ? Number(annuals[0].periodEnd.slice(4)) : 12;

  let target: PeriodicReport | undefined;
  if (input.year) target = annuals.find(r => r.periodEnd.startsWith(input.year!));
  else if (basis === "annual") target = annuals[0];
  else target = all[0];
  if (!target) throw new DartError(input.year ? `${input.year} 결산 사업보고서가 없습니다.` : "사업보고서가 없습니다.", "NO_REPORT");

  const cache = new Map<string, Promise<Fact[]>>();
  const factsOf = (r: PeriodicReport) => {
    if (!cache.has(r.rcept_no)) cache.set(r.rcept_no, downloadXbrl(r.rcept_no, reprtCode(r, fyEndMonth), input.deadline).then(parseFacts));
    return cache.get(r.rcept_no)!;
  };

  type Need = { label: string; report: PeriodicReport; end: string; sign: 1 | -1 };
  const needs: Need[] = [{ label: target.kind === "annual" ? "연간" : "당기 누적", report: target, end: isoEnd(target.periodEnd), sign: 1 }];
  if (basis === "ttm" && target.kind !== "annual") {
    const prevAnnual = annuals.find(r => r.periodEnd < target!.periodEnd);
    if (!prevAnnual) warnings.push("직전 사업보고서가 없어 TTM 을 만들지 못하고 당기 누적만 돌려줍니다.");
    else {
      const prevYtdEnd = isoEnd(`${Number(target.periodEnd.slice(0, 4)) - 1}${target.periodEnd.slice(4)}`);
      needs.unshift({ label: "직전 사업연도", report: prevAnnual, end: isoEnd(prevAnnual.periodEnd), sign: 1 });
      needs.push({ label: "전년 동기 누적", report: target, end: prevYtdEnd, sign: -1 });
    }
  }

  // 내려받기는 병렬로
  const factLists = await Promise.all(needs.map(n => factsOf(n.report)));
  const periods = needs.map((n, i) => cumulativePeriod(factLists[i], n.end));
  periods.forEach((p, i) => { if (!p) throw new DartError(`${needs[i].report.report_nm} XBRL 에서 ${needs[i].end} 로 끝나는 손익 기간을 찾지 못했습니다.`, "NO_PERIOD"); });

  // 연결 우선 — 대상 보고서 당기에 연결 영업이익이 있으면 연결
  const hasC = factLists[needs.length === 3 ? 1 : 0].some(f => f.scope === "C" && f.tag === "OperatingIncomeLoss" && f.end === needs[needs.length === 3 ? 1 : 0].end);
  const scope: Fact["scope"] = hasC ? "C" : "S";
  if (!hasC) warnings.push("연결재무제표가 없어 별도재무제표 값입니다.");

  const parts: PartResult[] = needs.map((n, i) => ({
    label: n.label, report: n.report, period: periods[i]!, sign: n.sign,
    da: computeDa(factLists[i], scope, periods[i]!), flows: computeFlows(factLists[i], scope, periods[i]!),
  }));
  const currency = currencyOf(factLists[0], scope, periods[0]!);
  if (currency && currency !== "KRW") warnings.push(`보고 통화가 ${currency} 입니다 — 원화 시가총액과 섞기 전에 환산하십시오.`);

  const months = parts.length === 3 ? 12 : parts[0].period.months;
  if (parts.length === 3) {
    const [a, c, p] = parts.map(x => x.period);
    if (a.months !== 12) warnings.push(`직전 사업연도가 ${a.months}개월입니다(결산기 변경 등) — TTM 이 12개월이 아닐 수 있습니다.`);
    if (c.months !== p.months) warnings.push(`당기 누적(${c.months}개월)과 전년 동기 누적(${p.months}개월)의 기간이 다릅니다.`);
  }

  const daTotal = sumNullable(parts, p => p.da?.total ?? null);
  const daExcl = sumNullable(parts, p => p.da?.totalExclRightOfUse ?? null);
  const oi = sumNullable(parts, p => p.flows.operatingIncome?.value ?? null);
  const rev = sumNullable(parts, p => p.flows.revenue?.value ?? null);
  const ni = sumNullable(parts, p => p.flows.netIncomeParent?.value ?? null);
  for (const p of parts) for (const n of p.da?.notes ?? []) warnings.push(`[${p.label}] ${n}`);
  if (oi === null) warnings.push("영업이익 태그(OperatingIncomeLoss)를 찾지 못한 기간이 있습니다.");
  if (rev === null) warnings.push("매출 태그를 찾지 못한 기간이 있습니다(업종별 매출 계정명이 다를 수 있음).");

  // 감가상각 태그가 없는 기간 → 원문 주석 발췌
  const notesExcerpts: EbitdaResult["notesExcerpts"] = [];
  const missing = Array.from(new Map(parts.filter(p => !p.da).map(p => [p.report.rcept_no, p.report])).values());
  if (missing.length) {
    warnings.push(`XBRL 에 감가상각비 태그가 없습니다(${missing.map(r => r.report_nm).join(", ")}) — 주석 XBRL 공시 대상이 아닌 회사일 수 있습니다. 아래 원문 주석 발췌에서 금액을 확인하십시오. EBITDA 는 계산하지 않았습니다.`);
    for (const r of missing) {
      if (input.deadline - Date.now() < 60_000) { warnings.push(`시간이 부족해 ${r.report_nm} 원문 주석은 받지 못했습니다 — 이 종목만 다시 호출하십시오.`); continue; }
      try {
        const files = await downloadDocument(r.rcept_no);
        const main = [...files].sort((a, b) => Number(/_\d+\.xml$/i.test(a.name)) - Number(/_\d+\.xml$/i.test(b.name)))[0];
        for (const ex of noteExcerpts(toMarkdown(main.xml))) notesExcerpts.push({ report: r.report_nm, ...ex });
        if (!notesExcerpts.some(e => e.report === r.report_nm)) warnings.push(`${r.report_nm} 원문에서도 감가상각비 표 행을 찾지 못했습니다.`);
      } catch (e) { warnings.push(`${r.report_nm} 원문 주석 내려받기 실패: ${(e as Error).message}`); }
    }
  }

  const ebitda = daTotal !== null && oi !== null ? oi + daTotal : null;
  const reportList = Array.from(new Map(parts.map(p => [p.report.rcept_no, p])).values()).map(p => ({ role: p.label === "직전 사업연도" ? "직전 사업연도" : "대상 보고서", name: p.report.report_nm, rcept_no: p.report.rcept_no, filed: p.report.rcept_dt }));
  return {
    code: corp.stock_code, corp_code: corp.corp_code, name: corp.corp_name ?? target.corp_name,
    basis, fs: scope === "C" ? "CFS" : "OFS", currency, months,
    reports: reportList,
    parts: parts.map(p => ({ label: p.label, period: `${yyyymmdd(p.period.start)}~${yyyymmdd(p.period.end)}`, months: p.period.months, depreciationAmortization: p.da?.total ?? null, operatingIncome: p.flows.operatingIncome?.value ?? null, revenue: p.flows.revenue?.value ?? null, netIncomeParent: p.flows.netIncomeParent?.value ?? null })),
    depreciationAmortization: daTotal, depreciationAmortizationExclRightOfUse: daExcl,
    operatingIncome: oi, revenue: rev, netIncomeParent: ni, ebitda,
    daComponents: parts.flatMap(p => (p.da?.components ?? []).map(c => ({ part: p.label, ...c }))),
    notesExcerpts, warnings,
    peerRow: corp.stock_code ? {
      code: corp.stock_code, revenue: rev, operatingIncome: oi, netIncomeParent: ni, depreciationAmortization: daTotal,
      incomeMonths: months, report: parts.length === 3 ? `TTM(${reportList.map(r => r.name).join(" + ")})` : target.report_nm,
    } : null,
  };
}
