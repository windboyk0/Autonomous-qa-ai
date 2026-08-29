import { useEffect, useState } from "react";
import { qa } from "../api.js";
import { useStore } from "../store.js";

export function Projects() {
  const { projects, setProjects, selectProject, go } = useStore();
  const [busy, setBusy] = useState(false);

  const reload = async () => setProjects(await qa().projects.list());

  useEffect(() => {
    void reload();
  }, []);

  const create = async () => {
    setBusy(true);
    try {
      const id = await qa().projects.save({
        id: null,
        name: "새 프로젝트",
        targetUrl: "http://localhost:3100",
        startPath: "/",
        username: "",
        password: null,
        config: {},
      });
      await reload();
      selectProject(id);
      go("setup");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    await qa().projects.remove(id);
    await reload();
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">프로젝트</h1>
        <button className="btn-primary" onClick={create} disabled={busy} data-testid="project-new">
          새 프로젝트
        </button>
      </div>

      {projects.length === 0 ? (
        <p className="text-slate-500">
          아직 프로젝트가 없습니다. <b>새 프로젝트</b>를 눌러 대상 URL부터 등록하세요.
        </p>
      ) : (
        <table className="w-full text-sm" data-testid="project-table">
          <thead>
            <tr className="text-left border-b border-slate-200">
              <th className="py-2">이름</th>
              <th>대상 URL</th>
              <th>계정</th>
              <th>비밀번호 저장</th>
              <th>수정일</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="py-2">
                  <button
                    className="text-blue-600 hover:underline"
                    data-testid={`project-open-${p.id}`}
                    onClick={() => {
                      selectProject(p.id);
                      go("setup");
                    }}
                  >
                    {p.name}
                  </button>
                </td>
                <td className="text-slate-600">{p.targetUrl}</td>
                <td className="text-slate-600">{p.username || "-"}</td>
                <td className="text-slate-600">{p.hasPassword ? "저장됨" : "-"}</td>
                <td className="text-slate-500">{p.updatedAt.slice(0, 16).replace("T", " ")}</td>
                <td className="text-right">
                  <button className="btn-ghost text-red-600" onClick={() => void remove(p.id)}>
                    삭제
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
