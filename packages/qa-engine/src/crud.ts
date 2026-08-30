import type { Page } from "playwright";
import type {
  CrudResult,
  IssueCandidate,
  NetworkEntry,
  RunConfig,
  StateGraph,
} from "@qa/shared";
import { emit, log } from "./emitter.js";
import { captureScreen, type ScreenCapture } from "./capture.js";
import type { Collector } from "./collector.js";
import type { RunContext } from "./run-context.js";
import { analyzeForm, isFillable, type FormField, type FormInfo } from "./forms.js";
import { TestDataLedger, isOwnedByQa, valueFor, type CreatedRecord } from "./testdata.js";
import { sha1 } from "./normalize.js";
import { discoverActions } from "./discover.js";
import { OPEN_FORM_REASON } from "./classify.js";
import type { RunControl } from "./control.js";

/**
 * CRUD Test Agent (`.claude/agents/05-crud-test.md`).
 *
 * **AI에게 묻지 않는다.** PASS/FAIL은 Playwright가 관측한 사실로 정한다:
 *
 * ```
 * 저장 클릭 → 쓰기 요청 발생? → 2xx? → 성공 신호? → 재조회 시 데이터 존재?
 * ```
 *
 * 하나라도 어긋나면 FAIL이고, 어느 단계에서 어긋났는지 사유로 남긴다.
 */

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SUCCESS_TEXT = /(저장|등록|수정|삭제|완료|성공|처리)/;

/** 등록 화면을 찾으려고 눌러 볼 화면 수와 버튼 수의 상한. 탐색을 다시 하는 것이 아니다. */
const OPENER_SCREEN_LIMIT = 10;
const OPENER_PER_SCREEN = 2;
const OPENER_FORMS_ENOUGH = 3;

/**
 * 셀렉터 목록 전체를 한 범위 안으로 가둔다.
 *
 * `scope + " " + "a, b"` 로 쓰면 b 는 범위 밖에 남는다. 목록 화면에서 그러면
 * **남의 행에 있는 삭제 버튼**을 누르게 된다.
 */
function scopedSelector(scope: string, shapes: string): string {
  if (!scope) return shapes;
  return shapes
    .split(",")
    .map((one) => scope + " " + one.trim())
    .join(", ");
}

/** 목록에서 레코드 한 건의 행을 집는 방법들. 관리자웹마다 표 마크업이 다르다. */
const ROW_SHAPES = ["tr", "li", '[role="row"]'];

/** 수정·삭제 버튼을 찾는 방법. SPA 는 링크가 아니라 버튼인 경우가 많다. */
const EDIT_SHAPES = ':is(a,button):has-text("수정"), :is(a,button):has-text("편집"), [data-testid*="edit"]';
const DELETE_SHAPES = ':is(a,button):has-text("삭제"), [data-testid*="delete"]';

/** 등록 폼 화면 1건. `opener` 가 있으면 그 버튼을 눌러야 폼이 열린다(SPA 모달). */
interface FormScreen {
  url: string;
  screenName: string;
  stateKey: string;
  opener: { selector: string; label: string } | null;
}

/** 필수 필드 검증 탐침은 최대 3개까지만 한다. 폼마다 레코드가 그만큼 쌓인다. */
const VALIDATION_PROBE_LIMIT = 3;

export interface CrudOutcome {
  results: CrudResult[];
  candidates: IssueCandidate[];
  ledger: TestDataLedger;
}

interface Verdict {
  pass: boolean;
  ruleId: string | null;
  reason: string;
}

let candidateSeq = 0;

function candidate(input: {
  ruleId: string;
  title: string;
  description: string;
  severity: IssueCandidate["suggestedSeverity"];
  screenName: string;
  stateKey: string;
  evidenceId: string;
}): IssueCandidate {
  candidateSeq += 1;
  return {
    id: `crud-${String(candidateSeq).padStart(4, "0")}`,
    source: "crud",
    ruleId: input.ruleId,
    title: input.title,
    description: input.description,
    stateKey: input.stateKey,
    screenName: input.screenName,
    suggestedSeverity: input.severity,
    dedupKey: sha1(`crud|${input.ruleId}|${input.stateKey}`),
    evidenceIds: [input.evidenceId],
    aiRationale: null,
    detectedAt: new Date().toISOString(),
  };
}

/** 쓰기 요청만 추린다. 목록 재조회 같은 GET은 판정에 쓰지 않는다. */
function writeRequests(entries: NetworkEntry[]): NetworkEntry[] {
  return entries.filter((e) => WRITE_METHODS.has(e.method.toUpperCase()));
}

