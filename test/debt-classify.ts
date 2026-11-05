// 이자부부채 분류 규칙 단위 시험(외부 호출 없음). 사례는 2026-11-05 외부 valuation_get_data 와 대조하며 찾은 공시 형태.
import assert from "node:assert/strict";
import { classify, parseBs, instantFacts } from "../lib/debt.js";

const row = (account_id: string, account_nm: string, amount: number | null) => ({ account_id, account_nm, amount });
let n = 0; const ok = (m: string) => { n++; console.log("  OK", m); };

// 1. 이름·태그 분류
assert.equal(classify("유동 차입금(사채 포함)", "ifrs-full_ShorttermBorrowings"), "borrowings");
assert.equal(classify("유동성 금융기관 차입금(사채 제외)", "ifrs-full_CurrentLoansReceivedAndCurrentPortionOfNoncurrentLoansReceived"), "borrowings");
assert.equal(classify("사채 및 장기차입금", "ifrs-full_LongtermBorrowings"), "borrowingsAndBonds");
assert.equal(classify("유동성전환사채", "dart_CurrentPortionOfConvertibleBonds"), "convertible");
assert.equal(classify("전환사채할인발행차금", "-표준계정코드 미사용-"), "convertible");
assert.equal(classify("자산유동화차입금", "x"), "otherDebt");
assert.equal(classify("유동성전환상환우선주부채", "dart_CurrentPortionOfConvertibleRedeemablePreferredStockLiabilities"), "debtLike");
assert.equal(classify("금융리스채권", "ifrs-full_CurrentFinanceLeaseReceivables"), null);
assert.equal(classify("유동성파생상품부채", "dart_CurrentDerivativeLiabilities"), null);
ok("계정 분류");

// 2. 구역·차감계정·부모 합계 행(스팩: 차입부채 = 전환사채 + 전환권조정, 유동/비유동 구분 없음)
const spac = parseBs([
  row("ifrs-full_Assets", "자산총계", 100), row("ifrs-full_EquityAndLiabilities", "자본과부채총계", 100),
  row("ifrs-full_Borrowings", "차입부채", 1359950050), row("-표준계정코드 미사용-", "전환권조정", -135049950),
  row("-표준계정코드 미사용-", "전환사채", 1495000000), row("ifrs-full_Liabilities", "부채총계", 1402433184),
]);
assert.equal(spac.lines.reduce((s, l) => s + l.amount, 0), 1359950050);
assert.ok(spac.lines.every(l => l.section === "unclassified"));
ok("스팩 부모 행 제거·구분 없음");

const contra = parseBs([
  row("ifrs-full_NoncurrentLiabilities", "비유동부채", 1), row("x", "전환사채, 총액", 1790000000), row("x", "전환사채할인발행차금", 246107950),
]);
assert.equal(contra.lines.reduce((s, l) => s + l.amount, 0), 1543892050);
ok("차감계정 음수");

// 3. 유동/비유동 구분이 있으면 구분 밖(금융업 블록) 행은 쓰지 않음(실측: 케이프)
const mixed = parseBs([
  row("ifrs-full_EquityAndLiabilities", "자본과부채총계", 1), row("-표준계정코드 미사용-", "차입부채", 1567439454938),
  row("ifrs-full_CurrentLiabilities", "유동부채", 1), row("ifrs-full_ShorttermBorrowings", "단기차입금", 68420000000),
  row("ifrs-full_Liabilities", "부채총계", 1), row("ifrs-full_NoncurrentLiabilities", "비유동부채", 1), row("dart_LongTermBorrowingsGross", "장기차입금", 99108243608),
]);
assert.equal(mixed.lines.reduce((s, l) => s + l.amount, 0), 167528243608);
ok("금융업 블록 제외");

// 4. 포괄 금융부채 감지·리스 행 유무
const catchAll = parseBs([row("ifrs-full_CurrentLiabilities", "유동부채", 1), row("ifrs-full_OtherCurrentFinancialLiabilities", "유동금융부채", 46519418000), row("ifrs-full_CurrentLeaseLiabilities", "유동리스부채", 3300931752)]);
assert.equal(catchAll.catchAll.length, 1);
assert.ok(catchAll.lines.some(l => l.category === "lease"));
ok("포괄 금융부채 감지");

// 5. XBRL 시점값: 연결·보고금액 축만, 다른 축 제외
const xml = `<xbrli:context id="a"><xbrli:entity><xbrli:segment><xbrldi:explicitMember dimension="ifrs-full:ConsolidatedAndSeparateFinancialStatementsAxis">ifrs-full:ConsolidatedMember</xbrldi:explicitMember><xbrldi:explicitMember dimension="ifrs-full:CarryingAmountAccumulatedDepreciationAmortisationAndImpairmentAndGrossCarryingAmountAxis">ifrs-full:ReportedAmountMember</xbrldi:explicitMember></xbrli:segment></xbrli:entity><xbrli:period><xbrli:instant>2026-06-30</xbrli:instant></xbrli:period></xbrli:context>
<xbrli:context id="b"><xbrli:entity><xbrli:segment><xbrldi:explicitMember dimension="ifrs-full:ConsolidatedAndSeparateFinancialStatementsAxis">ifrs-full:ConsolidatedMember</xbrldi:explicitMember><xbrldi:explicitMember dimension="ifrs-full:BorrowingsByNameAxis">e:XMember</xbrldi:explicitMember></xbrli:segment></xbrli:entity><xbrli:period><xbrli:instant>2026-06-30</xbrli:instant></xbrli:period></xbrli:context>
<ifrs-full:CurrentLeaseLiabilities contextRef="a" unitRef="KRW">558035000000</ifrs-full:CurrentLeaseLiabilities>
<ifrs-full:ShorttermBorrowings contextRef="b" unitRef="KRW">999</ifrs-full:ShorttermBorrowings>`;
const f = instantFacts(xml, "2026-06-30", "C");
assert.equal(f.get("CurrentLeaseLiabilities"), 558035000000);
assert.equal(f.has("ShorttermBorrowings"), false);
ok("XBRL 시점값 축 필터");

console.log(`이자부부채 분류 ${n}건 통과`);
