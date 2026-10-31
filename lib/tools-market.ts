/** 시세·공시 조회 도구 — beta_regression, naver_market_snapshot, dart_business_section */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { num, jsonArray, yyyymmdd, text, fail, defineTool } from "./common.js";
import { computeBeta, BETA_PERIODS, type BetaPeriod } from "./beta.js";
import { getMarketSnapshot } from "./naver.js";
import { resolveCorp, findAnnualReport, downloadDocumentWithInfo, extractBusinessSection } from "./dart.js";
import { cacheLine } from "./doc-cache.js";

const code6 = () => z.string().regex(/^[0-9A-Z]{6}$/, "종목코드 6자리");

const BetaSchema = z.object({
  stock_codes: jsonArray(code6()).describe("종목코드 6자리 배열(최대 10개)"),
  base_date: yyyymmdd().describe("평가기준일"),
  periods: jsonArray(z.enum(BETA_PERIODS as [BetaPeriod, ...BetaPeriod[]])).optional().describe("기본 Weekly-2Y, Monthly-5Y"),
  market_index: z.enum(["KOSPI", "KOSDAQ"]).optional().describe("회귀할 시장지수. 기본 KOSPI(코스닥 종목도 KOSPI 기준이 관례)"),
});

const SnapshotSchema = z.object({ stock_code: code6() });

const SectionSchema = z.object({
  stock_code: code6().optional().describe("종목코드 6자리 — corp_code·rcept_no 중 하나만 있어도 됨"),
  corp_code: z.string().regex(/^\d{8}$/).optional().describe("DART 고유번호 8자리(비상장사)"),
  year: z.string().regex(/^\d{4}$/).optional().describe("결산연도. 2025 = 보고서명이 '사업보고서 (2025.xx)'인 보고서"),
  rcept_no: z.string().regex(/^\d{14}$/).optional().describe("접수번호를 알면 직접 지정(year 대신)"),
  subsections: jsonArray(z.union([z.coerce.number().int(), z.string()])).optional()
    .describe("하위 항목만 받기 — 번호(1~7) 또는 제목 일부(예: '매출', '기타 참고사항'). 생략하면 장 전체"),
  max_chars: num().int().min(0).max(200000).optional().describe("한 번에 돌려줄 최대 글자수. 기본 30000, 0이면 상한 없이 전체(최대 200000)"),
  part: num().int().min(1).optional().describe("max_chars 로 잘렸을 때 이어 받을 쪽 번호(1부터)"),
});

