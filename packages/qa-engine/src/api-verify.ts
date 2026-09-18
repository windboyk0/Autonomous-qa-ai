import { readFileSync } from "node:fs";
import { request as pwRequest, type APIRequestContext } from "playwright";
import yaml from "js-yaml";
import {
  REDACTED,
  SENSITIVE_BODY_KEYS,
  type ApiTestCase,
  type ApiVerifyConfig,
  type CrudScope,
  type IssueCandidate,
  type RunConfig,
  type Severity,
} from "@qa/shared";
import type { BrowserSession } from "./browser.js";
import type { RunContext } from "./run-context.js";
import { log } from "./emitter.js";

/**
 * API Verify Agent (CLAUDE.md 4부, Phase 17).
 *
 * 화면 조작과 무관하게 명세/사용자가 준 엔드포인트 목록을 **직접 호출**해
 * 상태코드·응답 스키마·응답 시간을 검증한다.
 *
 * 저장소를 뒤져 엔드포인트를 추측하지 않는다 — 명세 또는 manualCases에 있는
 * 것만 부른다(§16-1과 같은 결, 여기서는 실제 HTTP 부작용이 걸려 있어 더 보수적이다).
 */

const SLOW_MS = 3000;
const SENSITIVE = new Set<string>(SENSITIVE_BODY_KEYS);

export interface ApiVerifyOutcome {
  candidates: IssueCandidate[];
  executed: number;
  pass: number;
  fail: number;
  /** 안전 정책으로 계획만 세우고 실행하지 않은 케이스. 리포트의 "미검증"에 그대로 들어간다. */
  plannedNotExecuted: string[];
  notes: string[];
}

// ─────────────────────────────────────────────────────── 스펙 파싱

interface ResolvedCase {
  tc: ApiTestCase;
  /** 성공 응답의 JSON Schema (있으면). $ref 해석은 검증 시점에 doc을 참조해서 한다. */
  schema: unknown | null;
}

interface LoadedSpec {
  cases: ResolvedCase[];
  doc: unknown | null;
  errors: string[];
}

const METHODS = ["get", "head", "post", "put", "patch", "delete"] as const;

function extractFromOpenApi(doc: Record<string, unknown>): ResolvedCase[] {
  const out: ResolvedCase[] = [];
  const paths = (doc.paths as Record<string, Record<string, unknown>>) ?? {};
  const docSecurity = Array.isArray(doc.security) ? (doc.security as unknown[]) : [];

  for (const [path, item] of Object.entries(paths)) {
    for (const method of METHODS) {
      const op = item?.[method] as Record<string, unknown> | undefined;
      if (!op || typeof op !== "object") continue;

      const responses = (op.responses as Record<string, unknown>) ?? {};
      const expectedStatus = Object.keys(responses)
        .map((k) => k.trim())
        .filter((k) => /^\d{3}$/.test(k))
        .map(Number);

      const successKey = Object.keys(responses).find((k) => /^2\d\d$/.test(k));
      const successResponse = successKey
        ? (responses[successKey] as Record<string, unknown> | undefined)
        : undefined;
      const content = successResponse?.content as Record<string, unknown> | undefined;
      const mediaType = content?.["application/json"] as Record<string, unknown> | undefined;
      const schema = mediaType?.schema ?? null;

      const opSecurity = Array.isArray(op.security) ? (op.security as unknown[]) : docSecurity;

      out.push({
        tc: {
          method: method.toUpperCase() as ApiTestCase["method"],
          path,
          headers: {},
          queryParams: {},
          body: null,
          exampleValues: {},
          expectedStatus,
          expectedSchemaRef: schema ? `${method.toUpperCase()} ${path} 응답 스키마` : null,
          requiresAuth: opSecurity.length > 0,
        },
        schema,
      });
    }
  }
  return out;
}

const caseKey = (method: string, path: string): string => `${method.toUpperCase()} ${path}`;

