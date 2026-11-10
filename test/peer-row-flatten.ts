// 피어 행 펼치기 — valuation_get_data 응답을 그대로 넘겨도 peer_statistics 가 받는지 확인(외부 호출 없음)
import { flattenPeerRow } from "../lib/tools-calc.js";
import { peerStatistics, type PeerRow } from "../lib/peer-stats.js";
let fail = 0;
const ok = (n: string, c: boolean, i?: unknown) => { console.log((c ? "PASS " : "FAIL ") + n + (i !== undefined ? "  " + JSON.stringify(i) : "")); if (!c) fail++; };
const raw = { code: "018260", name: "삼성에스디에스", marketCap: { price: 219000, shares: 77377800, total: 1, sharesNote: "유통주식수" }, ibd: { total: 4e11, byCategory: { lease: 3e11 }, completeness: "partial" }, cash: 5e12, financials: { revenue: 1.4e13, operatingIncome: 9.5e11, netIncomeParent: 8e11, equityParent: 1.2e13, incomeMonths: 12, report: { name: "사업보고서 (2025.12)" } } };
const f = flattenPeerRow(raw) as Record<string, unknown>;
ok("시가총액 = price × shares", f.marketCap === 219000 * 77377800, f.marketCap);
ok("ibd = total, lease = byCategory.lease", f.ibd === 4e11 && f.lease === 3e11);
ok("financials 펼침·report 이름", f.revenue === 1.4e13 && f.netIncomeParent === 8e11 && f.report === "사업보고서 (2025.12)" && f.financials === undefined);
ok("원천 경고를 dataNotes로", Array.isArray(f.dataNotes) && (f.dataNotes as string[]).length === 2, f.dataNotes);
const flat = { code: "064400", marketCap: 6.6e12, ibd: 3e11, revenue: 6e12, netIncomeParent: 4e11, equityParent: 3e12, incomeMonths: 12 };
ok("이미 숫자인 행은 그대로", JSON.stringify(flattenPeerRow(flat)) === JSON.stringify(flat));
ok("total만 있는 시가총액", (flattenPeerRow({ code: "x", marketCap: { total: 123 } }) as Record<string, unknown>).marketCap === 123);
const res = peerStatistics([f as unknown as PeerRow, flat as unknown as PeerRow], { metrics: ["per", "pbr"] });
const per = res.metrics.find(m => m.label.startsWith("PER"));
ok("통계 계산(PER n=2)", !!per && per.nUsed === 2, per && per.median);
process.exit(fail ? 1 : 0);
