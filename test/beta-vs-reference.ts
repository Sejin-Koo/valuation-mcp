// 비교 서버(kr-valuation-data compute_beta) 값과 소수점 6자리 대조 — 네이버 실시간 시세 필요.
import { readFileSync } from "node:fs";
import { computeBeta, type BetaPeriod } from "../lib/beta.js";

const ref = JSON.parse(readFileSync(new URL("./fixtures/beta-reference.json", import.meta.url), "utf8"));
const byDate = new Map<string, any[]>();
for (const c of ref.cases) byDate.set(c.baseDate, [...(byDate.get(c.baseDate) ?? []), c]);
let ok = 0, bad = 0;
for (const [d, cases] of byDate) {
  const codes = Array.from(new Set(cases.map((c: any) => c.code))) as string[];
  const res = await computeBeta(codes, d, ["Weekly-2Y", "Monthly-5Y"], "KOSPI");
  for (const c of cases) {
    const row: any = res.out.find((o: any) => o.code === c.code);
    const r = row?.results?.find((x: any) => x.period === (c.period as BetaPeriod));
    const fields = ["raw", "adjusted", "rSquared", "dataPoints"] as const;
    const diffs = fields.filter(f => !(r && Math.abs((r as any)[f] - c[f]) <= 1e-6 + 1e-9));
    diffs.length ? bad++ : ok++;
    if (diffs.length) console.log("DIFF", d, c.code, c.period, diffs.map(f => `${f}: ${r?.[f]} vs ${c[f]}`).join("; "));
  }
}
console.log(`beta vs reference: ok=${ok} diff=${bad} (of ${ok + bad})`);
if (bad) process.exit(1);
