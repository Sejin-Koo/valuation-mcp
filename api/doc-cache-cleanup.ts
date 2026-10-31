// valuation-mcp / api/doc-cache-cleanup.ts — DART 원문 보관소 정리(매일 1회, vercel.json crons)
// 24시간이 지난 보관본을 지운다. 만료는 읽을 때도 판정하므로(lib/doc-cache.ts) 이 작업은 용량만 관리한다.
// Vercel Cron 은 CRON_SECRET 이 있으면 Authorization: Bearer <값> 을 붙여 부른다. 값이 없거나 다르면 실행하지 않는다
// — 누구나 부를 수 있게 열어 두면 목록 조회 횟수(Blob 고급 작업 한도)를 남이 소모할 수 있기 때문이다.
import type { IncomingMessage, ServerResponse } from "node:http";
import { cacheEnabled, purgeExpired } from "../lib/doc-cache.js";

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const secret = process.env.CRON_SECRET;
  res.setHeader("Content-Type", "application/json");
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: "unauthorized" })); return;
  }
  if (!cacheEnabled()) { res.end(JSON.stringify({ ok: true, skipped: "보관소 미설정" })); return; }
  try {
    const r = await purgeExpired();
    console.log(`[doc-cache-cleanup] scanned=${r.scanned} deleted=${r.deleted}`);
    res.end(JSON.stringify({ ok: true, ...r }));
  } catch (e) {
    res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
  }
}