/**
 * manualCases는 spec에서 유도한 값을 **덮어쓴다** — 사용자가 알고 있는
 * exampleValues·expectedStatus가 스펙의 일반값보다 정확하다. spec에 없는
 * manualCases는 그대로 추가된다("명세 없는 사내 API" 대응, §6-1).
 */
function loadSpecCases(cfg: ApiVerifyConfig): LoadedSpec {
  const manual: ResolvedCase[] = cfg.manualCases.map((tc) => ({ tc, schema: null }));

  if (cfg.specSource === "manual" || cfg.specPath.trim() === "") {
    return { cases: manual, doc: null, errors: [] };
  }

  let raw: string;
  try {
    raw = readFileSync(cfg.specPath, "utf8");
  } catch (err) {
    return {
      cases: manual,
      doc: null,
      errors: [`스펙 파일을 읽지 못했습니다 (${cfg.specPath}): ${String(err)}. manualCases만 사용합니다.`],
    };
  }

  let doc: Record<string, unknown>;
  try {
    doc = (/\.ya?ml$/i.test(cfg.specPath) ? yaml.load(raw) : JSON.parse(raw)) as Record<string, unknown>;
  } catch (err) {
    return {
      cases: manual,
      doc: null,
      errors: [`스펙을 파싱하지 못했습니다 (${cfg.specPath}): ${String(err)}. manualCases만 사용합니다.`],
    };
  }

  const specCases = extractFromOpenApi(doc);
  const specKeys = new Set(specCases.map((c) => caseKey(c.tc.method, c.tc.path)));
  const overrides = new Map(manual.map((c) => [caseKey(c.tc.method, c.tc.path), c]));

  const merged = specCases.map((c) => overrides.get(caseKey(c.tc.method, c.tc.path)) ?? c);
  const manualOnly = manual.filter((c) => !specKeys.has(caseKey(c.tc.method, c.tc.path)));

  return { cases: [...merged, ...manualOnly], doc, errors: [] };
}

