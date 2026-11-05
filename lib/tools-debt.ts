import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonArray, yyyymmdd, text, fail, defineTool } from "./common.js";
import { getInterestBearingDebt, type DebtResult } from "./debt.js";

const DebtSchema = z.object({
  stock_codes: jsonArray(z.string().regex(/^[0-9A-Z]{6}$/)).optional().describe("종목코드 6자리 배열(최대 10개). 비상장사는 corp_code"),
  corp_code: z.string().regex(/^\d{8}$/).optional().describe("DART 고유번호 8자리(stock_codes 대신, 1개사)"),
  valuation_date: yyyymmdd().describe("평가기준일 — 이 날까지 접수된 최신 정기보고서를 쓴다(valuation_get_data 와 같은 규칙)"),
});

const won = (v: number) => Math.round(v).toLocaleString("ko-KR");
const SEC: Record<string, string> = { current: "유동", nonCurrent: "비유동", unclassified: "구분 없음" };

function render(r: DebtResult): string {
  const L: string[] = [];
  L.push(`### ${r.name ?? r.corp_code}${r.code ? ` (${r.code})` : ""} — ${r.report.fs === "CFS" ? "연결" : "별도"}`);
  L.push(`보고서: ${r.report.name}(${r.report.rcept_no}, 접수 ${r.report.filed})`);
  if (r.excluded) { L.push("", `이자부부채 계산 안 함: ${r.excluded}`); return L.join("\n"); }
  L.push("", `**이자부부채 합계 ${won(r.total)}원**${r.completeness === "partial" ? ` (일부 누락 가능: ${r.completenessReason})` : ""}`, "");
  L.push("| 구역 | 계정 | 금액 | 범주 | 출처 |", "|---|---|---:|---|---|");
  for (const l of r.lines) L.push(`| ${SEC[l.section]} | ${l.name} | ${won(l.amount)} | ${l.category} | ${l.source} |`);
  const cats = Object.entries(r.byCategory).filter(([, v]) => v).map(([k, v]) => `${k} ${won(v)}`);
  if (cats.length) L.push("", `범주별: ${cats.join(" · ")}`);
  if (r.debtLike.length) L.push("", `합계에서 제외한 부채성 항목(희석 또는 부채 가산 검토): ${r.debtLike.map(d => `${d.name} ${won(d.amount)}(${d.type})`).join(", ")}`);
  if (r.notes.length) L.push("", ...r.notes.map(n => `- 참고: ${n}`));
  if (r.checks.length) L.push("", ...r.checks.map(c => `- ⚠ ${c}`));
  return L.join("\n");
}

export function registerDebtTools(server: McpServer): void {
  defineTool(server, "dart_interest_bearing_debt", {
    title: "이자부부채 분류 (차입금·사채·전환사채·리스)",
    description: `평가기준일까지 접수된 최신 정기보고서의 재무상태표에서 이자부부채를 계정 행 단위로 뽑아 범주(borrowings 차입금, bonds 사채, convertible 전환사채·신주인수권부사채·교환사채, borrowingsAndBonds 구분 불가, lease 리스부채, otherDebt 유동화채무 등)로 나눕니다. 외부 valuation_get_data 의 ibd 와 같은 규칙입니다.
- 출처: DART 단일회사 전체 재무제표(본문). 본문에 리스부채 행이 없거나 차입금이 '금융부채' 한 줄에 묶여 있으면 XBRL 원본 주석으로 보충합니다(그때만 종목당 25~40초 더 걸림).
- 차감계정(사채할인발행차금·전환권조정 등)은 본계정 범주에 음수로 넣습니다. 상환전환우선주부채 등 부채성 항목은 합계에서 빼고 debtLike 로 따로 줍니다.
- 매각예정 처분자산집단 부채는 넣지 않고 참고로 알립니다. 금융업 재무상태표(유동/비유동 구분 없이 예수부채 등)는 계산하지 않습니다.
- checks 는 원문 확인이 필요한 경고입니다. completeness=partial 이면 차입 일부가 빠졌을 수 있습니다.
- 순차입금 = total − 현금및현금성자산 − 단기금융상품. 리스 제외 = total − byCategory.lease.`,
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, DebtSchema, async (a: z.infer<typeof DebtSchema>) => {
    try {
      if (!a.stock_codes?.length && !a.corp_code) throw new Error("stock_codes 또는 corp_code 가 필요합니다.");
      const codes = a.stock_codes ?? [];
      if (codes.length > 10) throw new Error("한 번에 10종목까지입니다. 나눠서 호출하십시오.");
      const deadline = Date.now() + 270_000;
      const targets: { stock_code?: string; corp_code?: string }[] = codes.length ? codes.map(c => ({ stock_code: c })) : [{ corp_code: a.corp_code }];
      const results = await Promise.all(targets.map(t => getInterestBearingDebt({ ...t, valuation_date: a.valuation_date, deadline })
        .then(r => ({ ok: true as const, r }), (e: Error) => ({ ok: false as const, id: t.stock_code ?? t.corp_code, e: e.message }))));
      const body = results.map(x => (x.ok ? render(x.r) : `### ${x.id}\n\n오류: ${x.e}`)).join("\n\n---\n\n");
      return {
        ...text(`이자부부채 — 출처: DART 재무상태표(필요 시 XBRL 주석), 평가기준일 ${a.valuation_date}\n\n${body}`),
        structuredContent: { results: results.map(x => (x.ok ? x.r : { error: x.e, id: x.id })) },
      };
    } catch (e) { return fail(e); }
  });
}
