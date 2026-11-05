import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCalcTools } from "./tools-calc.js";
import { registerMarketTools } from "./tools-market.js";
import { registerEbitdaTools } from "./tools-ebitda.js";
import { registerDebtTools } from "./tools-debt.js";
import { registerAuditTools } from "./tools-audit.js";

export const SERVER_VERSION = "1.3.0";

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "valuation-mcp", version: SERVER_VERSION },
    {
      instructions:
        "밸류에이션 계산·조회 서버. 시장금리(ECOS)·WACC·DCF·피어 통계는 계산 도구이고, 베타 회귀·네이버 당일 지표·DART 사업의 내용·EBITDA 입력값(감가상각비 연간/TTM)은 조회 도구다. " +
        "이자부부채 분류(dart_interest_bearing_debt)는 외부 valuation_get_data 의 ibd 와 같은 규칙으로 자체 산정한다. 감사보고서만 내는 비상장사의 실적·현금·자본·감가상각비는 dart_audit_financials 로 받는다. 피어 모집단(peergroup_get_population)과 분기말 밸류에이션 묶음(valuation_get_data)은 이 서버에 없고 kr-valuation-data 서버를 쓴다. " +
        "그 결과를 peer_statistics 의 peers 로 넘기면 멀티플·언레버드 베타 분포를 낸다. 숫자는 손으로 다시 계산하지 말고 도구 결과를 그대로 인용한다.",
    },
  );
  registerCalcTools(server);
  registerMarketTools(server);
  registerEbitdaTools(server);
  registerDebtTools(server);
  registerAuditTools(server);
  return server;
}