export class CrudTester {
  private readonly ledger = new TestDataLedger();
  private readonly candidates: IssueCandidate[] = [];
  private readonly counts = {
    CREATE: { pass: 0, fail: 0, skipped: 0 },
    READ: { pass: 0, fail: 0, skipped: 0 },
    UPDATE: { pass: 0, fail: 0, skipped: 0 },
    DELETE: { pass: 0, fail: 0, skipped: 0 },
  };
  private readonly notRun: Record<string, string | null> = {
    CREATE: null,
    READ: null,
    UPDATE: null,
    DELETE: null,
  };

  constructor(
    private readonly page: Page,
    private readonly ctx: RunContext,
    private readonly collector: Collector,
    private readonly config: RunConfig,
    private readonly control: RunControl,
  ) {}

  /**
   * 신규 등록 화면 후보를 찾는다.
   *
   * 탐색 중 저장 버튼이 CAUTION으로 걸려 실행되지 않은 화면이 곧 쓰기 대상이다.
   * 여기서 새로 탐색하지 않고 Phase 2가 만든 그래프를 그대로 쓴다.
   *
   * **`edit` 경로는 넣지 않는다.** 실측에서 `/surveys/:id/edit` 을 등록 화면으로
   * 착각해 기존 실데이터를 수정해 버렸다. 수정은 Update 단계가 대장에 있는
   * 데이터에 대해서만 한다.
   */
  private formScreens(graph: StateGraph): FormScreen[] {
    return graph.nodes
      .filter((n) => /\/(new|create|regist|write|add)(\/|$)/i.test(n.signals.pathTemplate))
      .map((n) => ({ url: n.url, screenName: n.screenName, stateKey: n.stateKey, opener: null }));
  }

  /**
   * 주소로 못 찾은 등록 화면을 **버튼을 눌러** 찾는다.
   *
   * SPA 관리자웹에서 등록 화면은 `/new` 주소가 아니라 버튼 뒤의 모달인 경우가 많다.
   * 실측에서 이것 때문에 "등록 화면을 찾지 못했습니다" 로 Create·Update·Delete 가
   * 전부 미실행으로 끝났다.
   *
   * 누르는 대상은 분류기가 **폼 열기 버튼으로 판정한 것만**이다. denylist·위험 라벨은
   * 애초에 이 사유를 받지 못하므로 여기까지 오지 않는다. 그래도 눌렀을 때 쓰기 요청이
   * 관측되면 분류가 틀린 것이므로 기록을 남기고 그 버튼은 쓰지 않는다.
   */
  private async openerScreens(graph: StateGraph, already: FormScreen[]): Promise<FormScreen[]> {
    const covered = new Set(already.map((f) => f.url));
    const found: FormScreen[] = [];

    for (const node of graph.nodes.slice(0, OPENER_SCREEN_LIMIT)) {
      if (found.length + already.length >= OPENER_FORMS_ENOUGH) break;
      if (covered.has(node.url)) continue;
      if (this.control.stopped) break;

      let actions;
      try {
        await this.page.goto(node.url, { waitUntil: "domcontentloaded" });
        await this.page.waitForTimeout(this.config.budget.settleMs);
        actions = await discoverActions(
          this.page,
          { stateKey: node.stateKey, screenName: node.screenName },
          this.config.safety,
        );
      } catch {
        continue;
      }

      const openers = actions
        .filter((a) => a.risk === "SAFE" && a.riskReason.startsWith(OPEN_FORM_REASON))
        .slice(0, OPENER_PER_SCREEN);

      for (const opener of openers) {
        const screen = await this.probeOpener(node, opener.selector, opener.label);
        if (screen) {
          found.push(screen);
          break; // 화면당 하나면 충분하다
        }
      }
    }
    return found;
  }

