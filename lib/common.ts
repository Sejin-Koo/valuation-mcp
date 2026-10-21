/** 도구 등록 공통 — 인자 강제변환, 응답 형식, registerTool 추론 차단 도우미. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const num = () => z.coerce.number();
export const bool = () => z.union([z.boolean(), z.enum(["true", "false"])]).transform(v => v === true || v === "true");
export const jsonArray = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess(v => (typeof v === "string" ? JSON.parse(v) : v), z.array(item));
export const jsonObject = <T extends z.ZodTypeAny>(shape: T) =>
  z.preprocess(v => (typeof v === "string" ? JSON.parse(v) : v), shape);
export const yyyymmdd = () => z.string().regex(/^\d{4}-?\d{2}-?\d{2}$/, "YYYYMMDD 또는 YYYY-MM-DD");

export const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
export const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: `오류: ${(e as Error).message}` }], isError: true });


/**
 * registerTool 의 제네릭 추론은 z.preprocess·transform 이 섞인 스키마에서 TS2589(타입 추론 과다)로 멈춘다.
 * 런타임 검증은 그대로 SDK 가 하고, 타입은 z.infer 로 핸들러에 직접 준다 — 추론만 이 한 곳에서 끊는다.
 */
export type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
export function defineTool<S extends z.ZodTypeAny>(
  server: McpServer, name: string,
  meta: { title: string; description: string; annotations?: Record<string, boolean> },
  schema: S, fn: (args: z.infer<S>) => Promise<ToolResult>,
): void {
  (server.registerTool as unknown as (n: string, m: unknown, f: unknown) => void).call(server, name, { ...meta, inputSchema: schema }, fn);
}

