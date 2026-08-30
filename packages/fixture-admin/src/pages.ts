import { shell } from "./layout.js";
import { users, surveys, createdSurveys, createdUsers, type User, type Survey } from "./data.js";

const esc = (s: unknown): string =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// ─────────────────────────────────────────────────────────────── 로그인
export function loginPage(error?: string): string {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>로그인 | Fixture Admin</title>
<style>
body{margin:0;font-family:"Malgun Gothic",system-ui,sans-serif;background:#f3f4f6;display:flex;align-items:center;justify-content:center;height:100vh}
.box{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:32px;width:340px}
h1{font-size:18px;margin:0 0 20px}
label{display:block;margin-bottom:4px;font-size:13px;color:#374151;font-weight:600}
input{width:100%;padding:8px;border:1px solid #d1d5db;border-radius:4px;margin-bottom:14px;font-size:14px}
button{width:100%;padding:10px;background:#2563eb;color:#fff;border:0;border-radius:4px;font-size:14px;cursor:pointer}
.err{color:#dc2626;font-size:13px;margin-bottom:12px}
</style></head>
<body>
<form class="box" method="post" action="/login">
  <h1>관리자 로그인</h1>
  ${error ? `<div class="err" role="alert">${esc(error)}</div>` : ""}
  <label for="loginId">아이디</label>
  <input id="loginId" name="loginId" type="text" autocomplete="username" data-testid="login-id">
  <label for="password">비밀번호</label>
  <input id="password" name="password" type="password" autocomplete="current-password" data-testid="login-pw">
  <button type="submit" data-testid="login-submit">로그인</button>
</form>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────── 대시보드
export function dashboardPage(): string {
  const body = `
      <h1>대시보드</h1>
      <div class="card">
        <p>전체 사용자 <b>${users.length + createdUsers.length}</b>명 / 설문 <b>${surveys.length + createdSurveys.length}</b>건</p>
      </div>
      <div class="card">
        <h2 style="font-size:15px;margin:0 0 10px">최근 설문</h2>
        <table>
          <thead><tr><th>번호</th><th>제목</th><th>상태</th><th>응답</th></tr></thead>
          <tbody>
            ${surveys.slice(0, 5).map((s) => `<tr><td>${s.id}</td><td><a href="/surveys/${s.id}">${esc(s.title)}</a></td><td>${s.status}</td><td>${s.responses}</td></tr>`).join("")}
          </tbody>
        </table>
      </div>`;
  // BUG-04: 처리되지 않은 Promise rejection
  const script = `
    Promise.reject(new Error('dashboard widget init failed: metrics endpoint not configured'));
  `;
  return shell({ title: "대시보드", activeHref: "/dashboard", body, script });
}

// ─────────────────────────────────────────────────────────────── 사용자 목록
export function usersPage(q: { keyword: string; sort: string; dir: string; page: number }): string {
  const all = [...users, ...createdUsers];
  const filtered = q.keyword
    ? all.filter((u) => u.name.includes(q.keyword) || u.loginId.includes(q.keyword))
    : all;
  const sorted = [...filtered].sort((a, b) => {
    const key = q.sort as keyof User;
    const av = String(a[key] ?? "");
    const bv = String(b[key] ?? "");
    const r = av.localeCompare(bv, "ko", { numeric: true });
    return q.dir === "desc" ? -r : r;
  });
  const size = 10;
  const pages = Math.max(1, Math.ceil(sorted.length / size));
  const page = Math.min(Math.max(1, q.page), pages);
  const rows = sorted.slice((page - 1) * size, page * size);

  const link = (over: Partial<typeof q>) => {
    const m = { ...q, ...over };
    return `/users?keyword=${encodeURIComponent(m.keyword)}&sort=${m.sort}&dir=${m.dir}&page=${m.page}`;
  };
  const th = (key: string, label: string) =>
    `<th><a href="${link({ sort: key, dir: q.sort === key && q.dir === "asc" ? "desc" : "asc", page: 1 })}" data-testid="sort-${key}">${label}${q.sort === key ? (q.dir === "asc" ? " ▲" : " ▼") : ""}</a></th>`;

  const body = `
      <h1>사용자관리</h1>
      <div class="toolbar">
        <form method="get" action="/users" style="display:flex;gap:8px">
          <input type="text" name="keyword" value="${esc(q.keyword)}" placeholder="이름/아이디 검색" data-testid="user-search-input">
          <button type="submit" data-testid="user-search-submit">검색</button>
        </form>
        <a class="btn" href="/users/new" data-testid="user-new">신규 등록</a>
        <button class="danger" data-testid="user-bulk-lock" onclick="alert('일괄 잠금 실행')">선택 일괄 잠금</button>
      </div>
      <div class="card" style="padding:0">
        <table>
          <thead><tr>${th("id", "번호")}${th("loginId", "아이디")}${th("name", "이름")}${th("dept", "부서")}${th("role", "권한")}${th("status", "상태")}<th>관리</th></tr></thead>
          <tbody data-testid="user-table-body">
            ${rows.map((u) => `<tr><td>${u.id}</td><td>${esc(u.loginId)}</td><td><a href="/users/${u.id}">${esc(u.name)}</a></td><td>${esc(u.dept)}</td><td>${u.role}</td><td>${u.status}</td><td><a href="/users/${u.id}">상세</a></td></tr>`).join("")}
            ${rows.length === 0 ? `<tr><td colspan="7" style="text-align:center;padding:32px;color:#6b7280">검색 결과가 없습니다.</td></tr>` : ""}
          </tbody>
        </table>
      </div>
      <div class="pager" data-testid="user-pager">
        ${Array.from({ length: pages }, (_, i) => i + 1)
          .map((p) => (p === page ? `<span class="cur">${p}</span>` : `<a href="${link({ page: p })}">${p}</a>`))
          .join("")}
      </div>
      <p style="color:#6b7280">총 ${sorted.length}건</p>`;

  // BUG-03: undefined 참조로 TypeError 발생
  const script = `
    var permissionMatrix;
    document.addEventListener('DOMContentLoaded', function () {
      console.log('user grid ready, columns=' + permissionMatrix.length);
    });
  `;
  return shell({ title: "사용자관리", activeHref: "/users", body, script });
}

// ─────────────────────────────────────────────────────────────── 사용자 상세
export function userDetailPage(u: User): string {
  const body = `
      <div class="detail-head">
        <span class="overlap-badge" data-testid="user-badge">${u.status === "LOCKED" ? "잠김" : "정상"}</span>
        <h1 data-testid="user-detail-title">${esc(u.name)} 상세</h1>
      </div>
      <div class="card">
        <table style="width:auto">
          <tr><th>아이디</th><td>${esc(u.loginId)}</td></tr>
          <tr><th>부서</th><td>${esc(u.dept)}</td></tr>
          <tr><th>권한</th><td>${u.role}</td></tr>
          <tr><th>상태</th><td>${u.status}</td></tr>
          <tr><th>등록일</th><td>${u.createdAt}</td></tr>
        </table>
      </div>
      <div class="toolbar">
        <button data-testid="user-history-open" onclick="document.getElementById('dlg').showModal()">접속이력 보기</button>
        <button class="danger" data-testid="user-role-change" onclick="alert('권한 변경')">권한 변경</button>
        <button class="danger" data-testid="user-delete" onclick="alert('삭제')">삭제</button>
        <a href="/users">목록</a>
      </div>
      <dialog id="dlg" aria-label="접속이력">
        <h2 style="font-size:16px;margin:0 0 12px">접속이력</h2>
        <table><thead><tr><th>일시</th><th>IP</th></tr></thead>
        <tbody><tr><td>2026-08-01 09:12</td><td>10.0.0.11</td></tr><tr><td>2026-08-02 14:03</td><td>10.0.0.24</td></tr></tbody></table>
        <div style="margin-top:14px;text-align:right"><button data-testid="dlg-close" onclick="document.getElementById('dlg').close()">닫기</button></div>
      </dialog>`;
  return shell({ title: "사용자 상세", activeHref: "/users", body });
}

// ─────────────────────────────────────────────────────────────── 사용자 등록 (BUG-06)
export function userNewPage(): string {
  const body = `
      <h1>사용자 등록</h1>
      <div class="card">
        <form id="userForm">
          <div class="field"><label for="loginId">아이디 *</label><input id="loginId" name="loginId" type="text" data-testid="new-user-loginid"></div>
          <div class="field"><label for="name">이름 *</label><input id="name" name="name" type="text" data-testid="new-user-name"></div>
          <div class="field"><label for="dept">부서</label>
            <select id="dept" name="dept" data-testid="new-user-dept">
              <option>경영지원팀</option><option>영업1팀</option><option>개발팀</option>
            </select></div>
          <div class="toolbar">
            <button type="button" class="primary" id="saveBtn" data-testid="new-user-save">저장</button>
            <a class="btn" href="/users">취소</a>
          </div>
        </form>
      </div>`;
  // BUG-06: 저장 버튼에 핸들러가 연결되지 않아 아무 일도 일어나지 않는다.
  //         네트워크 요청 없음 / 토스트 없음 / 이동 없음 → Functional FAIL 이어야 한다.
  const script = `
    /* TODO: saveBtn 핸들러 연결 — 누락된 상태 */
  `;
  return shell({ title: "사용자 등록", activeHref: "/users", body, script });
}

// ─────────────────────────────────────────────────────────────── 설문 목록
export function surveysPage(status: string): string {
  const all = [...surveys, ...createdSurveys];
  const filtered = status ? all.filter((s) => s.status === status) : all;
  const body = `
      <h1>설문관리</h1>
      <div class="toolbar">
        <a class="btn" href="/surveys" data-testid="filter-all">전체</a>
        <a class="btn" href="/surveys?status=OPEN" data-testid="filter-open">진행중</a>
        <a class="btn" href="/surveys?status=CLOSED" data-testid="filter-closed">종료</a>
        <a class="btn" href="/surveys?status=ARCHIVED" data-testid="filter-archived">보관</a>
        <a class="btn" href="/surveys/new" data-testid="survey-new">신규 등록</a>
      </div>
      <div class="spinner" id="spin" data-testid="survey-spinner">불러오는 중...</div>
      <div class="card" id="grid" style="padding:0">
        <table>
          <thead><tr><th>번호</th><th>제목</th><th>담당자</th><th>상태</th><th>응답수</th><th>등록일</th></tr></thead>
          <tbody data-testid="survey-table-body">
            ${filtered.map((s) => `<tr><td>${s.id}</td><td><a href="/surveys/${s.id}">${esc(s.title)}</a></td><td>${esc(s.owner)}</td><td>${s.status}</td><td>${s.responses}</td><td>${s.createdAt}</td></tr>`).join("")}
            ${filtered.length === 0 ? `<tr><td colspan="6" style="text-align:center;padding:32px;color:#6b7280">데이터가 없습니다.</td></tr>` : ""}
          </tbody>
        </table>
      </div>`;
  // BUG-10: ARCHIVED 필터에서 스피너가 켜진 채 끝나지 않는다 (표는 가려짐)
  const script =
    status === "ARCHIVED"
      ? `document.getElementById('spin').classList.add('show');
         document.getElementById('grid').style.display = 'none';
         /* 로딩 해제 로직 없음 — 무한 로딩 */`
      : "";
  return shell({ title: "설문관리", activeHref: "/surveys", body, script });
}

export function surveyDetailPage(s: Survey): string {
  const body = `
      <h1>${esc(s.title)}</h1>
      <div class="card">
        <table style="width:auto">
          <tr><th>담당자</th><td>${esc(s.owner)}</td></tr>
          <tr><th>상태</th><td>${s.status}</td></tr>
          <tr><th>응답수</th><td>${s.responses}</td></tr>
          <tr><th>등록일</th><td>${s.createdAt}</td></tr>
        </table>
      </div>
      <div class="toolbar">
        <a class="btn" href="/surveys/${s.id}/edit" data-testid="survey-edit">수정</a>
        <button class="danger" data-testid="survey-publish" onclick="alert('게시')">게시</button>
        <button class="danger" data-testid="survey-notify" onclick="alert('알림 발송')">응답자 알림 발송</button>
        <button class="danger" data-testid="survey-delete" onclick="doDelete(${s.id})">삭제</button>
        <a href="/surveys">목록</a>
      </div>`;
  const script = `
    function doDelete(id) {
      fetch('/api/surveys/' + id, { method: 'DELETE' })
        .then(function (r) {
          if (!r.ok) { window.showToast('삭제에 실패했습니다.'); return; }
          window.showToast('삭제되었습니다.');
          setTimeout(function () { location.href = '/surveys'; }, 400);
        });
    }
  `;
  return shell({ title: "설문 상세", activeHref: "/surveys", body, script });
}

// ─────────────────────────────────────────────────────────────── 설문 수정
export function surveyEditPage(s: Survey): string {
  const body = `
      <h1>설문 수정</h1>
      <div class="card">
        <form id="editForm">
          <div class="field"><label for="title">제목 *</label><input id="title" name="title" type="text" value="${esc(s.title)}" data-testid="edit-survey-title"></div>
          <div class="field"><label for="owner">담당자 *</label><input id="owner" name="owner" type="text" value="${esc(s.owner)}" data-testid="edit-survey-owner"></div>
          <div class="field"><label for="memo">비고</label><textarea id="memo" name="memo" rows="3" data-testid="edit-survey-memo"></textarea></div>
          <div class="toolbar">
            <button type="button" class="primary" id="saveBtn" data-testid="edit-survey-save">저장</button>
            <a class="btn" href="/surveys/${s.id}">취소</a>
          </div>
        </form>
      </div>`;
  const script = `
    document.getElementById('saveBtn').addEventListener('click', function () {
      fetch('/api/surveys/${s.id}', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: document.getElementById('title').value,
          owner: document.getElementById('owner').value,
          memo: document.getElementById('memo').value
        })
      }).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d) { window.showToast('수정에 실패했습니다.'); return; }
          window.showToast('수정되었습니다.');
          setTimeout(function () { location.href = '/surveys/${s.id}'; }, 400);
        });
    });
  `;
  return shell({ title: "설문 수정", activeHref: "/surveys", body, script });
}

// ─────────────────────────────────────────────────────────────── 설문 등록 (BUG-05)
/**
 * 부서관리 — **모달로 등록하는 SPA 화면**.
 *
 * 다른 화면과 달리 등록 진입점이 `<a href>` 가 아니라 `<button>` 이고,
 * 눌러도 주소가 바뀌지 않는다. 실제 관리자웹의 흔한 모양이며,
 * 이 화면이 없으면 "등록 화면을 찾지 못했습니다" 회귀를 잡을 수 없다.
 */
export function deptsPage(rows: Array<{ id: number; name: string; owner: string }>): string {
  const body = `
      <h1>부서관리</h1>
      <div class="card">
        <div class="toolbar">
          <button type="button" class="primary" id="openNew" data-testid="dept-new">+ 새 부서</button>
        </div>
        <table data-testid="dept-table">
          <thead><tr><th>ID</th><th>부서명</th><th>부서장</th><th>관리</th></tr></thead>
          <tbody>
            ${rows
              .map(
                (d) => `<tr data-testid="dept-row-${d.id}"><td>${d.id}</td><td>${d.name}</td><td>${d.owner}</td>
              <td><button type="button" class="btn" data-dept="${d.id}" data-act="edit">수정</button>
                  <button type="button" class="btn danger" data-dept="${d.id}" data-act="del">삭제</button></td></tr>`,
              )
              .join("")}
          </tbody>
        </table>
      </div>

      <dialog id="deptDialog" data-testid="dept-dialog">
        <h2 id="deptDialogTitle">부서 등록</h2>
        <form id="deptForm">
          <input type="hidden" id="deptId">
          <div class="field"><label for="deptName">부서명 *</label><input id="deptName" name="name" type="text" data-testid="dept-name"></div>
          <div class="field"><label for="deptOwner">부서장 *</label><input id="deptOwner" name="owner" type="text" data-testid="dept-owner"></div>
          <div class="toolbar">
            <button type="button" class="primary" id="deptSave" data-testid="dept-save">저장</button>
            <button type="button" class="btn" id="deptCancel">닫기</button>
          </div>
        </form>
      </dialog>`;

  const script = `
    var dlg = document.getElementById('deptDialog');
    document.getElementById('openNew').addEventListener('click', function () {
      document.getElementById('deptId').value = '';
      document.getElementById('deptName').value = '';
      document.getElementById('deptOwner').value = '';
      document.getElementById('deptDialogTitle').textContent = '부서 등록';
      dlg.showModal();
    });
    document.getElementById('deptCancel').addEventListener('click', function () { dlg.close(); });
    document.querySelectorAll('[data-act="edit"]').forEach(function (b) {
      b.addEventListener('click', function () {
        var tr = b.closest('tr');
        document.getElementById('deptId').value = b.getAttribute('data-dept');
        document.getElementById('deptName').value = tr.children[1].textContent;
        document.getElementById('deptOwner').value = tr.children[2].textContent;
        document.getElementById('deptDialogTitle').textContent = '부서 수정';
        dlg.showModal();
      });
    });
    document.querySelectorAll('[data-act="del"]').forEach(function (b) {
      b.addEventListener('click', function () {
        fetch('/api/depts/' + b.getAttribute('data-dept'), { method: 'DELETE' })
          .then(function () { location.reload(); });
      });
    });
    document.getElementById('deptSave').addEventListener('click', function () {
      var id = document.getElementById('deptId').value;
      var name = document.getElementById('deptName').value;
      if (!name) { window.showToast('부서명을 입력하세요.'); return; }
      var owner = document.getElementById('deptOwner').value;
      if (!owner) { window.showToast('부서장을 입력하세요.'); return; }
      fetch('/api/depts' + (id ? '/' + id : ''), {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, owner: owner })
      }).then(function () {
        window.showToast('저장되었습니다.');
        setTimeout(function () { location.reload(); }, 300);
      });
    });
  `;
  return shell({ title: "부서관리", activeHref: "/depts", body, script });
}

export function surveyNewPage(): string {
  const body = `
      <h1>설문 등록</h1>
      <div class="card">
        <form id="surveyForm">
          <div class="field"><label for="title">제목 *</label><input id="title" name="title" type="text" data-testid="new-survey-title"></div>
          <div class="field"><label for="owner">담당자 *</label><input id="owner" name="owner" type="text" data-testid="new-survey-owner"></div>
          <div class="field"><label for="contact">담당자 이메일 *</label><input id="contact" name="contact" type="email" data-testid="new-survey-contact"></div>
          <div class="field"><label for="opensAt">시작일</label><input id="opensAt" name="opensAt" type="date" data-testid="new-survey-opensat"></div>
          <div class="field"><label for="memo">비고</label><textarea id="memo" name="memo" rows="3" data-testid="new-survey-memo"></textarea></div>
          <div class="toolbar">
            <button type="button" class="primary" id="saveBtn" data-testid="new-survey-save">저장</button>
            <a class="btn" href="/surveys">취소</a>
          </div>
        </form>
      </div>`;
  // BUG-05: 필수 표시(*)된 담당자 이메일에 대한 검증이 없어 빈 값으로도 저장된다.
  const script = `
    document.getElementById('saveBtn').addEventListener('click', function () {
      var title = document.getElementById('title').value;
      var owner = document.getElementById('owner').value;
      if (!title) { window.showToast('제목을 입력하세요.'); return; }
      if (!owner) { window.showToast('담당자를 입력하세요.'); return; }
      /* contact 검증 누락 */
      fetch('/api/surveys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title,
          owner: owner,
          contact: document.getElementById('contact').value,
          memo: document.getElementById('memo').value
        })
      }).then(function (r) { return r.json(); })
        .then(function (d) {
          window.showToast('저장되었습니다.');
          setTimeout(function () { location.href = '/surveys/' + d.id; }, 400);
        });
    });
  `;
  return shell({ title: "설문 등록", activeHref: "/surveys", body, script });
}

// ─────────────────────────────────────────────────────────────── 통계 (BUG-07, BUG-01)
export function statsPage(): string {
  const months = Array.from({ length: 24 }, (_, i) => `2025-${String((i % 12) + 1).padStart(2, "0")}`);
  const body = `
      <h1>설문응답통계관리센터</h1>
      <div class="toolbar">
        <button data-testid="stats-export" onclick="doExport()">엑셀 내보내기</button>
      </div>
      <div class="card" style="padding:0">
        <table class="wide-table" data-testid="stats-table">
          <thead><tr><th>구분</th>${months.map((m) => `<th>${m}</th>`).join("")}</tr></thead>
          <tbody>
            ${["응답수", "완료율", "이탈률", "평균소요"]
              .map(
                (k, ri) =>
                  `<tr><td>${k}</td>${months.map((_, ci) => `<td>${(ri + 1) * (ci + 7)}</td>`).join("")}</tr>`,
              )
              .join("")}
          </tbody>
        </table>
      </div>`;
  // BUG-01: 내보내기 API가 500을 반환한다. 게다가 화면에는 아무 안내가 없다.
  const script = `
    function doExport() {
      fetch('/api/stats/export').then(function (r) {
        if (!r.ok) return; /* 오류를 사용자에게 알리지 않음 */
        return r.blob();
      });
    }
    doExport();
  `;
  return shell({ title: "통계", activeHref: "/stats", body, script });
}

// ─────────────────────────────────────────────────────────────── 설정 (탭)
export function settingsPage(tab: string): string {
  const tabs = [
    { key: "general", label: "일반" },
    { key: "notify", label: "알림" },
    { key: "security", label: "보안" },
  ];
  const cur = tabs.some((t) => t.key === tab) ? tab : "general";
  const panel: Record<string, string> = {
    general: `<div class="field"><label for="siteName">사이트명</label><input id="siteName" type="text" value="Fixture Admin"></div>
              <div class="field"><label for="tz">시간대</label><select id="tz"><option>Asia/Seoul</option><option>UTC</option></select></div>`,
    notify: `<div class="field"><label><input type="checkbox" checked> 신규 응답 알림</label></div>
             <div class="field"><label><input type="checkbox"> 주간 요약 메일</label></div>
             <button class="danger" data-testid="settings-test-mail" onclick="alert('테스트 메일 발송')">테스트 메일 발송</button>`,
    security: `<div class="field"><label for="pwPolicy">비밀번호 정책</label><select id="pwPolicy"><option>기본</option><option>강화</option></select></div>
               <button class="danger" data-testid="settings-reset" onclick="alert('초기화')">설정 초기화</button>`,
  };
  const body = `
      <h1>설정</h1>
      <div class="toolbar" role="tablist">
        ${tabs
          .map(
            (t) =>
              `<a class="btn" role="tab" aria-selected="${t.key === cur}" href="/settings?tab=${t.key}" data-testid="tab-${t.key}" style="${t.key === cur ? "background:#2563eb;color:#fff;border-color:#2563eb" : ""}">${t.label}</a>`,
          )
          .join("")}
      </div>
      <div class="card" role="tabpanel">${panel[cur]}</div>`;
  return shell({ title: "설정", activeHref: "/settings", body });
}

export function notFoundPage(): string {
  return shell({
    title: "찾을 수 없음",
    activeHref: "",
    body: `<h1>404</h1><p>요청한 화면이 없습니다. <a href="/dashboard">대시보드로</a></p>`,
  });
}
