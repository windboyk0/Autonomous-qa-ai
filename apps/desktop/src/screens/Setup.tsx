import { useEffect, useState } from "react";
import type { RunConfig } from "@qa/shared";
import { qa, type Preflight } from "../api.js";
import { useStore } from "../store.js";

/**
 * QA 실행 설정 (CLAUDE.md §8).
 *
 * 사용자가 채우는 것은 URL · 계정 · Provider · CRUD 범위 · Safety Policy 뿐이다.
 * 나머지 기본값은 `RunConfig` 스키마가 채운다.
 */
export function Setup() {
  const { selectedProjectId, go, beginRun, setError, lastError } = useStore();

  const [mode, setMode] = useState<"runtime" | "source" | "integrated">("runtime");
  const [sourceDir, setSourceDir] = useState("");
  const [name, setName] = useState("");
  const [targetUrl, setTargetUrl] = useState("http://localhost:3100");
  const [startPath, setStartPath] = useState("/");
  const [useLogin, setUseLogin] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [savePassword, setSavePassword] = useState(false);
  const [hasStoredPassword, setHasStoredPassword] = useState(false);

  const [provider, setProvider] = useState<"none" | "ollama" | "claude">("none");
  const [model, setModel] = useState("");
  const [ollamaUrl, setOllamaUrl] = useState("http://localhost:11434");

  const [create, setCreate] = useState(false);
  const [update, setUpdate] = useState(false);
  const [del, setDel] = useState(false);
  const [deleteConsent, setDeleteConsent] = useState(false);

  const [headless, setHeadless] = useState(true);
  const [maxScreens, setMaxScreens] = useState(120);

  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [busy, setBusy] = useState(false);

  const [preflightError, setPreflightError] = useState<string | null>(null);

  const [models, setModels] = useState<Array<{ name: string; sizeGb: number | null }>>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  /** 설치된 Ollama 모델을 가져온다. 실패해도 직접 입력할 수 있게 둔다. */
  const loadModels = async () => {
    setModelsLoading(true);
    try {
      const result = await qa().ai.ollamaModels(ollamaUrl);
      setModels(result.models);
      setModelsError(result.error);
      // 아직 고른 모델이 없으면 첫 번째를 기본으로 잡아 준다.
      if (!model && result.models[0]) setModel(result.models[0].name);
    } catch (err) {
      setModels([]);
      setModelsError(err instanceof Error ? err.message : String(err));
    } finally {
      setModelsLoading(false);
    }
  };

  // Ollama를 고르거나 주소를 바꾸면 목록을 다시 가져온다.
  useEffect(() => {
    if (provider !== "ollama") return;
    void loadModels();
  }, [provider, ollamaUrl]);

  const loadPreflight = async () => {
    try {
      setPreflight(await qa().run.preflight());
      setPreflightError(null);
    } catch (err) {
      // 삼키면 버튼이 영원히 비활성인데 이유가 어디에도 안 보인다.
      setPreflight(null);
      setPreflightError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void (async () => {
      await loadPreflight();
      if (selectedProjectId === null) return;
      const { project } = await qa().projects.get(selectedProjectId);
      if (!project) return;
      setName(project.name);
      setTargetUrl(project.targetUrl);
      setStartPath(project.startPath);
      setUsername(project.username);
      setHasStoredPassword(project.hasPassword);
    })();
  }, [selectedProjectId]);

  const buildConfig = (): RunConfig =>
    ({
      projectName: name || "프로젝트",
      mode,
      // 실행이 없는 모드에 URL을 넘기면 스키마가 거부한다. 모드가 요구하는 것만 채운다.
      targetUrl: mode === "source" ? "" : targetUrl,
      source: { rootDir: mode === "runtime" ? "" : sourceDir },
      startPath,
      headless,
      login: { enabled: useLogin, username, password: "" },
      crud: { create, read: true, update, delete: del, deleteConsent },
      ai: { kind: provider, model, baseUrl: ollamaUrl },
      budget: { maxScreens },
    }) as unknown as RunConfig;

  const save = async () => {
    if (selectedProjectId === null) return;
    setBusy(true);
    try {
      await qa().projects.save({
        id: selectedProjectId,
        name,
        targetUrl,
        startPath,
        username,
        // 입력하지 않았으면 기존 자격증명을 건드리지 않는다.
        password: password && savePassword ? password : null,
        config: {},
      });
      setHasStoredPassword(hasStoredPassword || (savePassword && password.length > 0));
    } finally {
      setBusy(false);
    }
  };

  /**
   * QA를 시작할 수 없는 이유. 없으면 null.
   *
   * **이유를 화면에 그대로 보여준다.** 전에는 프로젝트가 선택되지 않으면
   * 버튼이 눌려도 조용히 아무 일도 하지 않았고, 사용자는 "버튼이 안 눌린다"고만
   * 알 수 있었다 (실측). 막는 것과 왜 막는지 말하는 것은 한 쌍이어야 한다.
   */
  const blockReason = ((): string | null => {
    if (preflightError) return `실행 환경을 확인하지 못했습니다: ${preflightError}`;
    if (!preflight) return "실행 환경을 확인하는 중입니다…";
    if (preflight.engineError) return preflight.engineError;
    if (preflight.running) return "이미 실행 중인 Run이 있습니다. 끝나면 다시 시도하세요.";
    if (selectedProjectId === null) return "프로젝트를 먼저 선택하세요.";
    // 모드마다 필요한 입력이 다르다. 필요 없는 것을 요구하면 시작조차 못 한다.
    if (mode !== "source" && !targetUrl.trim()) return "Target URL을 입력하세요.";
    if (mode !== "runtime" && !sourceDir.trim()) return "QA할 프로젝트 폴더를 고르세요.";
    if (mode !== "source" && useLogin && !username.trim())
      return "로그인을 쓰려면 아이디가 필요합니다.";
    if (mode !== "source" && useLogin && !password && !hasStoredPassword)
      return "비밀번호를 입력하세요.";
    if (del && !deleteConsent) return "삭제 테스트에 동의해야 시작할 수 있습니다.";
    // 모델 없이 Ollama를 켜면 엔진이 헬스체크에서 떨어진다. 여기서 미리 막는다.
    if (provider === "ollama" && !model.trim()) return "사용할 Ollama 모델을 선택하세요.";
    return null;
  })();

  const start = async () => {
    if (selectedProjectId === null) {
      setError("프로젝트를 먼저 선택하세요. 왼쪽 '프로젝트' 화면에서 만들거나 고를 수 있습니다.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await save();
      const result = await qa().run.start({
        projectId: selectedProjectId,
        config: buildConfig(),
        password: password || undefined,
        savePassword,
      });
      if (!result.ok) {
        setError(result.error ?? "실행에 실패했습니다.");
        return;
      }
      beginRun();
      // 비밀번호는 화면에도 남기지 않는다.
      setPassword("");
    } finally {
      setBusy(false);
    }
  };


  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">QA 실행 설정</h1>
        <button className="btn-ghost" onClick={() => go("projects")}>
          ← 프로젝트
        </button>
      </div>

      {selectedProjectId === null && (
        <div className="alert-warn mb-4" data-testid="no-project">
          <b>선택된 프로젝트가 없습니다.</b>
          <div className="mt-1">
            QA는 프로젝트 단위로 실행됩니다. 먼저 프로젝트를 만들거나 고르세요.
          </div>
          <button className="btn-primary mt-2" data-testid="goto-projects" onClick={() => go("projects")}>
            프로젝트 화면으로
          </button>
        </div>
      )}

      {(preflight?.engineError || preflightError) && (
        <div className="alert-error mb-4" data-testid="engine-error">
          {preflight?.engineError ?? preflightError}
          <button className="btn-ghost ml-2" onClick={() => void loadPreflight()}>
            다시 확인
          </button>
        </div>
      )}
      {preflight && !preflight.credentials.available && (
        <div className="alert-warn mb-4">{preflight.credentials.reason}</div>
      )}
      {/* 시작 실패 사유. 이걸 안 띄우면 "버튼을 눌렀는데 아무 일도 안 난다"가 된다. */}
      {lastError && (
        <div className="alert-error mb-4" data-testid="setup-error">
          {lastError}
        </div>
      )}

      {/*
        브라우저 QA와 소스 QA는 찾는 문제가 다르다(CLAUDE.md §2-1).
        무엇을 찾고 싶은지부터 고르게 하고, 그 모드에 필요한 입력만 보여준다.
      */}
      <section className="card">
        <h2>QA 테스트 방식</h2>
        <label className="row">
          <input
            type="radio"
            name="qa-mode"
            checked={mode === "runtime"}
            onChange={() => setMode("runtime")}
            data-testid="mode-runtime"
          />
          <span>
            <b>실행 QA</b> — URL + 계정. 화면·CRUD·API 실패·Console·UX
          </span>
        </label>
        <label className="row">
          <input
            type="radio"
            name="qa-mode"
            checked={mode === "source"}
            onChange={() => setMode("source")}
            data-testid="mode-source"
          />
          <span>
            <b>소스 QA</b> — 프로젝트 폴더. 권한 검사·예외·주입·시크릿
          </span>
        </label>
        <label className="row">
          <input
            type="radio"
            name="qa-mode"
            checked={mode === "integrated"}
            onChange={() => setMode("integrated")}
            data-testid="mode-integrated"
          />
          <span>
            <b>통합 QA</b> — 폴더 + URL + 계정. 화면 오류를 소스까지 추적
          </span>
        </label>
        <p className="hint">
          실행 QA는 권한 검사 누락을 원리적으로 찾을 수 없습니다 — 위험한 버튼은 누르지 않는 것이
          정답이기 때문입니다. 소스 QA는 반대로 화면이 실제로 뜨는지 알 수 없습니다.
        </p>
      </section>

      {mode !== "runtime" && (
        <section className="card">
          <h2>프로젝트 폴더</h2>
          <label>
            경로
            <input
              value={sourceDir}
              onChange={(e) => setSourceDir(e.target.value)}
              data-testid="cfg-source-dir"
              placeholder="C:\\project\\groupware"
            />
          </label>
          <button
            className="btn-ghost"
            data-testid="pick-folder"
            onClick={() => {
              void (async () => {
                const r = await qa().dialog.pickFolder();
                if (r.ok && r.dir) setSourceDir(r.dir);
              })();
            }}
          >
            폴더 선택
          </button>
          <p className="hint">
            소스는 읽기만 합니다. 빌드·테스트는 실행하지 않고, <code>.env</code>·인증서 파일은
            열지 않습니다.
            {provider === "claude"
              ? " 결함이 걸린 구간만 Claude로 전송됩니다."
              : provider === "ollama"
                ? " Ollama는 로컬이라 소스가 밖으로 나가지 않습니다."
                : " AI를 쓰지 않으므로 소스가 밖으로 나가지 않습니다."}
          </p>
        </section>
      )}

      {mode !== "source" && (
      <section className="card">
        <h2>대상</h2>
        <label>
          프로젝트명
          <input value={name} onChange={(e) => setName(e.target.value)} data-testid="cfg-name" />
        </label>
        <label>
          Target URL
          <input value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} data-testid="cfg-url" />
        </label>
        <label>
          Start Path
          <input value={startPath} onChange={(e) => setStartPath(e.target.value)} data-testid="cfg-start" />
        </label>
      </section>
      )}

      <section className="card">
        <h2>로그인</h2>
        <label className="row">
          <input
            type="checkbox"
            checked={useLogin}
            onChange={(e) => setUseLogin(e.target.checked)}
            data-testid="cfg-uselogin"
          />
          로그인 사용
        </label>
        {useLogin && (
          <>
            <label>
              아이디
              <input value={username} onChange={(e) => setUsername(e.target.value)} data-testid="cfg-user" />
            </label>
            <label>
              비밀번호 {hasStoredPassword && <span className="hint">(저장된 값 사용 중 — 비워두면 그대로)</span>}
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                data-testid="cfg-pass"
              />
            </label>
            <label className="row">
              <input
                type="checkbox"
                checked={savePassword}
                onChange={(e) => setSavePassword(e.target.checked)}
                disabled={!preflight?.credentials.available}
              />
              비밀번호 저장 (OS 자격증명 저장소로 암호화)
            </label>
          </>
        )}
      </section>

      <section className="card">
        <h2>AI Provider</h2>
        <label className="row">
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as typeof provider)}
            data-testid="cfg-provider"
          >
            <option value="none">사용 안 함 (룰 기반만)</option>
            <option value="ollama">Ollama</option>
            <option value="claude">Claude Max</option>
          </select>
        </label>
        {provider === "ollama" && (
          <>
            <label>
              Ollama URL
              <input
                value={ollamaUrl}
                onChange={(e) => setOllamaUrl(e.target.value)}
                data-testid="cfg-ollama-url"
              />
            </label>
            <label>
              모델
              {models.length > 0 ? (
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  data-testid="cfg-model"
                >
                  <option value="">모델을 선택하세요</option>
                  {models.map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.name}
                      {m.sizeGb !== null ? ` (${m.sizeGb} GB)` : ""}
                    </option>
                  ))}
                </select>
              ) : (
                // 목록을 못 받았을 때도 직접 입력할 수 있어야 한다.
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="qwen3.5:9b"
                  data-testid="cfg-model"
                />
              )}
            </label>
            <div className="flex items-center gap-2">
              <button className="btn-ghost" onClick={() => void loadModels()} disabled={modelsLoading}>
                {modelsLoading ? "조회 중…" : "모델 목록 새로고침"}
              </button>
              {modelsError ? (
                <span className="hint text-red-600" data-testid="models-error">
                  {modelsError}
                </span>
              ) : (
                <span className="hint">설치된 모델 {models.length}개</span>
              )}
            </div>
          </>
        )}
        <p className="hint">AI는 덧붙이기만 합니다. 실패해도 룰 기반 리포트는 그대로 생성됩니다.</p>
      </section>

      <section className="card">
        <h2>테스트 범위</h2>
        <label className="row">
          <input type="checkbox" checked disabled /> Read (항상 실행)
        </label>
        <label className="row">
          <input type="checkbox" checked={create} onChange={(e) => setCreate(e.target.checked)} /> Create
        </label>
        <label className="row">
          <input type="checkbox" checked={update} onChange={(e) => setUpdate(e.target.checked)} /> Update
        </label>
        <label className="row">
          <input
            type="checkbox"
            checked={del}
            onChange={(e) => {
              setDel(e.target.checked);
              if (!e.target.checked) setDeleteConsent(false);
            }}
          />
          Delete
        </label>
        {del && (
          <label className="row alert-warn">
            <input
              type="checkbox"
              checked={deleteConsent}
              onChange={(e) => setDeleteConsent(e.target.checked)}
              data-testid="cfg-delete-consent"
            />
            삭제 테스트에 동의합니다. QA가 만든 <code>AUTO-QA-*</code> 데이터만 삭제됩니다.
          </label>
        )}
        <p className="hint">쓰기 테스트는 Phase 6에서 동작합니다. 지금은 Read만 실행됩니다.</p>
      </section>

      <section className="card">
        <h2>실행</h2>
        <label className="row">
          <input type="checkbox" checked={headless} onChange={(e) => setHeadless(e.target.checked)} />
          headless (브라우저 창 숨김)
        </label>
        <label>
          최대 화면 수
          <input
            type="number"
            value={maxScreens}
            onChange={(e) => setMaxScreens(Number(e.target.value) || 1)}
            data-testid="cfg-maxscreens"
          />
        </label>
      </section>

      <div className="flex items-center gap-2 mt-4">
        <button
          className="btn-primary"
          onClick={() => void start()}
          disabled={busy || blockReason !== null}
          data-testid="start-qa"
        >
          QA 시작
        </button>
        <button
          className="btn-ghost"
          onClick={() => void save()}
          disabled={busy || selectedProjectId === null}
        >
          설정만 저장
        </button>
        {/* 버튼을 막았으면 왜 막았는지 반드시 옆에 적는다. */}
        {blockReason && (
          <span className="hint" data-testid="block-reason">
            {blockReason}
          </span>
        )}
      </div>
    </div>
  );
}
