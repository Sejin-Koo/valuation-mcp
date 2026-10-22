// 감가상각비 구성 규칙 단위 시험 — 실측에서 나온 다섯 가지 공시 형태를 합성 XBRL 로 재현한다.
import { parseFacts, cumulativePeriod, computeDa, computeFlows } from "../lib/xbrl.js";

const C = "ConsolidatedMember";
const M = 1_000_000; // 금액 단위(백만원 → 원) — 대조 허용오차가 원 단위라 실제 규모로 맞춘다
function doc(facts: [string, number, string?][], labels: Record<string, string> = {}) {
  const ctx = `<xbrli:context id="cur"><xbrli:entity/><xbrli:period><xbrli:startDate>2025-01-01</xbrli:startDate><xbrli:endDate>2025-12-31</xbrli:endDate></xbrli:period><xbrli:scenario><xbrldi:explicitMember dimension="ifrs-full:ConsolidatedAndSeparateFinancialStatementsAxis">ifrs-full:${C}</xbrldi:explicitMember></xbrli:scenario></xbrli:context>
<xbrli:context id="rou"><xbrli:entity/><xbrli:period><xbrli:startDate>2025-01-01</xbrli:startDate><xbrli:endDate>2025-12-31</xbrli:endDate></xbrli:period><xbrli:scenario><xbrldi:explicitMember dimension="ifrs-full:ConsolidatedAndSeparateFinancialStatementsAxis">ifrs-full:${C}</xbrldi:explicitMember><xbrldi:explicitMember dimension="ifrs-full:ClassesOfPropertyPlantAndEquipmentAxis">ifrs-full:RightofuseAssetsMember</xbrldi:explicitMember></xbrli:scenario></xbrli:context>
<xbrli:unit id="KRW"><xbrli:measure>iso4217:KRW</xbrli:measure></xbrli:unit>`;
  const body = facts.map(([t, v, c]) => `<${t} contextRef="${c ?? "cur"}" unitRef="KRW" decimals="0">${v * M}</${t}>`).join("\n");
  const lab = Object.entries(labels).map(([id, l]) => `<link:label xml:lang="ko" xlink:label="Label_label_${id}_ko" xlink:role="http://www.xbrl.org/2003/role/label" xlink:type="resource">${l}</link:label>`).join("\n");
  return { instance: `<xbrl>${ctx}\n${body}</xbrl>`, labelsKo: lab };
}

const cases: { name: string; d: ReturnType<typeof doc>; total: number; exRou: number | null }[] = [
  {
    name: "사용권자산 상각이 현금흐름표 별도 행(S-Oil형)",
    d: doc([["ifrs-full:AdjustmentsForDepreciationExpense", 700], ["ifrs-full:AdjustmentsForAmortisationExpense", 15], ["dart:AdjustmentsForDepreciationRightofuseAssets", 86], ["ifrs-full:DepreciationPropertyPlantAndEquipment", 700], ["ifrs-full:DepreciationRightofuseAssets", 86], ["dart:OperatingIncomeLoss", 200]]),
    total: 801, exRou: 715,
  },
  {
    name: "사용권자산이 유형자산의 한 종류(케이씨형)",
    d: doc([["ifrs-full:AdjustmentsForDepreciationExpense", 234], ["ifrs-full:AdjustmentsForAmortisationExpense", 20], ["ifrs-full:DepreciationPropertyPlantAndEquipment", 234], ["ifrs-full:DepreciationPropertyPlantAndEquipment", 80, "rou"], ["ifrs-full:DepreciationRightofuseAssets", 80], ["dart:OperatingIncomeLoss", 100]]),
    total: 254, exRou: 174,
  },
  {
    name: "사용권자산·투자부동산이 감가상각비 줄에 포함(영풍형)",
    d: doc([["ifrs-full:AdjustmentsForDepreciationExpense", 8614], ["ifrs-full:AdjustmentsForAmortisationExpense", 7], ["ifrs-full:DepreciationPropertyPlantAndEquipment", 7922], ["ifrs-full:DepreciationRightofuseAssets", 213], ["ifrs-full:DepreciationInvestmentProperty", 479], ["dart:OperatingIncomeLoss", -50]]),
    total: 8621, exRou: 8408,
  },
  {
    name: "투자부동산 감가상각이 회사 고유 현금흐름표 행(미래산업형)",
    d: doc([["ifrs-full:AdjustmentsForDepreciationExpense", 816], ["ifrs-full:AdjustmentsForAmortisationExpense", 23], ["entity1:udf_CF_1_AdjustmentsForReconcileProfitLoss", 207], ["dart:OperatingIncomeLoss", 91]], { "entity1_udf_CF_1_AdjustmentsForReconcileProfitLoss": "투자부동산감가상각비" }),
    total: 1046, exRou: 1046,
  },
  {
    name: "합계 한 줄만(은행형)",
    d: doc([["ifrs-full:AdjustmentsForDepreciationAndAmortisationExpense", 5695]]),
    total: 5695, exRou: null,
  },
];

let fail = 0;
for (const c of cases) {
  const facts = parseFacts(c.d);
  const p = cumulativePeriod(facts, "2025-12-31")!;
  const r = computeDa(facts, "C", p);
  const ok = r && r.total === c.total * M && r.totalExclRightOfUse === (c.exRou === null ? null : c.exRou * M);
  if (!ok) fail++;
  console.log(`${ok ? "✓" : "✗"} ${c.name}: 합계 ${(r?.total ?? 0) / M} (기대 ${c.total}), 사용권자산 제외 ${r?.totalExclRightOfUse == null ? null : r.totalExclRightOfUse / M} (기대 ${c.exRou})`);
}
// 영업이익 부호 유지
{
  const facts = parseFacts(cases[2].d);
  const f = computeFlows(facts, "C", cumulativePeriod(facts, "2025-12-31")!);
  const ok = f.operatingIncome?.value === -50 * M;
  if (!ok) fail++;
  console.log(`${ok ? "✓" : "✗"} 영업손실 부호 유지: ${f.operatingIncome?.value}`);
}
console.log(fail ? `${fail}건 실패` : "전부 통과");
process.exit(fail ? 1 : 0);
