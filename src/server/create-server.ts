/**
 * MCP 서버 팩토리 — Vercel 및 HTTP 서버 공용
 * index.ts의 main() 실행 없이 서버 인스턴스만 생성
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { LawApiClient } from "../lib/api-client.js"
import { registerTools } from "../tool-registry.js"
import { VERSION } from "../version.js"
import { type ToolProfile } from "../lib/tool-profiles.js"

const LAW_OC = process.env.LAW_OC || process.env.KOREAN_LAW_API_KEY || ""
export const apiClient = new LawApiClient({ apiKey: LAW_OC })

export function createMcpServer(profile?: ToolProfile): Server {
  const s = new Server(
    { name: "korean-law", version: VERSION },
    { capabilities: { tools: {} } }
  )
  registerTools(s, apiClient, profile ?? "full")
  return s
}
