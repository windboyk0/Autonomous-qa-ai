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
  const { selectedProjectId, go, beginRun, setError } = useStore();

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

  useEffect(() => {
    void (async () => {
      setPreflight(await qa().run.preflight());
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
      targetUrl,
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

  const start = async () => {
    if (selectedProjectId === null) return;
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

  const engineReady = preflight?.enginePath !== null && preflight?.enginePath !== undefined;

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">QA 실행 설정</h1>
        <button className="btn-ghost" onClick={() => go("projects")}>
          ← 프로젝트
        </button>
      </div>

      {preflight?.engineError && (
        <div className="alert-error mb-4" data-testid="engine-error">
          {preflight.engineError}
        </div>
      )}
      {preflight && !preflight.credentials.available && (
        <div className="alert-warn mb-4">{preflight.credentials.reason}</div>
      )}

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
              <input value={ollamaUrl} onChange={(e) => setOllamaUrl(e.target.value)} />
            </label>
            <label>
              Model
              <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="qwen3.5:9b" />
            </label>
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

      <div className="flex gap-2 mt-4">
        <button
          className="btn-primary"
          onClick={() => void start()}
          disabled={busy || !engineReady || (del && !deleteConsent)}
          data-testid="start-qa"
        >
          QA 시작
        </button>
        <button className="btn-ghost" onClick={() => void save()} disabled={busy}>
          설정만 저장
        </button>
      </div>
    </div>
  );
}
