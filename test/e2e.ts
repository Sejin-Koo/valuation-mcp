// 실제 핸들러를 로컬 HTTP 서버로 띄워 JSON-RPC 로 전 도구를 호출한다.
// 필요 환경변수: ECOS_API_KEY, DART_API_KEY (샌드박스에서는 NODE_USE_ENV_PROXY=1 도 필요)
import http from "node:http";
import { readFileSync } from "node:fs";
import handler from "../api/mcp.js";

process.env.MCP_GATE_KEYS = "plk_test_abc"; process.env.MCP_GATE_MODE = "enforce";
const srv = http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  (req as any).body = body ? JSON.parse(body) : undefined;
  (req as any).query = Object.fromEntries(new URL(req.url!, "http://x").searchParams);
  await handler(req as any, res);
});
await new Promise<void>(r => srv.listen(0, r));
const port = (srv.address() as any).port;
let id = 0, failures = 0;
const expect = (c: boolean, m: string) => { console.log(`${c ? "ok  " : "FAIL"}: ${m}`); if (!c) failures++; };

async function rpc(method: string, params: any, opts: { key?: string | null; headers?: Record<string, string> } = {}) {
  const k = opts.key === undefined ? "plk_test_abc" : opts.key;
  const res = await fetch(`http://127.0.0.1:${port}/api/mcp${k ? `?k=${k}` : ""}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(opts.headers ?? {}) },
    body: JSON.stringify(method.startsWith("notifications/") ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++id, method, params }),
  });
  const t = await res.text();
  const data = t.split("\n").find(l => l.startsWith("data: "));
  return { status: res.status, json: data ? JSON.parse(data.slice(6)) : (t ? JSON.parse(t) : null) };
}
const call = async (name: string, args: any) => (await rpc("tools/call", { name, arguments: args })).json.result;

// 프로토콜·게이트
expect((await rpc("tools/list", {}, { key: null })).status === 401, "게이트키 없으면 401");
expect((await rpc("tools/list", {}, { key: "plk_wrong_x" })).status === 401, "틀린 게이트키 401");
const init = await rpc("initialize", { protocolVersion: "2099-01-01", capabilities: {}, clientInfo: { name: "t", version: "1" } });
expect(init.status === 200 && init.json.result.protocolVersion !== "2099-01-01", `initialize 협상 — 요청값 반향 안 함(${init.json.result.protocolVersion})`);
expect((await rpc("tools/list", {}, { headers: { "MCP-Protocol-Version": "2099-01-01" } })).status === 400, "미지원 MCP-Protocol-Version 헤더 → 400");
expect((await rpc("notifications/initialized", {})).status === 202, "알림 → 202");
const list = (await rpc("tools/list", {})).json.result.tools.map((t: any) => t.name).sort();
const want = ["beta_regression", "dart_business_section", "dcf_calculate", "ecos_get_market_rates", "naver_market_snapshot", "peer_statistics", "wacc_calculate"];
expect(JSON.stringify(list) === JSON.stringify(want), `도구 7개: ${list.join(", ")}`);

// 계산 도구
const rates = await call("ecos_get_market_rates", { valuation_date: "20261020", items: '["ktb_3y"]' });
expect(rates.structuredContent?.rates?.[0]?.valuePct === 3.84, "ECOS 국고채 3년 2026-10-20 = 3.84");
const w = await call("wacc_calculate", { valuation_date: "20260331", rf_tenor: "5y", credit_rating: "AA-", mrp_pct: "8", unlevered_beta: 0.9, tax_rate_pct: 24.2, debt_to_equity: 0.25 });
expect(w.structuredContent?.wacc_pct === 10.5, `WACC 10.5% (${w.structuredContent?.wacc_pct})`);
const peers = JSON.parse(readFileSync(new URL("./fixtures/peers-20260331.json", import.meta.url), "utf8"));
const ps = await call("peer_statistics", { peers: JSON.stringify(peers), tax_rate_pct: 24.2 });
const evs = ps.structuredContent?.metrics?.find((m: any) => m.metric === "ev_sales");
expect(evs?.nUsed === 6 && /원천 데이터 확인 필요/.test(ps.content[0].text), "피어 통계 — 9개월 행 제외·원천 경고 전달");
const d = await call("dcf_calculate", { valuation_date: "20260331", rf_tenor: "10y", credit_rating: "BBB-", mrp_pct: 8, beta: 1.1, tax_rate_pct: 24.2, debt_to_equity: 0.3, fcf: "[100,120,140]", terminal_growth_pct: 1, net_debt: 50, shares_outstanding: 1000, mid_year: "false" });
expect(!d.isError && /ECOS 국고채\(10년\)/.test(d.content[0].text), "DCF 금리 자동조회");

// 조회 도구
const b = await call("beta_regression", { stock_codes: ["005930", "035510"], base_date: "2026-03-31" });
const r = b.structuredContent?.out?.find((o: any) => o.code === "035510")?.results?.find((x: any) => x.period === "Weekly-2Y");
expect(r?.raw === 0.759487, `베타 035510 W2Y 2026-03-31 = 0.759487 (${r?.raw})`);
const bk = await call("beta_regression", { stock_codes: ["035510"], base_date: "20261015", periods: ["Weekly-1Y", "Monthly-3Y"], market_index: "KOSDAQ" });
expect(!bk.isError && bk.structuredContent?.index === "KOSDAQ", "베타 KOSDAQ 지수·다른 기간");
const s = await call("naver_market_snapshot", { stock_code: "005930" });
const mv = s.structuredContent?.indicators?.find((i: any) => i.key === "marketValue");
expect(!s.isError && mv?.value > 1e14, `네이버 시가총액 숫자 변환(${mv?.display} → ${mv?.value})`);
const t0 = Date.now();
const sec = await call("dart_business_section", { stock_code: "035510", year: "2025", subsections: '["매출"]', max_chars: 5000 });
if (sec.isError || !sec.structuredContent) console.log("SEC1", sec.content?.[0]?.text?.slice(0, 400));
expect(!sec.isError && sec.structuredContent?.subsections?.length === 7 && /매출 및 수주상황/.test(sec.content[0].text), `사업의 내용 — 하위 7개·선택 추출 (${Math.round((Date.now() - t0) / 1000)}초)`);
const sec2 = await call("dart_business_section", { stock_code: "035510", year: "2025", max_chars: 8000, part: 2 });
if (sec2.isError) console.log("SEC2", sec2.content?.[0]?.text?.slice(0, 400));
expect(!sec2.isError && sec2.structuredContent?.parts > 1 && sec2.structuredContent?.part === 2, "사업의 내용 — 쪽 나눠 받기");
const sec3 = await call("dart_business_section", { stock_code: "035510", year: "2031" });
expect(!!sec3.isError, "없는 결산연도 → 오류 안내");

srv.close();
console.log(`\nfailures=${failures}`);
process.exit(failures ? 1 : 0);
