import http from "node:http";
import { URL } from "node:url";
import {
  users,
  surveys,
  createdSurveys,
  createdUsers,
  resetRuntimeData,
  CREDENTIALS,
  type Survey,
} from "./data.js";
import {
  loginPage,
  dashboardPage,
  usersPage,
  userDetailPage,
  userNewPage,
  surveysPage,
  surveyDetailPage,
  surveyNewPage,
  statsPage,
  settingsPage,
  notFoundPage,
} from "./pages.js";

const PORT = Number(process.env.FIXTURE_PORT ?? 3100);
const SESSION_COOKIE = "fixture_sid";
const sessions = new Set<string>();

function html(res: http.ServerResponse, body: string, status = 200): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function json(res: http.ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function redirect(res: http.ServerResponse, to: string, cookie?: string): void {
  const headers: http.OutgoingHttpHeaders = { Location: to };
  if (cookie) headers["Set-Cookie"] = cookie;
  res.writeHead(302, headers);
  res.end();
}

function isLoggedIn(req: http.IncomingMessage): boolean {
  const raw = req.headers.cookie ?? "";
  const sid = raw
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  return Boolean(sid && sessions.has(sid));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** 세션 id는 고정 카운터로 만든다. 난수를 쓰지 않아야 재현이 쉽다. */
let sessionSeq = 0;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  // ── 인증이 필요 없는 경로 ────────────────────────────────────────────
  if (path === "/login" && method === "GET") return html(res, loginPage());

  if (path === "/login" && method === "POST") {
    const body = await readBody(req);
    const form = new URLSearchParams(body);
    const id = form.get("loginId") ?? "";
    const pw = form.get("password") ?? "";
    if (id === CREDENTIALS.id && pw === CREDENTIALS.pw) {
      const sid = `sid-${++sessionSeq}`;
      sessions.add(sid);
      return redirect(res, "/dashboard", `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax`);
    }
    return html(res, loginPage("아이디 또는 비밀번호가 올바르지 않습니다."), 401);
  }

  if (path === "/logout") {
    return redirect(res, "/login", `${SESSION_COOKIE}=; Path=/; Max-Age=0`);
  }

  /** 테스트 하네스 전용: 런타임 생성 데이터 초기화 (탐색 결정성 확보에 쓴다) */
  if (path === "/__reset" && method === "POST") {
    resetRuntimeData();
    return json(res, { ok: true });
  }

  // ── 이하 전부 인증 필요 ──────────────────────────────────────────────
  if (!isLoggedIn(req)) {
    if (path.startsWith("/api/")) return json(res, { message: "unauthorized" }, 401);
    return redirect(res, "/login");
  }

  // ── API ─────────────────────────────────────────────────────────────
  // BUG-02: 모든 화면이 호출하는 공지 뱃지 API가 항상 404 (반복 → dedup 대상)
  if (path === "/api/notice/badge") {
    return json(res, { message: "notice service endpoint not found" }, 404);
  }

  // BUG-01: 통계 내보내기 API가 항상 500
  if (path === "/api/stats/export") {
    return json(res, { message: "export job failed: report template missing" }, 500);
  }

  if (path === "/api/surveys" && method === "POST") {
    const raw = await readBody(req);
    let payload: { title?: string; owner?: string; contact?: string; memo?: string } = {};
    try {
      payload = JSON.parse(raw);
    } catch {
      return json(res, { message: "invalid json" }, 400);
    }
    // 서버에서도 contact를 검증하지 않는다 (BUG-05는 클라이언트/서버 양쪽 모두 누락)
    const next: Survey = {
      id: 1000 + createdSurveys.length + 1,
      title: payload.title ?? "",
      owner: payload.owner ?? "",
      status: "DRAFT",
      responses: 0,
      createdAt: new Date().toISOString().slice(0, 10),
    };
    createdSurveys.push(next);
    return json(res, next, 201);
  }

  if (path === "/api/surveys" && method === "GET") {
    return json(res, [...surveys, ...createdSurveys]);
  }

  if (path === "/api/users" && method === "GET") {
    return json(res, [...users, ...createdUsers]);
  }

  // ── 화면 ────────────────────────────────────────────────────────────
  if (path === "/" ) return redirect(res, "/dashboard");
  if (path === "/dashboard") return html(res, dashboardPage());

  if (path === "/users") {
    return html(
      res,
      usersPage({
        keyword: url.searchParams.get("keyword") ?? "",
        sort: url.searchParams.get("sort") ?? "id",
        dir: url.searchParams.get("dir") === "desc" ? "desc" : "asc",
        page: Number(url.searchParams.get("page") ?? 1) || 1,
      }),
    );
  }
  if (path === "/users/new") return html(res, userNewPage());
  const userMatch = /^\/users\/(\d+)$/.exec(path);
  if (userMatch) {
    const id = Number(userMatch[1]);
    const u = [...users, ...createdUsers].find((x) => x.id === id);
    return u ? html(res, userDetailPage(u)) : html(res, notFoundPage(), 404);
  }

  if (path === "/surveys") return html(res, surveysPage(url.searchParams.get("status") ?? ""));
  if (path === "/surveys/new") return html(res, surveyNewPage());
  const surveyMatch = /^\/surveys\/(\d+)$/.exec(path);
  if (surveyMatch) {
    const id = Number(surveyMatch[1]);
    const s = [...surveys, ...createdSurveys].find((x) => x.id === id);
    return s ? html(res, surveyDetailPage(s)) : html(res, notFoundPage(), 404);
  }

  if (path === "/stats") return html(res, statsPage());
  if (path === "/settings") return html(res, settingsPage(url.searchParams.get("tab") ?? "general"));

  return html(res, notFoundPage(), 404);
});

server.listen(PORT, () => {
  console.log(`[fixture-admin] http://localhost:${PORT}`);
  console.log(`[fixture-admin] 로그인: ${CREDENTIALS.id} / ${CREDENTIALS.pw}`);
});
