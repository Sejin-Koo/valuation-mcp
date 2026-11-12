import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { yyyymmdd, text, fail, defineTool } from "./common.js";
import { getAuditFinancials, type AuditFinResult } from "./audit-fin.js";
import { renderVerification } from "./verify.js";

const Schema = z.object({
  corp_code: z.string().regex(/^\d{8}$/).describe("DART 고유번호 8자리(dart_search_corp_code 로 확인)"),
  valuation_date: yyyymmdd().optional().describe("평가기준일 — 이 날까지 접수된 최신 감사보고서(연결 우선)를 쓴다. 비우면 오늘(한국시간) — 가치평가가 아니라 최신 감사보고서 실적만 볼 때"),
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
  L.push("", ...renderVerification(r.verification));
  const extra = r.warnings.filter(w => /결산일/.test(w));
  if (extra.length) L.push("", ...extra.map(w => `- ⚠ ${w}`));
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
- verification(검증): 표 안의 합계 관계(자산=부채+자본, 유동+비유동, 매출−매출원가=매출총이익, 세전이익−법인세=순이익), 올해 보고서 전기 칸 = 작년 보고서 당기 칸, 이자부부채 ≤ 부채총계를 스스로 검산해 '확인됨'·'주의'·'원문 확인 필요'로 표시합니다. 답변에는 '원문 확인 필요' 항목만 원문 위치와 함께 알리고, 확인됨이면 따로 언급하지 않습니다. 주석·변동표에서 읽은 값은 검산으로 잡히지 않아 늘 '주의'입니다.
- 상장사·사업보고서 제출 비상장사는 정기보고서에 감사보고서가 첨부되므로 이 도구가 아니라 dart_ebitda_inputs·valuation_get_data 를 씁니다.`,
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, Schema, async (a: z.infer<typeof Schema>) => {
    try {
      // 기업분석처럼 평가기준일 없이 '최신 감사보고서'만 보려는 호출이 필수 인자 누락으로 실패했다(2026-11-12) → 비우면 오늘(한국시간)
      const vd = a.valuation_date || new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
      const r = await getAuditFinancials({ corp_code: a.corp_code, valuation_date: vd, years: a.years });
      const head = a.valuation_date ? `평가기준일 ${vd}` : `기준일 ${vd}(지정하지 않아 오늘 — 가장 최근 접수된 감사보고서)`;
      return { ...text(`감사보고서 재무 요약 — 출처: DART 감사보고서 원문, ${head}\n\n${render(r)}`), structuredContent: r as unknown as Record<string, unknown> };
    } catch (e) { return fail(e); }
  });
}
