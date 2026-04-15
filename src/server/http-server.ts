/**
 * Streamable HTTP 서버 - 리모트 배포용 (MCP 표준)
 *
 * createExpressApp() : Express 앱 반환 (Vercel serverless 진입점용)
 * startHTTPServer()  : createExpressApp() + app.listen() (Fly.io / 자체 서버용)
 */

import express from "express"
import { randomUUID } from "node:crypto"
import type { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { InMemoryEventStore } from "@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { sessionStore, setSessionApiKey, deleteSession } from "../lib/session-state.js"
import { VERSION } from "../version.js"
import { type ToolProfile, parseProfile } from "../lib/tool-profiles.js"

// 세션 정보 (Transport + Server + 마지막 접근 시간)
interface SessionInfo {
  transport: StreamableHTTPServerTransport
  server: Server
  lastAccess: number
}

// 세션 맵 — 모듈 수준으로 유지해 Vercel warm instance 간 재사용
const MAX_SESSIONS = 100
const sessions = new Map<string, SessionInfo>()

/**
 * Express 앱 생성 및 설정 반환
 * Vercel serverless: `export default createExpressApp(createMcpServer)`
 * 자체 서버:         `createExpressApp(fn).listen(port)`
 */
export function createExpressApp(createServer: (profile?: ToolProfile) => Server): express.Application {
  const app = express()
  // Vercel / Fly.io proxy 뒤에서 실제 클라이언트 IP 인식
  app.set("trust proxy", true)
  app.use(express.json({ limit: "100kb" }))

  // 10분 idle 세션 자동 정리 (2분마다 체크)
  const SESSION_MAX_IDLE = 10 * 60 * 1000
  setInterval(() => {
    const now = Date.now()
    let cleaned = 0
    for (const [sessionId, session] of sessions) {
      if (now - session.lastAccess > SESSION_MAX_IDLE) {
        try {
          session.transport.close()
          session.server.close().catch(() => {})
        } catch { /* ignore */ }
        sessions.delete(sessionId)
        deleteSession(sessionId)
        cleaned++
      }
    }
    if (cleaned > 0) {
      console.error(`[Session Cleanup] Removed ${cleaned} idle sessions (remaining: ${sessions.size})`)
    }
  }, 2 * 60 * 1000).unref()

  // Rate Limiting (RATE_LIMIT_RPM 환경변수, 기본: 60 req/min per IP)
  const rateLimitRpm = parseInt(process.env.RATE_LIMIT_RPM || "60", 10)
  const rateBuckets = new Map<string, { count: number; resetAt: number }>()

  if (rateLimitRpm > 0) {
    app.use((req, res, next) => {
      if (req.path === "/health" || req.path === "/") return next()

      const ip = req.ip || req.socket.remoteAddress || "unknown"
      const now = Date.now()
      let bucket = rateBuckets.get(ip)

      if (!bucket || now >= bucket.resetAt) {
        bucket = { count: 0, resetAt: now + 60_000 }
        rateBuckets.set(ip, bucket)
      }

      bucket.count++

      if (bucket.count > rateLimitRpm) {
        res.status(429).json({ error: "Too many requests. Try again later." })
        return
      }
      next()
    })

    // 5분마다 만료된 버킷 정리
    setInterval(() => {
      const now = Date.now()
      for (const [ip, bucket] of rateBuckets) {
        if (now >= bucket.resetAt) rateBuckets.delete(ip)
      }
    }, 5 * 60 * 1000).unref()
  }

  // CORS 및 보안 헤더
  const corsOrigin = process.env.CORS_ORIGIN || "*"
  if (corsOrigin === "*") {
    console.error("⚠️  CORS_ORIGIN 미설정 — 모든 도메인 허용 중. 프로덕션에서는 CORS_ORIGIN 환경변수를 설정하세요.")
  }
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", corsOrigin)
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
    res.header("Access-Control-Allow-Headers", "Content-Type, mcp-session-id, last-event-id")
    res.header("X-Content-Type-Options", "nosniff")
    res.header("X-Frame-Options", "DENY")
    res.header("Referrer-Policy", "strict-origin-when-cross-origin")
    if (req.method === "OPTIONS") {
      return res.sendStatus(200)
    }
    next()
  })

  // 헬스체크 엔드포인트
  app.get("/", (req, res) => {
    res.json({
      name: "Korean Law MCP Server",
      version: VERSION,
      status: "running",
      transport: "streamable-http",
      endpoints: {
        mcp: "/mcp",
        "mcp-lite": "/mcp?profile=lite",
        health: "/health"
      },
      profiles: {
        lite: "14 tools (chains + meta, for web clients)",
        full: "all tools (default)"
      }
    })
  })

  app.get("/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() })
  })

  // POST /mcp - 클라이언트 요청 처리
  app.post("/mcp", async (req, res) => {
    console.error(`[POST /mcp] Received request`)

    // API 키: URL query > 각종 헤더
    const apiKeyFromQuery = req.query.oc as string | undefined
    const apiKeyFromHeader =
      apiKeyFromQuery ||
      req.headers["apikey"] ||
      req.headers["law_oc"] ||
      req.headers["law-oc"] ||
      req.headers["x-api-key"] ||
      req.headers["authorization"]?.replace(/^Bearer\s+/i, "") ||
      req.headers["x-law-oc"]

    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined
      let transport: StreamableHTTPServerTransport

      const existingSession = sessionId ? sessions.get(sessionId) : undefined

      if (existingSession) {
        console.error(`[POST /mcp] Reusing session: ${sessionId}`)
        transport = existingSession.transport
        existingSession.lastAccess = Date.now()

        if (apiKeyFromHeader) {
          setSessionApiKey(sessionId!, apiKeyFromHeader as string)
        }

        await sessionStore.run(sessionId, async () => {
          await transport.handleRequest(req, res, req.body)
        })
        return
      } else if (sessionId && !existingSession) {
        // 세션 없음 (Vercel cold start 포함) → 404로 클라이언트 재초기화 유도
        console.error(`[POST /mcp] Unknown session ID: ${sessionId} (returning 404 for re-init)`)
        res.status(404).json({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: "Session not found. Please reinitialize."
          },
          id: null
        })
        return
      } else if (!sessionId && isInitializeRequest(req.body)) {
        if (sessions.size >= MAX_SESSIONS) {
          res.status(503).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: `Max sessions (${MAX_SESSIONS}) reached. Try again later.` },
            id: null,
          })
          return
        }
        const profile = parseProfile(req.query.profile as string | undefined)
        console.error(`[POST /mcp] New initialization request (profile: ${profile})`)

        const eventStore = new InMemoryEventStore()
        const sessionServer = createServer(profile)
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          eventStore,
          onsessioninitialized: (sid) => {
            console.error(`[POST /mcp] Session initialized: ${sid}`)
            sessions.set(sid, {
              transport,
              server: sessionServer,
              lastAccess: Date.now()
            })
            if (apiKeyFromHeader) {
              setSessionApiKey(sid, apiKeyFromHeader as string)
            }
          }
        })

        transport.onclose = () => {
          const sid = transport.sessionId
          if (sid && sessions.has(sid)) {
            console.error(`[POST /mcp] Transport closed for session ${sid}`)
            sessions.delete(sid)
            deleteSession(sid)
          }
        }

        await sessionServer.connect(transport)
        await transport.handleRequest(req, res, req.body)
        return
      } else {
        console.error(`[POST /mcp] Invalid request: No valid session ID or init request`)
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: No valid session ID provided"
          },
          id: null
        })
        return
      }
    } catch (error) {
      console.error("[POST /mcp] Error:", error)
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error"
          },
          id: null
        })
      }
    }
  })

  // GET /mcp - SSE 스트림 (서버 알림용)
  app.get("/mcp", async (req, res) => {
    console.error(`[GET /mcp] SSE stream request`)

    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined
      const session = sessionId ? sessions.get(sessionId) : undefined

      if (!session) {
        console.error(`[GET /mcp] Unknown session ID: ${sessionId} (returning 404)`)
        res.status(404).send("Session not found. Please reinitialize.")
        return
      }

      session.lastAccess = Date.now()

      res.on("close", () => {
        console.error(`[GET /mcp] SSE connection closed for session ${sessionId}`)
      })

      await session.transport.handleRequest(req, res)
    } catch (error) {
      console.error("[GET /mcp] Error:", error)
      if (!res.headersSent) {
        res.status(500).send("Internal server error")
      }
    }
  })

  // DELETE /mcp - 세션 종료
  app.delete("/mcp", async (req, res) => {
    console.error(`[DELETE /mcp] Session termination request`)

    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined
      const session = sessionId ? sessions.get(sessionId) : undefined

      if (!session) {
        console.error(`[DELETE /mcp] Unknown session ID: ${sessionId} (returning 404)`)
        res.status(404).send("Session not found")
        return
      }

      await session.transport.handleRequest(req, res)
      sessions.delete(sessionId!)
      deleteSession(sessionId!)
      console.error(`[DELETE /mcp] Session removed: ${sessionId}`)
    } catch (error) {
      console.error("[DELETE /mcp] Error:", error)
      if (!res.headersSent) {
        res.status(500).send("Error processing session termination")
      }
    }
  })

  return app
}

/**
 * 자체 서버(Fly.io 등) 시작용 — createExpressApp() + app.listen()
 */
export async function startHTTPServer(createServer: (profile?: ToolProfile) => Server, port: number) {
  const app = createExpressApp(createServer)

  const expressServer = app.listen(port, "0.0.0.0", () => {
    console.error(`✓ Korean Law MCP server (HTTP mode) listening on port ${port}`)
    console.error(`✓ MCP endpoint: http://0.0.0.0:${port}/mcp`)
    console.error(`✓ Health check: http://0.0.0.0:${port}/health`)
    console.error(`✓ Transport: Streamable HTTP`)
  })

  async function gracefulShutdown(signal: string) {
    console.error(`${signal} received, shutting down server...`)

    for (const [sessionId, session] of sessions) {
      try {
        await session.transport.close()
        await session.server.close()
        sessions.delete(sessionId)
        deleteSession(sessionId)
      } catch (error) {
        console.error(`Error closing transport for session ${sessionId}:`, error)
      }
    }

    expressServer.close()
    console.error("Server shutdown complete")
    process.exit(0)
  }

  process.on("SIGINT", () => gracefulShutdown("SIGINT"))
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"))
}