/** manualCases가 expectedSchemaRef로 스펙의 컴포넌트를 가리킨 경우 해석한다. */
function resolveManualSchema(ref: string | null, doc: unknown): unknown | null {
  if (!ref || !doc) return null;
  if (!ref.startsWith("#/")) return null;
  let cur: unknown = doc;
  for (const part of ref.slice(2).split("/")) {
    if (cur === null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur ?? null;
}

// ─────────────────────────────────────────────────────── 안전 정책

/** 값 안에 AUTO-QA 마커가 있는가. 쓰기 호출의 유일한 실행 근거다(CLAUDE.md §10). */
function containsAutoQaMarker(value: unknown): boolean {
  if (typeof value === "string") return value.includes("AUTO-QA");
  if (Array.isArray(value)) return value.some(containsAutoQaMarker);
  if (value && typeof value === "object") return Object.values(value).some(containsAutoQaMarker);
  return false;
}

function planFor(
  tc: ApiTestCase,
  cfg: ApiVerifyConfig,
  crud: CrudScope,
): { run: boolean; reason: string } {
  if (tc.method === "GET" || tc.method === "HEAD") return { run: true, reason: "" };

  const hasMarker =
    containsAutoQaMarker(tc.body) ||
    containsAutoQaMarker(tc.exampleValues) ||
    containsAutoQaMarker(tc.queryParams);

  if (tc.method === "DELETE") {
    if (!cfg.allowWriteMethods)
      return { run: false, reason: "DELETE는 allowWriteMethods가 꺼져 있어 실행하지 않았습니다." };
    if (!crud.deleteConsent)
      return { run: false, reason: "DELETE는 별도 삭제 동의(deleteConsent)가 없어 실행하지 않았습니다." };
    if (!hasMarker)
      return {
        run: false,
        reason: "DELETE 대상에서 AUTO-QA 소유 표식을 찾지 못해 실행하지 않았습니다 (실데이터 보호).",
      };
    return { run: true, reason: "" };
  }

  // POST / PUT / PATCH
  if (!cfg.allowWriteMethods)
    return {
      run: false,
      reason: `${tc.method}은(는) allowWriteMethods가 꺼져 있어 계획만 세우고 실행하지 않았습니다.`,
    };
  if (!hasMarker)
    return {
      run: false,
      reason: `${tc.method} 요청에 AUTO-QA 마커를 주입할 필드가 없어 실행하지 않았습니다 (안전한 테스트 데이터 생성 불가).`,
    };
  return { run: true, reason: "" };
}

// ─────────────────────────────────────────────────────── 스키마 검증 (최소 구현)

/**
 * 필수 필드·타입만 본다. **additionalProperties는 항상 허용한다** — 모르는 필드로
 * 검증을 실패시키면 오탐이 쏟아진다(CLAUDE.md §30 "오탐을 늘리는 자체 검출기 금지").
 */
function validateSchema(schema: unknown, value: unknown, doc: unknown, path = ""): string[] {
  if (!schema || typeof schema !== "object") return [];
  const s = schema as Record<string, unknown>;

  if (typeof s.$ref === "string") {
    const resolved = resolveManualSchema(s.$ref, doc);
    return resolved ? validateSchema(resolved, value, doc, path) : [];
  }

  if (value === null) {
    if (s.nullable === true) return [];
    // nullable이 명시되지 않은 스펙은 흔히 느슨하므로 null을 바로 실패시키지 않는다.
    return [];
  }

  const label = path || "(root)";
  const errors: string[] = [];
  const type = s.type as string | undefined;

  if (type === "object" || (s.properties && type === undefined)) {
    if (typeof value !== "object" || Array.isArray(value)) {
      return [`${label}: object 타입이어야 합니다`];
    }
    const required = Array.isArray(s.required) ? (s.required as string[]) : [];
    for (const req of required) {
      if (!(req in (value as object))) errors.push(`${path ? `${path}.${req}` : req}: 필수 필드가 없습니다`);
    }
    const props = (s.properties as Record<string, unknown>) ?? {};
    for (const [k, propSchema] of Object.entries(props)) {
      if (k in (value as Record<string, unknown>)) {
        errors.push(
          ...validateSchema(propSchema, (value as Record<string, unknown>)[k], doc, path ? `${path}.${k}` : k),
        );
      }
    }
  } else if (type === "array") {
    if (!Array.isArray(value)) return [`${label}: array 타입이어야 합니다`];
    if (s.items) {
      value.forEach((item, i) => errors.push(...validateSchema(s.items, item, doc, `${path}[${i}]`)));
    }
  } else if (type === "string") {
    if (typeof value !== "string") errors.push(`${label}: string 타입이어야 합니다`);
  } else if (type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value))
      errors.push(`${label}: integer 타입이어야 합니다`);
  } else if (type === "number") {
    if (typeof value !== "number") errors.push(`${label}: number 타입이어야 합니다`);
  } else if (type === "boolean") {
    if (typeof value !== "boolean") errors.push(`${label}: boolean 타입이어야 합니다`);
  }

  return errors.slice(0, 10);
}

// ─────────────────────────────────────────────────────── 마스킹

function maskDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE.has(k.toLowerCase()) ? REDACTED : maskDeep(v);
    }
    return out;
  }
  return value;
}

/** 성공한 필드는 값이 아니라 **이름·타입만** 남긴다(§1.5-4의 절충안). */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.length > 0 ? [shapeOf(value[0])] : [];
  if (value && typeof value === "object") {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
    }
    return out;
  }
  return typeof value;
}

// ─────────────────────────────────────────────────────── 실행

