// 원본 dart-mcp/lib/dcf.js 와 이식본의 출력을 여러 입력으로 대조한다.
import { calculate as orig } from "./fixtures/dcf.dart-mcp.mjs";
import { calculateDcf } from "../lib/dcf.js";

const cases: Record<string, any> = {
  gordon_capm: { unit: "백만원", first_year: 2026, fcf: [100, 120, 140, 150, 160], risk_free_pct: 3.84, mrp_pct: 8, beta: 1.1, cost_of_debt_pct: 5.2, tax_rate_pct: 24.2, debt_to_equity: 0.3, terminal_growth_pct: 1, net_debt: 300, non_controlling_interest: 20, shares_outstanding: 1000 },
  unlevered_mid: { base_fcf: 500, growth_rates_pct: [10, 8, 6, 4, 2], risk_free_pct: 4.176, mrp_pct: 7.5, unlevered_beta: 0.85, size_premium_pct: 2, cost_of_debt_pct: 6.1, tax_rate_pct: 26.4, debt_weight_pct: 20, terminal_growth_pct: 1.5, mid_year: true, net_debt: -200 },
  multiple: { fcf: [80, -10, 90], wacc_pct: 11, exit_multiple: 7, terminal_metric: 150, sensitivity: { wacc_steps: 3, multiple_step: 1, second_steps: 1 } },
  ev_only: { fcf: [10, 11, 12], wacc_pct: 9, terminal_growth_pct: 2 },
  high_g: { fcf: [10, 11, -1], wacc_pct: 3, terminal_growth_pct: 2.9, risk_free_pct: 2 },
};
const errCases: Record<string, any> = {
  missing: { fcf: [1, 2], beta: 1 },
  g_ge_wacc: { fcf: [1, 2], wacc_pct: 2, terminal_growth_pct: 3 },
  no_tv: { fcf: [1], wacc_pct: 9 },
};

let pass = 0, fail = 0;
for (const [name, input] of Object.entries(cases)) {
  const a = orig(structuredClone(input));
  const b = calculateDcf(structuredClone(input));
  const same = a.content[0].text === b.text && JSON.stringify(a.structuredContent) === JSON.stringify(b.structured);
  same ? pass++ : fail++;
  console.log(`${same ? "OK  " : "DIFF"} ${name}`);
  if (!same) { console.log(a.content[0].text); console.log("----"); console.log(b.text); }
}
for (const [name, input] of Object.entries(errCases)) {
  let ea = "", eb = "";
  try { orig(structuredClone(input)); } catch (e) { ea = (e as Error).message; }
  try { calculateDcf(structuredClone(input)); } catch (e) { eb = (e as Error).message; }
  const same = ea !== "" && ea === eb;
  same ? pass++ : fail++;
  console.log(`${same ? "OK  " : "DIFF"} err:${name} → ${eb}`);
}
console.log(`pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