  /** 버튼 하나를 눌러 보고 등록 폼이 열리는지 확인한다. */
  private async probeOpener(
    node: { url: string; screenName: string; stateKey: string },
    selector: string,
    label: string,
  ): Promise<FormScreen | null> {
    try {
      await this.page.goto(node.url, { waitUntil: "domcontentloaded" });
      await this.page.waitForTimeout(this.config.budget.settleMs);
      await this.page.locator(selector).first().click({ timeout: 5000 });
      await this.page.waitForTimeout(this.config.budget.settleMs);
    } catch {
      return null;
    }

    // 폼을 여는 버튼이라면 아무것도 쓰지 않았어야 한다.
    const capture = await this.capture(node.screenName + " · " + label, node.stateKey);
    const writes = writeRequests(capture.network);
    if (writes.length > 0) {
      const what = writes.map((w) => w.method + " " + w.endpointTemplate).join(", ");
      log("warn", '"' + label + '" 은 폼을 여는 버튼으로 봤는데 쓰기 요청이 발생했습니다. 사용하지 않습니다.');
      this.candidates.push(
        candidate({
          ruleId: "SAFETY-UNEXPECTED-WRITE",
          title: '폼 열기로 분류한 버튼이 쓰기를 실행했습니다: "' + label + '"',
          description:
            node.screenName + ' 의 "' + label + '" 을 폼 여는 버튼으로 보고 눌렀으나 ' +
            what + " 요청이 발생했습니다. 분류 규칙을 확인하고, 이 화면에 남은 데이터가 없는지 점검하세요.",
          severity: "MEDIUM",
          screenName: node.screenName,
          stateKey: node.stateKey,
          evidenceId: capture.evidenceIdByKind.screenshot ?? "",
        }),
      );
      return null;
    }

    const form = await analyzeForm(this.page);
    if (!form?.submitSelector || form.fields.length === 0) return null;
    if (await this.holdsExistingData(form)) return null;

    log("info", '등록 화면을 버튼으로 찾았습니다 — ' + node.screenName + ' > "' + label + '"');
    return {
      url: node.url,
      screenName: node.screenName + " > " + label,
      stateKey: node.stateKey,
      opener: { selector, label },
    };
  }

  /** 폼 화면을 연다. opener 가 있으면 버튼을 눌러야 폼이 나타난다. */
  private async openFormScreen(screen: FormScreen): Promise<boolean> {
    try {
      await this.page.goto(screen.url, { waitUntil: "domcontentloaded" });
      if (!screen.opener) return true;
      await this.page.waitForTimeout(this.config.budget.settleMs);
      await this.page.locator(screen.opener.selector).first().click({ timeout: 5000 });
      await this.page.waitForTimeout(this.config.budget.settleMs);
      return true;
    } catch (err) {
      log("warn", screen.screenName + ": 폼을 열지 못했습니다 — " + String(err));
      return false;
    }
  }

  /**
   * 이 폼이 기존 데이터를 담고 있는가.
   *
   * 경로 이름만 믿을 수 없다. 등록처럼 보이는 주소인데 기존 레코드를 열어주는
   * 화면이 실제 관리자웹에 있다. 입력칸에 이미 값이 차 있고 그것이 우리가 만든
   * 데이터가 아니면 **건드리지 않는다.**
   */
  private async holdsExistingData(form: FormInfo): Promise<string | null> {
    for (const field of form.fields) {
      if (!isFillable(field)) continue;
      if (field.kind === "checkbox" || field.kind === "radio" || field.kind === "select") continue;
      const value = await this.page
        .locator(field.selector)
        .first()
        .inputValue({ timeout: 2000 })
        .catch(() => "");
      if (value.trim() === "") continue;
      if (isOwnedByQa(value)) continue;
      return `${field.label || field.name} 에 기존 값 "${value.slice(0, 40)}" 이 들어 있습니다`;
    }
    return null;
  }

  private async capture(screenName: string, stateKey: string): Promise<ScreenCapture> {
    return captureScreen(this.page, this.ctx, this.collector, { stateKey, screenName });
  }

  /**
   * 저장을 누르고 관측한다.
   *
   * `settleMs` 만으로는 서버 왕복이 안 끝날 수 있어 네트워크가 잠잠해질 때까지 기다린다.
   */
  private async submitAndObserve(
    submitSelector: string,
    screenName: string,
    stateKey: string,
  ): Promise<{ capture: ScreenCapture; urlBefore: string; urlAfter: string; clickError: string | null }> {
    const urlBefore = this.page.url();
    let error: string | null = null;
    try {
      await this.page.locator(submitSelector).first().click({ timeout: 5000 });
      await this.page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
      await this.page.waitForTimeout(this.config.budget.settleMs);
    } catch (err) {
      error = String(err);
    }
    const capture = await this.capture(screenName, stateKey);
    return { capture, urlBefore, urlAfter: this.page.url(), clickError: error };
  }

