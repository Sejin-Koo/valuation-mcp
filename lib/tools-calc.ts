/**
 * 확장 도구 4종 — 금리 조회, WACC, 피어 통계, DCF.
 * 일부 MCP 클라이언트는 숫자·불리언·배열을 문자열로 보내므로 전부 문자열도 받는다
 * (z.coerce.boolean 은 "false"를 true 로 만들므로 쓰지 않는다).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { num, bool, jsonArray, jsonObject, yyyymmdd, text, fail, defineTool } from "./common.js";
import { RATE_KEYS, RATE_ITEMS, getRatesAsOf, type RateKey } from "./ecos.js";
import { calculateWacc, resolveWaccInputs } from "./wacc.js";
import { type DcfInput, calculateDcf, r2 } from "./dcf.js";
import { peerStatistics, type PeerRow, type MetricKey } from "./peer-stats.js";

const TENORS = ["1y", "2y", "3y", "5y", "10y", "20y", "30y", "50y"] as const;
const RATINGS = ["AA-", "BBB-"] as const;

const waccShape = {
  valuation_date: yyyymmdd().optional().describe("금리 자동조회 기준일. risk_free_pct·cost_of_debt_pct 를 비울 때 필요"),
  rf_tenor: z.enum(TENORS).optional().describe("무위험이자율로 쓸 국고채 만기(평가자 판단 — 기본값 없음)"),
  credit_rating: z.enum(RATINGS).optional().describe("타인자본비용으로 쓸 회사채 3년물 등급(ECOS 일별 시장금리에는 AA-, BBB- 두 등급만 있음)"),
  wacc_pct: num().optional().describe("WACC(%)를 직접 줄 때"),
  risk_free_pct: num().optional().describe("무위험이자율(%) 직접 입력 — 주면 자동조회하지 않음"),
  mrp_pct: num().optional().describe("시장위험프리미엄(%) — 평가자 판단, 기본값 없음"),
  beta: num().optional().describe("레버드 베타(그대로 사용)"),
  unlevered_beta: num().optional().describe("언레버드 베타 — debt_to_equity 와 tax_rate_pct 로 리레버"),
  size_premium_pct: num().optional().describe("규모 위험 프리미엄 등 가산(%). 기본 0"),
  cost_of_debt_pct: num().optional().describe("세전 타인자본비용(%) 직접 입력 — 주면 자동조회하지 않음"),
  tax_rate_pct: num().optional().describe("법인세율(%) — 지방세 포함 여부는 평가자 판단"),
  debt_to_equity: num().optional().describe("목표 D/E(배수)"),
  debt_weight_pct: num().optional().describe("부채비중 D/(D+E)(%)"),
};

const peerRow = z.object({
    code: z.string(), name: z.string().optional(),
    beta: num().nullable().optional(), marketCap: num().nullable().optional(),
    ibd: num().nullable().optional(), lease: num().nullable().optional(),
    cash: num().nullable().optional(), shortTermDeposits: num().nullable().optional(),
    nci: num().nullable().optional(), enterpriseValue: num().nullable().optional(),
    revenue: num().nullable().optional(), operatingIncome: num().nullable().optional(),
    depreciationAmortization: num().nullable().optional(),
    netIncomeParent: num().nullable().optional(), equityParent: num().nullable().optional(),
    incomeMonths: num().nullable().optional(), report: z.string().nullable().optional(),
    dataNotes: jsonArray(z.string()).nullable().optional(),
  });
const METRICS = ["ev_sales", "ev_ebit", "ev_ebitda", "per", "pbr", "unlevered_beta"] as const;
const RatesSchema = z.object({
        valuation_date: yyyymmdd().describe("평가기준일"),
        items: jsonArray(z.enum(RATE_KEYS as [RateKey, ...RateKey[]])).optional(),
      });
const WaccSchema = z.object(waccShape);
const PeerStatsSchema = z.object({
        peers: jsonArray(peerRow).describe("피어 행 배열(valuation_get_data 응답 필드를 그대로 옮긴 값)"),
        metrics: jsonArray(z.enum(METRICS)).optional(),
        tax_rate_pct: num().optional().describe("언레버드 베타 계산용 법인세율(%)"),
        debt_definition: z.enum(["ibd_total", "ibd_ex_lease", "net_debt"]).optional(),
        partial_period: z.enum(["exclude", "annualize"]).optional(),
        outlier_rule: z.enum(["none", "tukey_1.5", "tukey_3"]).optional(),
      });
const DcfSchema = z.object({
        ...waccShape,
        unit: z.string().optional(), first_year: z.coerce.number().int().optional(),
        fcf: jsonArray(num()).optional(), base_fcf: num().optional(), growth_rates_pct: jsonArray(num()).optional(),
        terminal_growth_pct: num().optional(), exit_multiple: num().optional(), terminal_metric: num().optional(),
        mid_year: bool().optional(),
        stub_fraction: num().optional().describe("평가기준일부터 첫해 회계연도 말까지의 연수(0~1). 비우면 valuation_date·first_year·fiscal_year_end 로 자동 계산"),
        stub_prorate: bool().optional().describe("true면 fcf[0](또는 첫해 값)을 연간 값으로 보고 잔여기간 비율만큼만 반영"),
        fiscal_year_end: z.string().regex(/^\d{4}$/).optional().describe("회계연도 말 MMDD(기본 1231)"),
        net_debt: num().optional(), non_controlling_interest: num().optional(),
        non_operating_assets: num().optional(), shares_outstanding: num().optional(),
        sensitivity: jsonObject(z.object({
          wacc_step_pct: num().optional(), wacc_steps: z.coerce.number().int().optional(),
          growth_step_pct: num().optional(), multiple_step: num().optional(), second_steps: z.coerce.number().int().optional(),
        })).optional(),
      });

// 평가기준일이 첫해 회계연도 중간이면 첫해 잔여기간(연)을 계산한다. stub_fraction 을 직접 주면 그대로 둔다
export function stubFromDates(vd?: string, firstYear?: number, fye?: string, given?: number): { fraction?: number; note?: string } {
  if (given !== undefined && given !== null) return {};
  if (!vd) return {};
  const mmdd = fye || "1231";
  const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
  const v = day(+vd.slice(0, 4), +vd.slice(4, 6), +vd.slice(6, 8));
  const fyEnd = (y: number) => day(y, +mmdd.slice(0, 2), +mmdd.slice(2, 4));
  if (!Number.isInteger(firstYear)) {
    const y = +vd.slice(0, 4);
    if (v !== fyEnd(y) && v !== fyEnd(y - 1)) return { note: `first_year가 없어 할인 시점을 평가기준일(${vd})에 맞추지 않았습니다(1년차 말 관행). 연중 평가라면 first_year를 주십시오.` };
    return {};
  }
  const end = fyEnd(firstYear as number), prevEnd = fyEnd((firstYear as number) - 1);
  if (v >= end) throw new Error(`평가기준일(${vd})이 첫 추정연도(${firstYear}) 회계연도 말 이후입니다. first_year를 평가기준일 다음 회계연도로 주십시오.`);
  if (v <= prevEnd) return v < prevEnd ? { note: `평가기준일(${vd})이 첫 추정연도 직전 회계연도 말보다 앞서 1년차 말 관행으로 할인했습니다.` } : {};
  const frac = Math.round(((end - v) / 86400000 / 365) * 10000) / 10000;
  return { fraction: Math.min(1, frac), note: `평가기준일 ${vd} → ${firstYear} 회계연도 말까지 ${Math.min(1, frac)}년(일수/365)으로 첫해를 할인` };
}

export function registerCalcTools(server: McpServer): void {
  // ── 1. 금리 ──────────────────────────────────────────────
  defineTool(server, "ecos_get_market_rates",
    {
      title: "시장금리 조회 (한국은행 ECOS)",
      description: `평가기준일의 국고채·회사채·단기금리를 한국은행 ECOS 시장금리(일별, 817Y002)에서 조회합니다.
기준일이 휴일이면 직전 영업일 값을 쓰고 실제 관측일(observedDate)을 함께 돌려줍니다. 기준일 이후 값은 쓰지 않습니다.
무위험이자율(Rf)은 국고채, 타인자본비용(Kd) 참고값은 회사채 3년 AA-·BBB- 를 쓰십시오.
items 를 비우면 국고채 3·5·10년 + 회사채 AA-·BBB- 를 반환합니다.
선택 가능한 items: ${RATE_KEYS.map(k => `${k}(${RATE_ITEMS[k].name})`).join(", ")}`,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    RatesSchema,
    async ({ valuation_date, items }: z.infer<typeof RatesSchema>) => {
      try {
        const keys = items?.length ? items : (["ktb_3y", "ktb_5y", "ktb_10y", "corp_aa_minus_3y", "corp_bbb_minus_3y"] as RateKey[]);
        const r = await getRatesAsOf(valuation_date, keys);
        const lines = [
          `시장금리 — 기준일 ${r.valuationDate} (출처: ${r.source}, ${r.table})`, "",
          "| 항목 | 금리(연%) | 관측일 |", "|---|---:|---|",
          ...r.rates.map(x => `| ${x.name} | ${x.valuePct} | ${x.observedDate}${x.lagDays ? ` (기준일 −${x.lagDays}일)` : ""} |`),
          ...(r.missing.length ? ["", "값 없음:", ...r.missing.map(m => `- ${m.name}: ${m.reason}`)] : []),
        ];
        return { ...text(lines.join("\n")), structuredContent: r as unknown as Record<string, unknown> };
      } catch (e) { return fail(e); }
    },
  );

  // ── 2. WACC ─────────────────────────────────────────────
  defineTool(server, "wacc_calculate",
    {
      title: "WACC 계산 (CAPM, Rf·Kd 자동조회)",
      description: `CAPM으로 자기자본비용을, 세후 타인자본비용과 목표 자본구조로 WACC를 계산합니다. 산식은 dcf_calculate 와 같습니다.
- 무위험이자율: risk_free_pct 직접 입력, 또는 rf_tenor + valuation_date 로 ECOS 국고채 자동조회
- 타인자본비용: cost_of_debt_pct 직접 입력, 또는 credit_rating(AA-/BBB-) + valuation_date 로 회사채 3년물 자동조회
- 베타: beta(레버드) 또는 unlevered_beta(+ debt_to_equity 로 리레버). 피어 언레버드 베타 중앙값은 peer_statistics 로 먼저 구하십시오.
- 시장위험프리미엄·법인세율·자본구조는 평가자 판단이라 기본값이 없습니다.
결과의 provenance 에 각 입력이 어디서 왔는지 적혀 있으니 답변에 함께 밝히십시오.`,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    WaccSchema,
    async (args: z.infer<typeof WaccSchema>) => {
      try {
        const r = await calculateWacc(args);
        const lines = [
          `WACC ${r2(r.wacc * 100)}%`, "",
          "| 구성요소 | 값 |", "|---|---:|",
          ...Object.entries(r.detail).map(([k, v]) => `| ${k} | ${v} |`), "",
          "입력 출처:", ...Object.entries(r.provenance).map(([k, v]) => `- ${k}: ${v}`),
          ...(r.warnings.length ? ["", "유의:", ...r.warnings.map(w => `- ${w}`)] : []),
        ];
        return { ...text(lines.join("\n")), structuredContent: { wacc_pct: r2(r.wacc * 100), detail: r.detail, inputs: r.inputs, provenance: r.provenance, warnings: r.warnings } };
      } catch (e) { return fail(e); }
    },
  );

  // ── 3. 피어 통계 ─────────────────────────────────────────

  defineTool(server, "peer_statistics",
    {
      title: "피어 멀티플·언레버드 베타 통계",
      description: `피어 종목들의 EV/매출·EV/영업이익·EV/EBITDA·PER·PBR·언레버드 베타 분포를 계산합니다.
대표값은 중앙값이고, 표본 수·제외 사유별 건수·사분위(Q1~Q3)·중앙값 부트스트랩 95% 구간을 함께 돌려줍니다.
- 분모 ≤ 0(적자·자본잠식), EV ≤ 0, 결측은 정의상 제외하고 사유를 종목별로 싣습니다.
- 이상치는 기본적으로 제외하지 않고 Tukey 1.5·IQR 밖 값을 표시만 합니다(outlier_rule 로 제외 가능).
- 손익이 12개월 누적이 아닌 행(분기·반기보고서)은 흐름 멀티플에서 제외합니다(partial_period="annualize" 로 단순 연환산 가능 — 계절성 미반영).
- EV/EBITDA 는 depreciationAmortization 이 있는 행만 계산됩니다.
- 같은 종목코드가 중복되면 첫 행만 씁니다.
답변에는 표본 수와 통계량 이름(중앙값·사분위·구간)을 함께 적으십시오. 수치를 다시 손으로 계산하지 마십시오.`,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    PeerStatsSchema,
    async ({ peers, ...opt }: z.infer<typeof PeerStatsSchema>) => {
      try {
        const res = peerStatistics(peers as PeerRow[], { ...opt, metrics: opt.metrics as MetricKey[] | undefined });
        const f = (v: number | null) => (v === null ? "-" : v.toLocaleString("ko-KR", { maximumFractionDigits: 2 }));
        const lines = [
          `피어 통계 — 입력 ${res.nInput}개(중복 제외 후 ${res.nAfterDedup}개)`, "",
          "| 지표 | 사용 n | 제외 | 중앙값 | Q1 | Q3 | 중앙값 95% 구간 | 평균(참고) |", "|---|---:|---:|---:|---:|---:|---|---:|",
          ...res.metrics.map(m => `| ${m.label} | ${m.nUsed} | ${m.excluded.length} | ${f(m.median)} | ${f(m.q1)} | ${f(m.q3)} | ${m.medianBootstrap95 ? `${f(m.medianBootstrap95[0])} ~ ${f(m.medianBootstrap95[1])}` : "-"} | ${f(m.mean)} |`),
          "", "제외 사유:",
          ...res.metrics.filter(m => m.excluded.length).map(m => `- ${m.label}: ${Object.entries(m.excludedByReason).map(([k, v]) => `${k} ${v}건`).join(", ")}`),
          ...res.metrics.filter(m => m.outliersFlagged.length).map(m => `- ${m.label} 이상치 표시: ${m.outliersFlagged.join(", ")}${m.outliersRemoved.length ? " (제외됨)" : " (제외 안 함)"}`),
          "", "방법:", ...Object.entries(res.method).map(([k, v]) => `- ${k}: ${v}`),
          "", "유의:", ...res.warnings.map(w => `- ${w}`), ...res.metrics.flatMap(m => m.warnings.map(w => `- ${m.label}: ${w}`)),
        ];
        return { ...text(lines.join("\n")), structuredContent: res as unknown as Record<string, unknown> };
      } catch (e) { return fail(e); }
    },
  );

  // ── 4. DCF ──────────────────────────────────────────────
  defineTool(server, "dcf_calculate",
    {
      title: "DCF 계산",
      description: `현금흐름할인법(DCF) 계산기. 추정 잉여현금흐름(FCF)과 할인율·영구성장률 등 가정을 받아 기업가치·주주가치·주당가치와 민감도 표를 계산한다.
dart-mcp 의 dcf_calculate 와 같은 계산이며, 이 서버에서는 risk_free_pct·cost_of_debt_pct 를 비우고 valuation_date + rf_tenor(+ credit_rating)를 주면 ECOS 금리를 자동으로 채운다.
비율은 퍼센트 숫자(9.5 = 9.5%). FCF는 fcf(연도별 값 배열) 또는 base_fcf + growth_rates_pct 중 하나로 준다.
할인율은 wacc_pct를 직접 주거나, risk_free_pct·mrp_pct·beta(또는 unlevered_beta)·cost_of_debt_pct·tax_rate_pct·debt_to_equity(또는 debt_weight_pct)로 계산하게 한다.
잔존가치는 terminal_growth_pct(영구성장) 또는 exit_multiple + terminal_metric으로 준다.
할인 시점: valuation_date 와 first_year(첫 추정 회계연도)를 함께 주면 평가기준일부터 첫해 말까지의 잔여기간(stub)으로 첫해를 할인하고 이후 해와 잔존가치도 그만큼 당겨 할인한다(연중 평가에서 1년차 말 관행을 쓰면 과다 할인). 이때 fcf[0]은 잔여기간의 현금흐름이어야 하며, 연간 추정치를 넣었다면 stub_prorate=true 로 잔여기간 비율만 반영한다. 두 값이 없으면 1년차 말(또는 mid_year) 관행.
결과에는 쓰인 가정이 모두 들어 있으므로, 답변에 가정을 밝히고 다른 가정이 필요하면 다시 계산하겠다고 안내한다.`,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    DcfSchema,
    async (args: z.infer<typeof DcfSchema>) => {
      try {
        const { inputs, provenance, warnings } = await resolveWaccInputs(args);
        const st = stubFromDates(args.valuation_date, args.first_year, args.fiscal_year_end, args.stub_fraction);
        if (st.fraction !== undefined) (inputs as DcfInput).stub_fraction = st.fraction;
        if (st.note) { provenance.stub_fraction = st.note; warnings.push(st.note); }
        const r = calculateDcf(inputs as DcfInput);
        const extra = Object.keys(provenance).some(k => provenance[k].startsWith("ECOS"))
          ? ["", "자동조회한 입력:", ...Object.entries(provenance).filter(([, v]) => v.startsWith("ECOS")).map(([k, v]) => `- ${k}: ${v}`), ...warnings.map(w => `- ${w}`)]
          : [];
        return { ...text(r.text + (extra.length ? "\n" + extra.join("\n") : "")), structuredContent: { ...r.structured, 입력출처: provenance } as unknown as Record<string, unknown> };
      } catch (e) { return fail(e); }
    },
  );
}
