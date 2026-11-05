import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { yyyymmdd, text, fail, defineTool } from "./common.js";
import { getAuditFinancials, type AuditFinResult } from "./audit-fin.js";

const Schema = z.object({
  corp_code: z.string().regex(/^\d{8}$/).describe("DART 고유번호 8자리(dart_search_corp_code 로 확인)"),
  valuation_date: yyyymmdd().describe("평가기준일 — 이 날까지 접수된 최신 감사보고서(연결 우선)를 쓴다"),
  years: z.number().int().min(2).max(3).optional().describe("연도 수. 3(기본)이면 그 전 해 감사보고서도 받아 3개 연도"),
});

const won = (v: number | null | undefined) => (v === null || v === undefined ? "—" : Math.round(v).toLocaleString("ko-KR"));
const ROWS: [string, keyof AuditFinResult["years"][number]][] = [
  ["매출", "revenue"], ["영업이익", "operatingIncome"], ["감가상각비(유형)", "depreciation"], ["무형자산상각비", "amortization"],
  ["사용권자산상각비", "rightOfUseDepreciation"], ["투자부동산상각비", "investmentPropertyDepreciation"], ["감가상각비 합계", "depreciationAmortization"], ["EBITDA", "ebitda"],
  ["법인세차감전이익", "pretaxIncome"], ["당기순이익", "netIncome"], ["지배주주순이익", "netIncomeParent"],
  ["영업활동현금흐름", "operatingCashFlow"], ["유형자산 취득", "capexTangible"], ["무형자산 취득", "capexIntangible"],
  ["현금및현금성자산", "cash"], ["단기금융상품", "shortTermDeposits"], ["매출채권", "receivables"], ["재고자산", "inventories"], ["매입채무", "payables"],
  ["자산총계", "totalAssets"], ["부채총계", "totalLiabilities"], ["자본총계", "totalEquity"], ["지배기업소유주지분", "equityParent"], ["비지배지분", "nci"],
];

function render(r: AuditFinResult): string {
  const L: string[] = [];
  L.push(`### ${r.name ?? r.corp_code} — ${r.fs === "CFS" ? "연결" : "별도"} · 감사의견 ${r.opinion ?? "확인 못 함"} · 원문 단위 ${r.unitLabel || "?"}`);
  L.push(`보고서: ${r.reports.map(x => `${x.name}(${x.rcept_no}, 접수 ${x.filed})`).join(" / ")}`, "");
  L.push(`| 항목(원) | ${r.years.map(y => y.fiscalYear).join(" | ")} |`, `|---|${r.years.map(() => "---:").join("|")}|`);
  for (const [label, k] of ROWS) if (r.years.some(y => y[k] !== null)) L.push(`| ${label} | ${r.years.map(y => won(y[k] as number | null)).join(" | ")} |`);
  if (r.interestBearingDebt) {
    const d = r.interestBearingDebt;
    L.push("", `이자부부채(${r.years[0].fiscalYear}): **${won(d.total)}원**${d.lease ? ` (리스부채 ${won(d.lease)} 포함)` : ""}${d.completeness === "partial" ? " — 일부 누락 가능" : ""} · 순차입금(이자부부채 − 현금 − 단기금융상품) **${won(r.netDebt)}원**`);
    if (d.lines.length) L.push(`- 구성: ${d.lines.map(l => `${l.name} ${won(l.amount)}`).join(", ")}`);
    for (const n of d.notes) L.push(`- 참고: ${n}`);
    for (const c of d.checks) L.push(`- ⚠ ${c}`);
  }
  const src = Object.entries(r.sources).map(([k, v]) => `${k} ← ${v}`);
  if (src.length) L.push("", `읽은 행: ${src.join(" · ")}`);
  if (r.warnings.length) L.push("", ...r.warnings.map(w => `- ⚠ ${w}`));
  return L.join("\n");
}

export function registerAuditTools(server: McpServer): void {
  defineTool(server, "dart_audit_financials", {
    title: "감사보고서 재무 요약 (비상장 외감법인 가치평가 입력값)",
    description: `사업·반기·분기보고서가 없는 비상장 외감법인의 감사보고서 원문 표에서 가치평가 입력값을 읽어 연도별로 돌려줍니다.
- 손익: 매출·영업이익·법인세차감전이익·당기순이익·지배주주순이익 / 상각: 유형·무형·사용권자산·투자부동산(현금흐름표 → 현금흐름 주석 → 자산 변동표 순), EBITDA / 현금흐름: 영업활동현금흐름·유형·무형자산 취득 / 재무상태: 현금·단기금융상품·매출채권·재고·매입채무·자산·부채·자본·지배기업소유주지분·비지배지분.
- 기준일까지 접수된 최신 감사보고서(연결 우선)의 당기·전기 칸, years=3 이면 그 전 해 감사보고서의 전기 칸까지 3개 연도. 이자부부채(dart_interest_bearing_debt 와 같은 규칙)와 순차입금도 함께 줍니다.
- 감사보고서는 결산기 1회라 평가기준일과의 개월 차이를 경고로 알립니다. 감사의견이 적정이 아니면 경고합니다.
- 사용권자산 상각이 감가상각비에 들어 있는지 판정하지 못하면 더하지 않고 경고합니다(리스부채를 순차입금에 넣었다면 원문 확인). '읽은 행'으로 어느 표·행에서 읽었는지 확인할 수 있습니다.
- 상장사·사업보고서 제출 비상장사는 정기보고서에 감사보고서가 첨부되므로 이 도구가 아니라 dart_ebitda_inputs·valuation_get_data 를 씁니다.`,
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, Schema, async (a: z.infer<typeof Schema>) => {
    try {
      const r = await getAuditFinancials({ corp_code: a.corp_code, valuation_date: a.valuation_date, years: a.years });
      return { ...text(`감사보고서 재무 요약 — 출처: DART 감사보고서 원문, 평가기준일 ${a.valuation_date}\n\n${render(r)}`), structuredContent: r as unknown as Record<string, unknown> };
    } catch (e) { return fail(e); }
  });
}
