/**
 * WACC 입력값 해석 — 비어 있는 무위험이자율·타인자본비용을 ECOS 에서 채운 뒤 dcf.ts 의 buildWacc 로 계산한다.
 * 산식은 buildWacc 한 벌만 쓴다(dcf_calculate 와 결과가 어긋나지 않도록).
 *
 * 자동으로 채우는 것은 "시장에서 관측되는 값"뿐이다.
 * 시장위험프리미엄·법인세율·규모프리미엄·목표 자본구조는 평가자의 판단이므로 기본값을 두지 않는다.
 */

import { buildWacc, isNum, type WaccInput } from "./dcf.js";
import { CORP_BY_RATING, KTB_BY_TENOR, getRatesAsOf, type RateKey, type RatesResult } from "./ecos.js";

export interface WaccAutoInput extends WaccInput {
  /** 금리 자동조회 기준일 YYYYMMDD — risk_free_pct 또는 cost_of_debt_pct 를 비워 둘 때 필요 */
  valuation_date?: string;
  /** 무위험이자율로 쓸 국고채 만기 */
  rf_tenor?: "1y" | "2y" | "3y" | "5y" | "10y" | "20y" | "30y" | "50y";
  /** 타인자본비용으로 쓸 회사채 등급(3년물) */
  credit_rating?: "AA-" | "BBB-";
}

export interface ResolvedWacc {
  wacc: number;
  detail: Record<string, string | number>;
  inputs: WaccInput;
  /** 어느 입력을 어디서 가져왔는지 */
  provenance: Record<string, string>;
  rates?: RatesResult;
  warnings: string[];
}

export async function resolveWaccInputs<T extends WaccAutoInput>(a: T): Promise<{ inputs: T; provenance: Record<string, string>; rates?: RatesResult; warnings: string[] }> {
  const provenance: Record<string, string> = {};
  const warnings: string[] = [];
  const inputs = { ...a };
  const needRf = !isNum(a.wacc_pct) && !isNum(a.risk_free_pct);
  const needKd = !isNum(a.wacc_pct) && !isNum(a.cost_of_debt_pct);

  if (isNum(a.risk_free_pct)) provenance.risk_free_pct = "직접 입력";
  if (isNum(a.cost_of_debt_pct)) provenance.cost_of_debt_pct = "직접 입력";
  if (isNum(a.risk_free_pct) && a.rf_tenor) warnings.push("risk_free_pct 를 직접 줬으므로 rf_tenor 는 쓰지 않았습니다.");
  if (isNum(a.cost_of_debt_pct) && a.credit_rating) warnings.push("cost_of_debt_pct 를 직접 줬으므로 credit_rating 은 쓰지 않았습니다.");

  const keys: RateKey[] = [];
  if (needRf) {
    if (!a.rf_tenor) throw new Error("risk_free_pct 를 주거나, 국고채 자동조회를 위해 rf_tenor(예: \"5y\")와 valuation_date 를 주세요. 만기는 평가자 판단이라 기본값을 두지 않습니다.");
    keys.push(KTB_BY_TENOR[a.rf_tenor]);
  }
  if (needKd && a.credit_rating) keys.push(CORP_BY_RATING[a.credit_rating]);
  if (needKd && !a.credit_rating) {
    // 부족한 값은 buildWacc 가 한꺼번에 알려 주지만, 자동조회 선택지가 있다는 것을 함께 안내한다.
    warnings.push("cost_of_debt_pct 가 없습니다. 회사채 3년물 금리를 쓰려면 credit_rating(\"AA-\" 또는 \"BBB-\")을 주세요.");
  }

  let rates: RatesResult | undefined;
  if (keys.length) {
    if (!a.valuation_date) throw new Error("금리를 자동조회하려면 valuation_date(YYYYMMDD)가 필요합니다.");
    rates = await getRatesAsOf(a.valuation_date, keys);
    const pick = (k: RateKey) => rates!.rates.find(r => r.key === k);
    if (needRf) {
      const r = pick(KTB_BY_TENOR[a.rf_tenor!]);
      if (!r) throw new Error(`${a.valuation_date} 기준 국고채(${a.rf_tenor}) 금리를 찾지 못했습니다.`);
      inputs.risk_free_pct = r.valuePct;
      provenance.risk_free_pct = `ECOS ${r.name} ${r.observedDate} ${r.valuePct}%`;
      if (r.lagDays > 7) warnings.push(`무위험이자율 관측일(${r.observedDate})이 기준일보다 ${r.lagDays}일 앞섭니다.`);
    }
    if (needKd && a.credit_rating) {
      const r = pick(CORP_BY_RATING[a.credit_rating]);
      if (!r) throw new Error(`${a.valuation_date} 기준 회사채(3년, ${a.credit_rating}) 금리를 찾지 못했습니다.`);
      inputs.cost_of_debt_pct = r.valuePct;
      provenance.cost_of_debt_pct = `ECOS ${r.name} ${r.observedDate} ${r.valuePct}% (세전)`;
      warnings.push("타인자본비용을 회사채 3년물 시장금리로 대용했습니다. 실제 차입금리·만기 구조와 다를 수 있습니다.");
    }
  }

  for (const k of ["mrp_pct", "tax_rate_pct", "size_premium_pct", "beta", "unlevered_beta", "debt_to_equity", "debt_weight_pct", "wacc_pct"] as const) {
    if (isNum(a[k])) provenance[k] = "직접 입력";
  }
  return { inputs, provenance, rates, warnings };
}

export async function calculateWacc(a: WaccAutoInput): Promise<ResolvedWacc> {
  const { inputs, provenance, rates, warnings } = await resolveWaccInputs(a);
  const { wacc, detail } = buildWacc(inputs);
  return { wacc, detail, inputs, provenance, rates, warnings };
}