export function registerMarketTools(server: McpServer): void {
  defineTool(server, "beta_regression", {
    title: "베타 회귀 (네이버 수정주가 기준)",
    description: `종목 수익률을 시장지수 수익률에 회귀(OLS)해 실질베타·조정베타·결정계수·표준오차를 계산합니다.
- 주간: 금요일 종가(휴장이면 목요일, 목·금 모두 휴장인 주는 제외), 기준일이 속한 진행 중인 주는 쓰지 않음
- 월간: 월 마지막 거래일 종가, 기준일이 속한 달은 기준일 종가
- 단순수익률, 조정베타 = 실질 × 2/3 + 1/3
이 관례는 비교 대상 서버(kr-valuation-data)의 compute_beta 와 2026-10-21 기준 30건 대조로 소수점 6자리까지 일치를 확인했습니다.
관측치가 요구치보다 적으면 경고하고, 절반 미만이면 계산하지 않습니다. 답변에는 기간·관측치 수·지수를 함께 적으십시오.`,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  }, BetaSchema, async (a: z.infer<typeof BetaSchema>) => {
    try {
      if (a.stock_codes.length > 10) throw new Error("종목은 한 번에 10개까지입니다.");
      const base = a.base_date.replace(/-/g, "");
      const periods = (a.periods?.length ? a.periods : ["Weekly-2Y", "Monthly-5Y"]) as BetaPeriod[];
      const r = await computeBeta(Array.from(new Set(a.stock_codes)), base, periods, a.market_index ?? "KOSPI");
      const lines = [`베타 회귀 — 기준일 ${base}, 지수 ${r.index}, 출처: 네이버 금융 수정주가`, "",
        "| 종목 | 기간 | 실질베타 | 조정베타 | R² | 표준오차 | 관측치 | 구간 |", "|---|---|---:|---:|---:|---:|---:|---|"];
      const notes: string[] = [];
      for (const o of r.out as any[]) {
        if (o.error) { notes.push(`- ${o.code}: ${o.error}`); continue; }
        if (o.note) notes.push(`- ${o.code}: ${o.note}`);
        for (const x of o.results) {
          lines.push(`| ${o.code} | ${x.period} | ${x.raw ?? "-"} | ${x.adjusted ?? "-"} | ${x.rSquared ?? "-"} | ${x.standardError ?? "-"} | ${x.dataPoints}/${x.required} | ${x.window.from ?? "-"}~${x.window.to ?? "-"} |`);
          for (const w of x.warnings) notes.push(`- ${o.code} ${x.period}: ${w}`);
        }
      }
      if (notes.length) lines.push("", "유의:", ...notes);
      return { ...text(lines.join("\n")), structuredContent: r as unknown as Record<string, unknown> };
    } catch (e) { return fail(e); }
  });

  defineTool(server, "naver_market_snapshot", {
    title: "네이버 금융 종목 종합정보(당일)",
    description: `네이버 금융의 당일 지표 — 전일·당일 시세, 시가총액, PER·EPS·추정PER·추정EPS·PBR·BPS, 배당수익률·주당배당금, 52주 최고·최저, 외국인소진율,
컨센서스(목표주가 평균·투자의견 평균과 작성일), 네이버 동종업종 비교 종목(종가·시가총액)을 돌려줍니다.
과거 기준일 값이 아니라 조회 시점 값입니다(평가기준일 시가총액이 필요하면 다른 도구를 쓰십시오).
표시 문자열과 숫자 변환값을 함께 주므로, 숫자를 인용할 때는 표시 문자열과 맞는지 보십시오.
동종업종 목록은 네이버 업종 분류(KSIC 아님)라 피어 모집단으로 그대로 쓰지 마십시오.`,
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, SnapshotSchema, async (a: z.infer<typeof SnapshotSchema>) => {
    try {
      const s = await getMarketSnapshot(a.stock_code);
      const lines = [`${s.name}(${s.code}) — 네이버 금융, 조회 ${s.fetchedAt}`, "", "| 항목 | 값 |", "|---|---:|",
        ...s.indicators.map(i => `| ${i.label} | ${i.display} |`)];
      if (s.consensus) lines.push("", `컨센서스(${s.consensus.asOf ?? "작성일 미상"}): 목표주가 평균 ${s.consensus.targetPriceMean?.toLocaleString("ko-KR") ?? "-"}원, 투자의견 평균 ${s.consensus.recommendationMean ?? "-"}(5점 척도)`);
      if (s.industryPeers.length) lines.push("", `네이버 동종업종(업종코드 ${s.industryCode ?? "-"}):`, "| 종목 | 시장 | 종가 | 시가총액(백만원) |", "|---|---|---:|---:|",
        ...s.industryPeers.map(p => `| ${p.name}(${p.code}) | ${p.market ?? "-"} | ${p.closePrice?.toLocaleString("ko-KR") ?? "-"} | ${p.marketValueMillion?.toLocaleString("ko-KR") ?? "-"} |`));
      return { ...text(lines.join("\n")), structuredContent: s as unknown as Record<string, unknown> };
    } catch (e) { return fail(e); }
  });

  defineTool(server, "dart_business_section", {
    title: "사업보고서 'II. 사업의 내용' 전체 추출",
    description: `DART 사업보고서 원본에서 "II. 사업의 내용" 장을 통째로(사업의 개요·주요 제품 및 서비스·원재료 및 생산설비·매출 및 수주상황·위험관리·주요계약 및 연구개발·기타 참고사항) 마크다운으로 돌려줍니다. 표는 마크다운 표로 변환합니다.
- 장 경계는 DART 구조코드로 자르므로 하위 항목이 빠지지 않습니다. subsections 로 일부만 받을 수 있습니다.
- 받은 원본은 서버에 접수번호 단위로 24시간 보관됩니다. 그 보고서의 첫 호출만 DART 원본을 받느라 30~60초가 걸리고(대형 보고서는 더 걸릴 수 있음, 정상), 같은 보고서를 다시 부르면(다른 하위 항목·다음 쪽) 보관본으로 빠르게 응답합니다. 응답의 "원문:" 줄에 보관본 사용 여부가 표시됩니다.
- 길면 max_chars 에서 잘리고 응답 끝에 이어 받을 part 번호를 알려 줍니다. 잘렸는데 "없다"고 결론짓지 마십시오.
- 재무제표 주석(차입금·전환사채 잔액 등)은 이 장에 없습니다.`,
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, SectionSchema, async (a: z.infer<typeof SectionSchema>) => {
    try {
      let rcept = a.rcept_no, reportName = "(접수번호 직접 지정)", corpName: string | null = null, filed: string | null = null;
      if (!rcept) {
        if (!a.year) throw new Error("year(결산연도) 또는 rcept_no 가 필요합니다.");
        const corp = resolveCorp({ stock_code: a.stock_code, corp_code: a.corp_code });
        const rep = await findAnnualReport(corp.corp_code, a.year);
        rcept = rep.rcept_no; reportName = rep.report_nm; corpName = rep.corp_name; filed = rep.rcept_dt;
      }
      const { files, cache, ms } = await downloadDocumentWithInfo(rcept);
      const sec = extractBusinessSection(files);
      let subs = sec.subsections;
      if (a.subsections?.length) {
        const want = a.subsections;
        subs = subs.filter(s => want.some(w => (typeof w === "number" ? s.index === w : s.title.replace(/\s/g, "").includes(String(w).replace(/\s/g, "")))));
        if (!subs.length) throw new Error(`요청한 하위 항목을 찾지 못했습니다. 있는 항목: ${sec.subsections.map(s => `${s.index}. ${s.title}`).join(" / ")}`);
      }
      const full = subs.map(s => `## ${s.title}\n\n${s.markdown}`).join("\n\n");
      const max = a.max_chars === 0 ? 200000 : (a.max_chars ?? 30000);
      const parts = Math.max(1, Math.ceil(full.length / max));
      const part = Math.min(a.part ?? 1, parts);
      const chunk = full.slice((part - 1) * max, part * max);
      const head = [
        `${corpName ?? ""} ${reportName} (접수번호 ${rcept}${filed ? `, 접수일 ${filed}` : ""}) — II. 사업의 내용`,
        `추출: ${sec.method}, 전체 ${full.length.toLocaleString("ko-KR")}자${parts > 1 ? `, ${parts}쪽 중 ${part}쪽` : ""}`,
        cacheLine(cache, ms),
        `하위 항목: ${sec.subsections.map(s => `${s.index}. ${s.title}(${s.chars.toLocaleString("ko-KR")}자)`).join(" / ")}`,
        "", "---", "",
      ];
      const tail = part < parts ? [``, `---`, `**잘림** — ${parts}쪽 중 ${part}쪽입니다. 이어서 받으려면 같은 인자에 part=${part + 1} 을 주십시오.`] : [];
      return {
        ...text(head.join("\n") + chunk + tail.join("\n")),
        structuredContent: { rcept_no: rcept, report: reportName, corp_name: corpName, filed, method: sec.method, total_chars: full.length, part, parts, truncated: part < parts, subsections: sec.subsections.map(s => ({ index: s.index, title: s.title, chars: s.chars })) },
      };
    } catch (e) { return fail(e); }
  });
}
