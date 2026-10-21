// valuation-mcp / api/mcp.ts — Vercel 서버리스 진입점 (POST 전용 JSON-RPC over Streamable HTTP)
// 구조와 접근 게이트는 dart-mcp/api/mcp.js 와 같다. 운영 절차는 sys-mcp-gatekey 스킬 참조.
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "../lib/server.js";

export const config = { api: { bodyParser: true } };

// ─── 접근 게이트 ───────────────────────────────────────────
//   MCP_GATE_KEYS : 허용 키 목록(쉼표 구분). 비어 있으면 게이트 비활성.
//   MCP_GATE_MODE : "enforce"면 키가 없거나 목록에 없을 때 401. 그 밖이면 통과시키고 로그만 남긴다.
// 로그에는 키 전문 대신 발급 대상 식별자(plk_<대상>_… 의 <대상>)만 남긴다.
// 호출마다 읽는다 — 모듈 로드 시점에 고정하면 테스트·재설정에서 값이 어긋난다.
const gateKeys = () => (process.env.MCP_GATE_KEYS || "").split(",").map(s => s.trim()).filter(Boolean);
const gateMode = () => (process.env.MCP_GATE_MODE || "observe").trim().toLowerCase();

function label(k: string | null): string {
  if (!k) return "(none)";
  const m = String(k).match(/^plk_([A-Za-z0-9]+)_/);
  return m ? m[1] : `${String(k).slice(0, 8)}…`;
}

type Req = IncomingMessage & { query?: Record<string, string | string[]>; body?: unknown };

function gate(req: Req, res: ServerResponse): boolean {
  let k: string | null = null;
  const q = req.query?.k;
  if (typeof q === "string") k = q;
  if (!k) { try { k = new URL(req.url ?? "", "http://localhost").searchParams.get("k"); } catch { k = null; } }
  const keys = gateKeys(), mode = gateMode();
  const allowed = keys.length === 0 || (!!k && keys.includes(k));
  console.log(`[gate] mode=${mode} method=${req.method} caller=${label(k)} allowed=${allowed}`);
  if (!allowed && mode === "enforce") {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "접근 권한이 없습니다. 이 서버는 발급받은 게이트키가 포함된 주소(…/api/mcp?k=<발급키>)로만 호출할 수 있습니다." } }));
    return false;
  }
  return true;
}

export default async function handler(req: Req, res: ServerResponse) {
  if (!gate(req, res)) return;
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Method not allowed. Use POST." }));
    return;
  }
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("valuation-mcp handler error:", err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal server error" } }));
    }
  }
}