function fillPath(path: string, values: Record<string, string>): string {
  return path.replace(/\{([^}]+)\}|:([A-Za-z_]\w*)/g, (_m, a: string | undefined, b: string | undefined) => {
    const key = (a ?? b)!;
    return values[key] ?? "1";
  });
}

let candSeq = 0;

function makeCandidate(input: {
  ruleId: string;
  title: string;
  description: string;
  severity: Severity;
  method: string;
  endpointTemplate: string;
  status: number | null;
  evidenceId: string;
}): IssueCandidate {
  candSeq += 1;
  return {
    id: `api-cand-${String(candSeq).padStart(4, "0")}`,
    source: "network",
    codeRefs: [],
    apiRef: { method: input.method, endpointTemplate: input.endpointTemplate, status: input.status },
    ruleId: input.ruleId,
    title: input.title,
    description: input.description,
    stateKey: "api-verify",
    screenName: "API 검증",
    suggestedSeverity: input.severity,
    dedupKey: `api|${input.ruleId}|${input.method}|${input.endpointTemplate}`,
    evidenceIds: [input.evidenceId],
    aiRationale: null,
    detectedAt: new Date().toISOString(),
  };
}

interface PickedContext {
  ctx: APIRequestContext | null;
  owns: boolean;
  skipReason: string | null;
}

async function pickContext(
  cfg: ApiVerifyConfig,
  session: BrowserSession,
  loginOk: boolean,
): Promise<PickedContext> {
  if (cfg.authMode === "reuse-session") {
    if (!loginOk) {
      return {
        ctx: null,
        owns: false,
        skipReason: "reuse-session 모드인데 로그인이 되어 있지 않아 API 검증을 건너뜁니다.",
      };
    }
    return { ctx: session.context.request, owns: false, skipReason: null };
  }
  if (cfg.authMode === "bearer") {
    if (cfg.bearerToken.trim() === "") {
      return { ctx: null, owns: false, skipReason: "bearer 모드인데 bearerToken이 비어 있어 API 검증을 건너뜁니다." };
    }
    const ctx = await pwRequest.newContext({
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: { Authorization: `Bearer ${cfg.bearerToken}` },
    });
    return { ctx, owns: true, skipReason: null };
  }
  // "none"
  const ctx = await pwRequest.newContext({ ignoreHTTPSErrors: true });
  return { ctx, owns: true, skipReason: null };
}

