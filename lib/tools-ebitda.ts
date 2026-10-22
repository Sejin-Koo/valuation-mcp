import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonArray, yyyymmdd, text, fail, defineTool } from "./common.js";
import { getEbitdaInputs, type EbitdaResult } from "./ebitda.js";

const EbitdaSchema = z.object({
  stock_codes: jsonArray(z.string().regex(/^[0-9A-Z]{6}$/)).optional().describe("종목코드 6자리 배열(최대 5개). 비상장사는 corp_code"),
  corp_code: z.string().regex(/^\d{8}$/).optional().describe("DART 고유번호 8자리(stock_codes 대신, 1개사)"),
  valuation_date: yyyymmdd().optional().describe("평가기준일 — 이 날까지 접수된 최신 정기보고서를 쓴다(valuation_get_data 와 같은 규칙)"),
  year: z.string().regex(/^\d{4}$/).optional().describe("결산연도의 사업보고서 연간 값(valuation_date 대신). '사업보고서 (2025.12)' → 2025"),
  basis: z.enum(["ttm", "annual", "latest"]).optional()
    .describe("ttm(기본): 최근 12개월 = 직전 사업연도 + 당기 누적 − 전년 동기 누적. annual: 기준일 전 최신 사업보고서. latest: 최신 보고서 누적 그대로"),
});

const won = (v: number | null) => (v === null ? "—" : Math.round(v).toLocaleString("ko-KR"));

function render(r: EbitdaResult): string {
  const L: string[] = [];
  L.push(`### ${r.name ?? r.corp_code}${r.code ? ` (${r.code})` : ""} — ${r.basis === "ttm" && r.parts.length === 3 ? "최근 12개월(TTM)" : `${r.months}개월`} · ${r.fs === "CFS" ? "연결" : "별도"}${r.currency && r.currency !== "KRW" ? ` · 통화 ${r.currency}` : ""}`);
  L.push(`보고서: ${r.reports.map(x => `${x.name}(${x.rcept_no}, 접수 ${x.filed})`).join(" / ")}`);
  L.push("");
  L.push(`| 구분 | 기간 | 매출 | 영업이익 | 감가상각비 | 지배주주순이익 |`);
  L.push(`|---|---|---:|---:|---:|---:|`);
  for (const p of r.parts) L.push(`| ${p.label} | ${p.period} | ${won(p.revenue)} | ${won(p.operatingIncome)} | ${won(p.depreciationAmortization)} | ${won(p.netIncomeParent)} |`);
  if (r.parts.length > 1) L.push(`| **결과** | ${r.months}개월 | ${won(r.revenue)} | ${won(r.operatingIncome)} | ${won(r.depreciationAmortization)} | ${won(r.netIncomeParent)} |`);
  L.push("");
  L.push(`- EBITDA(영업이익 + 감가상각비): **${won(r.ebitda)}**${r.depreciationAmortizationExclRightOfUse !== null && r.depreciationAmortizationExclRightOfUse !== r.depreciationAmortization ? ` · 사용권자산 상각 제외 시 감가상각비 ${won(r.depreciationAmortizationExclRightOfUse)}` : ""}`);
  if (r.daComponents.length) {
    L.push("", "감가상각비 구성:", "", "| 구분 | 항목 | 금액 | 처리 | 태그 |", "|---|---|---:|---|---|");
    for (const c of r.daComponents) L.push(`| ${c.part} | ${c.item} | ${won(c.value)} | ${c.treatment} | ${c.tag} |`);
  }
  if (r.notesExcerpts.length) {
    L.push("", "원문 주석 발췌(감가상각비가 든 표 행 — 금액을 직접 확인):");
    for (const e of r.notesExcerpts) { L.push("", `**${e.report} · ${e.heading}**`, "", ...e.rows); }
  }
  if (r.warnings.length) L.push("", ...r.warnings.map(w => `- ⚠ ${w}`));
  return L.join("\n");
}

export function registerEbitdaTools(server: McpServer): void {
  defineTool(server, "dart_ebitda_inputs", {
    title: "EBITDA 입력값 (감가상각비·영업이익·매출·순이익, 연간/TTM)",
    description: `DART 정기보고서 XBRL 원본에서 감가상각비(유형자산·사용권자산·무형자산·투자부동산)와 영업이익·매출·지배주주순이익을 뽑아 연간 또는 최근 12개월(TTM)로 돌려줍니다.
- 보고서는 평가기준일까지 접수된 최신 정기보고서(valuation_get_data 와 같은 규칙). TTM = 직전 사업연도 + 당기 누적 − 전년 동기 누적.
- 결과의 peerRow 를 peer_statistics 의 피어 행에 덮어쓰면(revenue·operatingIncome·netIncomeParent·depreciationAmortization·incomeMonths=12) 반기·분기 기준일에도 EV/EBITDA·EV/EBIT·PER 를 계산할 수 있습니다.
- 사용권자산 상각을 감가상각비에 넣는 것이 기본입니다(리스부채를 순차입금에 넣은 경우와 일관). 리스부채를 뺐다면 depreciationAmortizationExclRightOfUse 를 쓰십시오.
- 주석 XBRL 공시 대상이 아닌 소형사는 감가상각 태그가 없습니다. 그때는 원문 주석에서 감가상각비가 든 표 행을 발췌해 주고 EBITDA 는 계산하지 않습니다 — 발췌를 보고 금액을 확인하십시오.
- 종목당 XBRL 1~2건을 DART 에서 받아 30~90초 걸립니다(정상). 원문 주석까지 받으면 더 걸립니다.`,
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, EbitdaSchema, async (a: z.infer<typeof EbitdaSchema>) => {
    try {
      if (!a.stock_codes?.length && !a.corp_code) throw new Error("stock_codes 또는 corp_code 가 필요합니다.");
      if (!a.valuation_date && !a.year) throw new Error("valuation_date(평가기준일) 또는 year(결산연도)가 필요합니다.");
      const codes = a.stock_codes ?? [];
      if (codes.length > 5) throw new Error("한 번에 5종목까지입니다(DART XBRL 내려받기 시간 때문). 나눠서 호출하십시오.");
      const deadline = Date.now() + 270_000;
      const targets: { stock_code?: string; corp_code?: string }[] = codes.length ? codes.map(c => ({ stock_code: c })) : [{ corp_code: a.corp_code }];
      const results = await Promise.all(targets.map(t => getEbitdaInputs({ ...t, valuation_date: a.valuation_date, year: a.year, basis: a.basis, deadline })
        .then(r => ({ ok: true as const, r }), (e: Error) => ({ ok: false as const, id: t.stock_code ?? t.corp_code, e: e.message }))));
      const body = results.map(x => (x.ok ? render(x.r) : `### ${x.id}\n\n오류: ${x.e}`)).join("\n\n---\n\n");
      return {
        ...text(`EBITDA 입력값 — 출처: DART 정기보고서 XBRL 원본${a.valuation_date ? `, 평가기준일 ${a.valuation_date}` : ""}\n\n${body}`),
        structuredContent: { results: results.map(x => (x.ok ? x.r : { error: x.e, id: x.id })) },
      };
    } catch (e) { return fail(e); }
  });
}