  /**
   * 저장 결과 판정 (CLAUDE.md §11).
   * 재조회 확인은 호출자가 별도로 한다 — 목록 경로를 아는 쪽이 호출자이기 때문이다.
   */
  private judgeWrite(input: {
    capture: ScreenCapture;
    urlBefore: string;
    urlAfter: string;
    clickError: string | null;
  }): Verdict {
    if (input.clickError) {
      return { pass: false, ruleId: "FUNC-CLICK-FAILED", reason: `저장 클릭 실패: ${input.clickError}` };
    }

    const writes = writeRequests(input.capture.network);

    // 1. 쓰기 요청이 아예 없었다 — 버튼이 아무 일도 하지 않았다.
    if (writes.length === 0) {
      const moved = input.urlAfter !== input.urlBefore;
      if (!moved) {
        return {
          pass: false,
          ruleId: "FUNC-NO-RESPONSE",
          reason: "저장을 눌렀지만 쓰기 요청도, 화면 이동도 없었습니다.",
        };
      }
      return {
        pass: false,
        ruleId: "FUNC-NO-REQUEST",
        reason: "화면은 이동했지만 쓰기 요청이 관측되지 않았습니다.",
      };
    }

    // 2. HTTP 실패
    const failed = writes.find((w) => (w.status ?? 0) >= 400 || w.failureText !== null);
    if (failed) {
      return {
        pass: false,
        ruleId: (failed.status ?? 0) >= 500 ? "NET-5XX" : "NET-4XX",
        reason: `${failed.method} ${failed.endpointTemplate} → ${failed.status ?? failed.failureText}`,
      };
    }

    // 3. 로딩이 끝나지 않음
    if (input.capture.loadingStuck) {
      return { pass: false, ruleId: "FUNC-INFINITE-LOADING", reason: "저장 후 로딩이 끝나지 않았습니다." };
    }

    return { pass: true, ruleId: null, reason: "쓰기 요청 성공" };
  }

  /** 성공 신호(토스트·메시지·이동)가 있었는가. 없다고 곧바로 FAIL은 아니다. */
  private async hasSuccessSignal(urlBefore: string): Promise<boolean> {
    if (this.page.url() !== urlBefore) return true;
    try {
      const text = await this.page.locator("body").innerText({ timeout: 2000 });
      return SUCCESS_TEXT.test(text.slice(0, 4000));
    } catch {
      return false;
    }
  }

  /**
   * 목록을 다시 열어 데이터가 실제로 있는지 본다.
   *
   * **이 단계가 없으면 "UI만 성공"을 잡을 수 없다.** 토스트만 띄우고 저장은
   * 안 되는 화면이 실제 관리자웹에 흔하다.
   */
  private async existsAfterReload(listUrl: string, marker: string): Promise<boolean> {
    try {
      await this.page.goto(listUrl, { waitUntil: "domcontentloaded" });
      await this.page.waitForTimeout(this.config.budget.settleMs);
      const text = await this.page.locator("body").innerText({ timeout: 5000 });
      return text.includes(marker);
    } catch {
      return false;
    }
  }

  /**
   * 대장의 레코드를 화면에서 다시 찾는다.
   *
   * 저장 후 상세 화면으로 이동하는 관리자웹이면 그 주소를 그대로 쓴다.
   * 모달로 등록하는 SPA 는 주소가 그대로라 상세 주소를 모르므로 목록으로 간다.
   * **이때 페이지 전체에서 "수정"을 찾으면 남의 행을 누른다.** 반드시 표식이 들어 있는
   * 행 안에서만 찾는다. 행을 못 찾으면 아무것도 하지 않는다.
   */
  private async locateRecord(
    record: CreatedRecord,
  ): Promise<{ scope: string; where: string } | null> {
    const detailUrl = record.landedUrl;
    const url = detailUrl ?? this.listUrlOf(record.createUrl);
    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded" });
      await this.page.waitForTimeout(this.config.budget.settleMs);
    } catch {
      return null;
    }

    const body = await this.page.locator("body").innerText().catch(() => "");
    if (!isOwnedByQa(body) || !body.includes(record.marker)) return null;

    if (detailUrl) return { scope: "", where: "상세 화면" };

