/**
 * Vercel Serverless Function 진입점
 *
 * 빌드 순서: npm run build (tsc) → build/ 생성 → Vercel이 이 파일을 함수로 배포
 * 모든 요청은 vercel.json rewrite를 통해 여기로 라우팅됨
 *
 * Vercel warm instance: sessions Map이 메모리에 유지 → 세션 재사용 가능
 * Vercel cold start:    세션 없음 → 클라이언트가 404 수신 후 자동 재초기화
 */

import { createMcpServer } from "../build/server/create-server.js"
import { createExpressApp } from "../build/server/http-server.js"

const app = createExpressApp(createMcpServer)

export default app