export async function verifyApis(input: {
  config: RunConfig;
  ctx: RunContext;
  session: BrowserSession;
  /** 로그인 단계 결과. reuse-session 모드의 실행 가능 여부를 가른다. */
  loginOk: boolean;
}): Promise<ApiVerifyOutcome> {
  const { config, ctx, session } = input;
  const cfg = config.apiVerify;
  const candidates: IssueCandidate[] = [];
  const plannedNotExecuted: string[] = [];
  const notes: string[] = [];
  let executed = 0;
  let pass = 0;
  let fail = 0;

  const spec = loadSpecCases(cfg);
  notes.push(...spec.errors);

  if (spec.cases.length === 0) {
    notes.push("실행할 API 케이스가 없습니다 (specPath·manualCases를 확인하세요).");
    return { candidates, executed, pass, fail, plannedNotExecuted, notes };
  }

  const picked = await pickContext(cfg, session, input.loginOk);
  if (picked.skipReason) {
    notes.push(picked.skipReason);
    for (const c of spec.cases) plannedNotExecuted.push(`${c.tc.method} ${c.tc.path} — ${picked.skipReason}`);
    return { candidates, executed, pass, fail, plannedNotExecuted, notes };
  }
  const reqCtx = picked.ctx!;
  const toDispose: APIRequestContext[] = [];
  if (picked.owns) toDispose.push(reqCtx);

  let anonCtxCache: APIRequestContext | undefined;
  const getAnonCtx = async (): Promise<APIRequestContext | null> => {
    if (anonCtxCache) return anonCtxCache;
    try {
      const created = await pwRequest.newContext({ ignoreHTTPSErrors: true });
      anonCtxCache = created;
      toDispose.push(created);
      return created;
    } catch {
      return null;
    }
  };

  let callSeq = 0;
  const writeEvidence = (label: string, detail: unknown, summary: string) => {
    callSeq += 1;
    const rel = ctx.writeJson("network", `api-verify-${String(callSeq).padStart(3, "0")}-${label}.json`, detail);
    return ctx.addEvidence({
      kind: "network",
      stateKey: "api-verify",
      screenName: "API 검증",
      path: rel,
      summary,
    });
  };

  for (const { tc, schema } of spec.cases) {
    const where = `${tc.method} ${tc.path}`;
    const plan = planFor(tc, cfg, config.crud);
    if (!plan.run) {
      plannedNotExecuted.push(`${where} — ${plan.reason}`);
      continue;
    }

    const filledPath = fillPath(tc.path, tc.exampleValues);
    let url: string;
    try {
      url = new URL(filledPath, config.targetUrl).toString();
    } catch (err) {
      notes.push(`${where}: URL을 만들지 못했습니다 (${String(err)}).`);
      continue;
    }

    executed += 1;
    const t0 = Date.now();
    let res: Awaited<ReturnType<APIRequestContext["fetch"]>> | null = null;
    let networkError: string | null = null;

    try {
      res = await reqCtx.fetch(url, {
        method: tc.method,
        headers: Object.keys(tc.headers).length > 0 ? tc.headers : undefined,
        params: Object.keys(tc.queryParams).length > 0 ? tc.queryParams : undefined,
        data: tc.body ?? undefined,
        timeout: cfg.timeoutMs,
        failOnStatusCode: false,
      });
    } catch (err) {
      networkError = err instanceof Error ? err.message : String(err);
    }
    const durationMs = Date.now() - t0;

    if (!res) {
      fail += 1;
      const isTimeout = /timeout/i.test(networkError ?? "");
      const ev = writeEvidence(
        "unreachable",
        { method: tc.method, url, error: networkError },
        `${where} 호출 실패: ${networkError}`,
      );
      candidates.push(
        makeCandidate({
          ruleId: isTimeout ? "API-TIMEOUT" : "API-UNREACHABLE",
          title: `${isTimeout ? "응답 지연" : "연결 실패"}: ${where}`,
          description: `${where} 직접 호출이 실패했습니다.\n사유: ${networkError}`,
          severity: "HIGH",
          method: tc.method,
          endpointTemplate: filledPath,
          status: null,
          evidenceId: ev.id,
        }),
      );
      continue;
    }

    const status = res.status();
    let parsedBody: unknown = null;
    let bodyParseError: string | null = null;
    try {
      const text = await res.text();
      if (text.trim() !== "") parsedBody = JSON.parse(text);
    } catch (err) {
      bodyParseError = err instanceof Error ? err.message : String(err);
    }

    const statusOk = tc.expectedStatus.length === 0 || tc.expectedStatus.includes(status);
    if (!statusOk) {
      fail += 1;
      const ev = writeEvidence(
        "status-mismatch",
        { method: tc.method, url, status, expected: tc.expectedStatus, durationMs },
        `${where} → ${status} (기대: ${tc.expectedStatus.join("/")})`,
      );
      candidates.push(
        makeCandidate({
          ruleId: "API-STATUS-MISMATCH",
          title: `상태코드 불일치: ${where}`,
          description:
            `${where} 요청이 HTTP ${status}를 반환했습니다. 기대한 상태코드: ${tc.expectedStatus.join(", ")}.`,
          severity: status >= 500 ? "HIGH" : status >= 400 ? "MEDIUM" : "LOW",
          method: tc.method,
          endpointTemplate: filledPath,
          status,
          evidenceId: ev.id,
        }),
      );
    } else if (schema && status < 300 && status >= 200) {
      const errors = bodyParseError
        ? [`응답 본문을 JSON으로 파싱하지 못했습니다: ${bodyParseError}`]
        : validateSchema(schema, parsedBody, spec.doc);

      if (errors.length > 0) {
        fail += 1;
        const ev = writeEvidence(
          "schema-invalid",
          { method: tc.method, url, status, errors, bodySnippet: JSON.stringify(maskDeep(parsedBody)).slice(0, 2000) },
          `${where} 스키마 불일치 ${errors.length}건`,
        );
        candidates.push(
          makeCandidate({
            ruleId: "API-SCHEMA-INVALID",
            title: `응답 스키마 불일치: ${where}`,
            description: `${where} 응답이 선언된 스키마와 다릅니다.\n${errors.join("\n")}`,
            severity: "MEDIUM",
            method: tc.method,
            endpointTemplate: filledPath,
            status,
            evidenceId: ev.id,
          }),
        );
      } else {
        pass += 1;
        // 성공한 필드는 값이 아니라 이름·타입만 남긴다.
        writeEvidence(
          "ok",
          { method: tc.method, url, status, durationMs, bodyShape: shapeOf(parsedBody) },
          `${where} → ${status} (${durationMs}ms) · 스키마 통과`,
        );
      }
    } else {
      pass += 1;
      writeEvidence("ok", { method: tc.method, url, status, durationMs }, `${where} → ${status} (${durationMs}ms)`);
    }

    if (durationMs > SLOW_MS) {
      const ev = writeEvidence("slow", { method: tc.method, url, durationMs }, `${where} 응답 ${durationMs}ms`);
      candidates.push(
        makeCandidate({
          ruleId: "NET-SLOW",
          title: `느린 응답: ${where}`,
          description: `${where} 직접 호출 응답에 ${durationMs}ms가 걸렸습니다 (기준 ${SLOW_MS}ms).`,
          severity: "LOW",
          method: tc.method,
          endpointTemplate: filledPath,
          status,
          evidenceId: ev.id,
        }),
      );
    }

    // ── 보너스: 런타임 권한 우회 탐지 (§1.5-5) ─────────────────────────
    if (tc.requiresAuth && cfg.authMode !== "none") {
      const anon = await getAnonCtx();
      if (anon) {
        try {
          const anonRes = await anon.fetch(url, {
            method: tc.method,
            params: Object.keys(tc.queryParams).length > 0 ? tc.queryParams : undefined,
            timeout: cfg.timeoutMs,
            failOnStatusCode: false,
          });
          const anonStatus = anonRes.status();
          if (anonStatus >= 200 && anonStatus < 300) {
            const ev = writeEvidence(
              "auth-bypass",
              { method: tc.method, url, anonStatus },
              `${where} 비로그인 호출이 ${anonStatus}을 반환했습니다`,
            );
            candidates.push(
              makeCandidate({
                ruleId: "API-AUTH-BYPASS",
                title: `권한 검사 없이 접근 가능: ${where}`,
                description:
                  `${where} 는 스펙상 인증이 필요하지만, 로그인 없이 호출했을 때도 ` +
                  `HTTP ${anonStatus}이 반환되었습니다. 권한 검사가 누락되었을 수 있습니다.`,
                severity: "CRITICAL",
                method: tc.method,
                endpointTemplate: filledPath,
                status: anonStatus,
                evidenceId: ev.id,
              }),
            );
          }
        } catch {
          // 보너스 검사다. 실패해도 본 검증 결과에는 영향을 주지 않는다.
        }
      }
    }
  }

  for (const c of toDispose) await c.dispose().catch(() => undefined);

  log(
    "info",
    `API 검증: 실행 ${executed}건 (PASS ${pass} · FAIL ${fail}) · 미실행 ${plannedNotExecuted.length}건`,
  );

  return { candidates, executed, pass, fail, plannedNotExecuted, notes };
}