    for (const shape of ROW_SHAPES) {
      const scope = shape + ':has-text("' + record.marker + '")';
      if ((await this.page.locator(scope).count()) > 0) return { scope, where: "목록의 해당 행" };
    }
    return null;
  }

  /** 폼 화면의 목록 URL 추정. `/surveys/new` → `/surveys` */
  private listUrlOf(formUrl: string): string {
    const url = new URL(formUrl);
    url.search = "";
    url.pathname = url.pathname.replace(/\/(new|create|regist|write|edit)\/?$/i, "");
    if (url.pathname === "") url.pathname = "/";
    return url.toString();
  }

  // ── CREATE ──────────────────────────────────────────────────────────
  private async createOn(screen: FormScreen): Promise<void> {
    if (!(await this.openFormScreen(screen))) {
      this.counts.CREATE.skipped += 1;
      return;
    }
    const form = await analyzeForm(this.page);

    if (!form || form.fields.length === 0) {
      this.counts.CREATE.skipped += 1;
      log("info", `${screen.screenName}: 입력 폼을 찾지 못해 건너뜁니다.`);
      return;
    }
    if (!form.submitSelector) {
      this.counts.CREATE.skipped += 1;
      log("info", `${screen.screenName}: 저장 버튼을 찾지 못해 건너뜁니다.`);
      return;
    }

    // 기존 데이터가 들어 있는 폼이면 절대 건드리지 않는다.
    const existing = await this.holdsExistingData(form);
    if (existing) {
      this.counts.CREATE.skipped += 1;
      log("warn", `${screen.screenName}: 기존 데이터 화면으로 보여 건너뜁니다 — ${existing}`);
      return;
    }

    const marker = this.ledger.nextMarker();
    await this.fill(form, marker, null);

    const observed = await this.submitAndObserve(form.submitSelector, screen.screenName, screen.stateKey);
    const verdict = this.judgeWrite(observed);
    const evidenceId = observed.capture.evidenceIdByKind.screenshot ?? "";

    if (!verdict.pass) {
      this.counts.CREATE.fail += 1;
      this.candidates.push(
        candidate({
          ruleId: verdict.ruleId ?? "FUNC-NO-RESPONSE",
          title: `저장 실패: ${screen.screenName}`,
          description: `${screen.screenName} 에서 "${form.submitLabel}" 을 눌렀습니다. ${verdict.reason}`,
          severity: "HIGH",
          screenName: screen.screenName,
          stateKey: screen.stateKey,
          evidenceId,
        }),
      );
      log("warn", `CREATE FAIL — ${screen.screenName}: ${verdict.reason}`);
      return;
    }

    // 쓰기 요청은 성공했다. 이제 정말 저장됐는지 확인한다.
    const record = this.ledger.add({
      marker,
      screen: screen.screenName,
      createUrl: screen.url,
      landedUrl: observed.urlAfter !== observed.urlBefore ? observed.urlAfter : null,
      createdAt: new Date().toISOString(),
    });

    const signalled = await this.hasSuccessSignal(observed.urlBefore);
    const exists = await this.existsAfterReload(this.listUrlOf(screen.url), marker);

    if (!exists) {
      this.counts.CREATE.fail += 1;
      this.candidates.push(
        candidate({
          ruleId: "FUNC-PHANTOM-SUCCESS",
          title: `저장은 성공했다는데 데이터가 없음: ${screen.screenName}`,
          description:
            `${screen.screenName} 에서 저장이 2xx로 성공했고 성공 신호도 ${signalled ? "있었지만" : "없었고"}, ` +
            `목록을 다시 조회했을 때 ${marker} 가 보이지 않습니다.`,
          severity: "HIGH",
          screenName: screen.screenName,
          stateKey: screen.stateKey,
          evidenceId,
        }),
      );
      log("warn", `CREATE FAIL — ${screen.screenName}: 재조회에서 데이터 없음`);
      return;
    }

    this.counts.CREATE.pass += 1;
    log("info", `CREATE PASS — ${screen.screenName} (${marker})`);

    if (this.config.checks.formValidation) {
      await this.probeValidation(screen, form);
    }
  }

  /**
   * 필수 필드 검증 탐침.
   *
   * 필수로 표시된 필드를 하나씩 비우고 저장해 본다. 그래도 저장되면 검증이 없는 것이다.
   * 한 번에 하나만 비워야 어느 필드의 검증이 빠졌는지 특정할 수 있다.
   */
  private async probeValidation(screen: FormScreen, form: FormInfo): Promise<void> {
    const required = form.fields.filter((f) => f.required && isFillable(f)).slice(0, VALIDATION_PROBE_LIMIT);
    if (required.length === 0 || !form.submitSelector) return;

    for (const field of required) {
      if (this.control.stopped) return;

      // 모달 폼은 주소를 다시 열어도 닫힌 채라, 버튼을 눌러 다시 띄워야 한다.
      if (!(await this.openFormScreen(screen))) return;
      const marker = this.ledger.nextMarker();
      await this.fill(form, marker, field.selector);

      const observed = await this.submitAndObserve(
        form.submitSelector,
        `${screen.screenName} (검증탐침)`,
        screen.stateKey,
      );
      const verdict = this.judgeWrite(observed);

      // 저장이 막혔다 = 검증이 동작한다. 정상이다.
      if (!verdict.pass) continue;

      // 저장이 됐다 = 필수인데 검증이 없다.
      this.ledger.add({
        marker,
        screen: screen.screenName,
        createUrl: screen.url,
        landedUrl: observed.urlAfter !== observed.urlBefore ? observed.urlAfter : null,
        createdAt: new Date().toISOString(),
      });

      this.candidates.push(
        candidate({
          ruleId: "FUNC-VALIDATION-MISSING",
          title: `필수 항목 검증 누락: ${field.label || field.name}`,
          description:
            `${screen.screenName} 에서 필수로 표시된 "${field.label || field.name}" 을 비운 채 저장했는데 ` +
            `그대로 저장되었습니다.`,
          severity: "MEDIUM",
          screenName: screen.screenName,
          stateKey: screen.stateKey,
          evidenceId: observed.capture.evidenceIdByKind.screenshot ?? "",
        }),
      );
      log("warn", `검증 누락 — ${screen.screenName}: ${field.label || field.name}`);
    }
  }

  /** 폼을 채운다. `blankSelector` 로 지정한 필드 하나만 비워 둔다. */
  private async fill(form: FormInfo, marker: string, blankSelector: string | null): Promise<void> {
    for (const field of form.fields) {
      if (!isFillable(field)) continue;
      const locator = this.page.locator(field.selector).first();
      try {
        if (field.selector === blankSelector) {
          if (field.kind !== "checkbox" && field.kind !== "radio") await locator.fill("");
          continue;
        }
        if (field.kind === "checkbox" || field.kind === "radio") {
          await locator.check({ timeout: 3000 });
        } else if (field.kind === "select") {
          const value = valueFor(field, marker);
          if (value) await locator.selectOption(value, { timeout: 3000 });
        } else {
          await locator.fill(valueFor(field, marker), { timeout: 3000 });
        }
      } catch (err) {
        log("warn", `필드 입력 실패 (${field.label || field.selector}): ${String(err)}`);
      }
    }
  }

  // ── UPDATE ──────────────────────────────────────────────────────────
  private async updateOn(record: CreatedRecord): Promise<void> {
    // **대장에 있는 데이터인지 화면에서 다시 확인한다.** 여기서 확인하지 않으면
    // 실데이터를 수정할 수 있다.
    const found = await this.locateRecord(record);
    if (!found) {
      this.counts.UPDATE.skipped += 1;
      log("warn", "UPDATE 건너뜀 — " + record.marker + " 를 화면에서 확인하지 못했습니다.");
      return;
    }

    const editSelector = scopedSelector(found.scope, EDIT_SHAPES);
    const editLink = this.page.locator(editSelector).first();
    if ((await editLink.count()) === 0) {
      this.counts.UPDATE.skipped += 1;
      this.notRun.UPDATE = found.where + "에서 수정 버튼을 찾지 못했습니다.";
      return;
    }

    await editLink.click({ timeout: 5000 }).catch(() => undefined);
    await this.page.waitForTimeout(this.config.budget.settleMs);

    const form = await analyzeForm(this.page);
    if (!form?.submitSelector) {
      this.counts.UPDATE.skipped += 1;
      return;
    }

    // 수정 화면에 도착했는데 우리 데이터가 아니면 멈춘다.
    // 상세 → 수정 링크가 엉뚱한 곳으로 갈 수도 있다.
    const foreign = await this.holdsExistingData(form);
    if (foreign) {
      this.counts.UPDATE.skipped += 1;
      log("warn", `UPDATE 건너뜀 — 우리 데이터가 아닌 것으로 보입니다: ${foreign}`);
      return;
    }

    const updated = `${record.marker}-UPD`;
    const first = form.fields.find((f) => f.kind === "text" && isFillable(f));
    if (first) {
      await this.page.locator(first.selector).first().fill(updated).catch(() => undefined);
    }

    const screenName = `${record.screen} 수정`;
    const observed = await this.submitAndObserve(form.submitSelector, screenName, record.id);
    const verdict = this.judgeWrite(observed);

    if (!verdict.pass) {
      this.counts.UPDATE.fail += 1;
      this.candidates.push(
        candidate({
          ruleId: verdict.ruleId ?? "FUNC-NO-RESPONSE",
          title: `수정 실패: ${record.screen}`,
          description: `${record.marker} 수정 중 ${verdict.reason}`,
          severity: "HIGH",
          screenName,
          stateKey: record.id,
          evidenceId: observed.capture.evidenceIdByKind.screenshot ?? "",
        }),
      );
      return;
    }

    const exists = await this.existsAfterReload(this.listUrlOf(record.createUrl), updated);
    if (!exists) {
      this.counts.UPDATE.fail += 1;
      this.candidates.push(
        candidate({
          ruleId: "FUNC-PHANTOM-SUCCESS",
          title: `수정은 성공했다는데 반영되지 않음: ${record.screen}`,
          description: `${updated} 로 수정했지만 목록 재조회에서 확인되지 않습니다.`,
          severity: "HIGH",
          screenName,
          stateKey: record.id,
          evidenceId: observed.capture.evidenceIdByKind.screenshot ?? "",
        }),
      );
      return;
    }

    this.counts.UPDATE.pass += 1;
    log("info", `UPDATE PASS — ${record.screen} (${updated})`);
  }

  // ── DELETE / Cleanup ────────────────────────────────────────────────
  /**
   * 삭제한다. **대장에 있고 화면에서 소유권이 확인된 것만.**
   *
   * `countAsTest` 가 참이면 Delete 테스트로 집계하고, 거짓이면 뒷정리로만 본다.
   */
  private async deleteRecord(record: CreatedRecord, countAsTest: boolean): Promise<boolean> {
    // 이미 지워졌거나 다른 데이터를 보고 있으면 어느 쪽이든 클릭하지 않는다.
    const found = await this.locateRecord(record);
    if (!found) {
      this.ledger.markCleaned(record.id, "화면에서 AUTO-QA 표식을 확인하지 못해 삭제하지 않았습니다.");
      return false;
    }

    const deleteSelector = scopedSelector(found.scope, DELETE_SHAPES);
    if ((await this.page.locator(deleteSelector).count()) === 0) {
      this.ledger.markCleaned(record.id, found.where + "에서 삭제 버튼을 찾지 못했습니다.");
      return false;
    }

    // 확인 대화상자가 뜨면 수락한다.
    this.page.once("dialog", (dialog) => void dialog.accept().catch(() => undefined));

    const observed = await this.submitAndObserve(
      deleteSelector,
      record.screen + " 삭제",
      record.id,
    );
    const verdict = this.judgeWrite(observed);

    if (!verdict.pass) {
      this.ledger.markCleaned(record.id, verdict.reason);
      if (countAsTest) {
        this.counts.DELETE.fail += 1;
        this.candidates.push(
          candidate({
            ruleId: verdict.ruleId ?? "FUNC-NO-RESPONSE",
            title: `삭제 실패: ${record.screen}`,
            description: `${record.marker} 삭제 중 ${verdict.reason}`,
            severity: "HIGH",
            screenName: `${record.screen} 삭제`,
            stateKey: record.id,
            evidenceId: observed.capture.evidenceIdByKind.screenshot ?? "",
          }),
        );
      }
      return false;
    }

    const stillThere = await this.existsAfterReload(this.listUrlOf(record.createUrl), record.marker);
    if (stillThere) {
      this.ledger.markCleaned(record.id, "삭제 요청은 성공했지만 목록에 그대로 남아 있습니다.");
      if (countAsTest) this.counts.DELETE.fail += 1;
      return false;
    }

    this.ledger.markCleaned(record.id);
    if (countAsTest) {
      this.counts.DELETE.pass += 1;
      log("info", `DELETE PASS — ${record.screen} (${record.marker})`);
    }
    return true;
  }

  /**
   * 뒷정리.
   *
   * 삭제가 꺼져 있으면 **정리하지 않고** 남은 데이터를 리포트에 남긴다.
   * 사용자가 삭제를 허용하지 않았는데 정리를 핑계로 지우면 안 된다.
   */
  private async cleanup(): Promise<void> {
    const pending = this.ledger.leftovers();
    if (pending.length === 0) return;

    if (!(this.config.crud.delete && this.config.crud.deleteConsent)) {
      for (const record of pending) {
        this.ledger.markCleaned(record.id, "삭제 동의가 없어 정리하지 않았습니다.");
      }
      log(
        "warn",
        `테스트 데이터 ${pending.length}건을 정리하지 않았습니다. 삭제 동의가 없으면 지우지 않습니다.`,
      );
      return;
    }

    log("info", `테스트 데이터 ${pending.length}건 정리를 시작합니다.`);
    // 역순으로 지운다 — 나중에 만든 것이 먼저 사라져야 참조가 꼬이지 않는다.
    for (const record of [...pending].reverse()) {
      await this.deleteRecord(record, false);
    }

    const failed = this.ledger.leftovers();
    for (const record of failed) {
      this.candidates.push(
        candidate({
          ruleId: "DATA-CLEANUP-FAILED",
          title: `테스트 데이터가 남았습니다: ${record.marker}`,
          description:
            `${record.screen} 에서 만든 ${record.marker} 를 정리하지 못했습니다. ` +
            `사유: ${record.cleanupError ?? "미상"}. 수동으로 확인해 주세요.`,
          severity: "MEDIUM",
          screenName: record.screen,
          stateKey: record.id,
          evidenceId: this.ctx.listEvidences()[0]?.id ?? "",
        }),
      );
    }
  }

  // ── 실행 ────────────────────────────────────────────────────────────
  async run(graph: StateGraph): Promise<CrudOutcome> {
    // Read는 탐색 자체가 검증한다.
    this.counts.READ.pass = graph.nodes.length;

    const screens = this.formScreens(graph);

    if (!this.config.crud.create) {
      this.notRun.CREATE = "설정에서 꺼져 있습니다.";
    } else {
      // 주소에 /new 가 없는 SPA 는 버튼을 눌러야 등록 폼이 나온다.
      if (screens.length < OPENER_FORMS_ENOUGH) {
        screens.push(...(await this.openerScreens(graph, screens)));
      }
    }

    if (!this.config.crud.create) {
      // 위에서 사유를 적었다.
    } else if (screens.length === 0) {
      this.notRun.CREATE = "등록 화면을 찾지 못했습니다. 주소에도 /new 계열이 없고, 폼을 여는 버튼도 없었습니다.";
    } else {
      for (const screen of screens) {
        if (this.control.stopped) break;
        await this.control.waitIfPaused();
        emit({
          type: "run:progress",
          at: new Date().toISOString(),
          screensExplored: graph.nodes.length,
          screensQueued: 0,
          actionsExecuted: 0,
          currentTask: "Create 테스트",
          currentScreen: screen.screenName,
        });
        try {
          await this.createOn(screen);
        } catch (err) {
          // 화면 하나가 터져도 나머지는 계속한다.
          this.counts.CREATE.fail += 1;
          log("error", `CREATE 중 예외 (${screen.screenName}): ${String(err)}`);
        }
      }
    }

    if (!this.config.crud.update) {
      this.notRun.UPDATE = "설정에서 꺼져 있습니다.";
    } else {
      // landedUrl 이 없어도 목록에서 표식으로 행을 찾을 수 있다(모달 등록).
      const targets = this.ledger.all().filter((r) => !r.cleaned);
      if (targets.length === 0) {
        this.notRun.UPDATE = "수정할 QA 생성 데이터가 없습니다.";
      }
      for (const record of targets.slice(0, 3)) {
        if (this.control.stopped) break;
        try {
          await this.updateOn(record);
        } catch (err) {
          this.counts.UPDATE.fail += 1;
          log("error", `UPDATE 중 예외: ${String(err)}`);
        }
      }
    }

    if (!this.config.crud.delete) {
      this.notRun.DELETE = "설정에서 꺼져 있습니다.";
    } else if (!this.config.crud.deleteConsent) {
      this.notRun.DELETE = "별도 삭제 동의가 없어 실행하지 않았습니다.";
    } else {
      // landedUrl 이 없어도 목록에서 표식으로 행을 찾을 수 있다(모달 등록).
      const targets = this.ledger.all().filter((r) => !r.cleaned);
      if (targets.length === 0) {
        this.notRun.DELETE = "삭제할 QA 생성 데이터가 없습니다.";
      }
      // 테스트로 1건만 삭제하고, 나머지는 뒷정리에서 지운다.
      const [first] = targets;
      if (first) {
        try {
          await this.deleteRecord(first, true);
        } catch (err) {
          this.counts.DELETE.fail += 1;
          log("error", `DELETE 중 예외: ${String(err)}`);
        }
      }
    }

    await this.cleanup().catch((err) => log("error", `정리 중 예외: ${String(err)}`));

    this.ctx.writeJson("actions", "testdata.json", this.ledger.all());

    const results: CrudResult[] = (["CREATE", "READ", "UPDATE", "DELETE"] as const).map((kind) => ({
      kind,
      executed: this.notRun[kind] === null,
      pass: this.counts[kind].pass,
      fail: this.counts[kind].fail,
      skipped: this.counts[kind].skipped,
      notExecutedReason: this.notRun[kind] ?? null,
    }));

    return { results, candidates: this.candidates, ledger: this.ledger };
  }
}
