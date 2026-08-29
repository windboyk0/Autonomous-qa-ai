/**
 * 공통 셸(사이드바 + 헤더 + CSS).
 * 여기에 심어진 의도적 버그: BUG-02(뱃지 404), BUG-09(메뉴 텍스트 잘림)
 */

export const NAV = [
  { href: "/dashboard", label: "대시보드" },
  { href: "/users", label: "사용자관리" },
  { href: "/surveys", label: "설문관리" },
  // BUG-09: 라벨이 사이드바 고정폭(160px)을 넘어 잘린다.
  { href: "/stats", label: "설문응답통계관리센터" },
  { href: "/settings", label: "설정" },
];

const CSS = `
* { box-sizing: border-box; }
body { margin:0; font-family: "Malgun Gothic", system-ui, sans-serif; font-size:14px; color:#1f2937; background:#f3f4f6; }
a { color:#2563eb; text-decoration:none; }
.app { display:flex; min-height:100vh; }

/* 사이드바 — 고정폭 160px */
.side { width:160px; flex:0 0 160px; background:#111827; color:#e5e7eb; padding:16px 0; }
.side h2 { font-size:15px; margin:0 0 16px 16px; color:#fff; }
.side a { display:block; color:#d1d5db; padding:10px 16px; }
.side a:hover { background:#1f2937; color:#fff; }
.side a.on { background:#2563eb; color:#fff; }
/* BUG-09: nowrap + hidden 이라 긴 메뉴명이 잘린다 */
.side a { white-space:nowrap; overflow:hidden; }

.main { flex:1; min-width:0; }
.top { display:flex; align-items:center; justify-content:space-between; background:#fff; border-bottom:1px solid #e5e7eb; padding:12px 20px; }
.top .who { color:#6b7280; }
.content { padding:20px; }

h1 { font-size:20px; margin:0 0 16px; }
.card { background:#fff; border:1px solid #e5e7eb; border-radius:6px; padding:16px; margin-bottom:16px; }

table { width:100%; border-collapse:collapse; background:#fff; }
th, td { border-bottom:1px solid #e5e7eb; padding:8px 10px; text-align:left; white-space:nowrap; }
th { background:#f9fafb; font-weight:600; }

button, .btn { border:1px solid #d1d5db; background:#fff; padding:6px 12px; border-radius:4px; cursor:pointer; font-size:13px; }
button.primary { background:#2563eb; border-color:#2563eb; color:#fff; }
button.danger { background:#dc2626; border-color:#dc2626; color:#fff; }

.toolbar { display:flex; gap:8px; align-items:center; margin-bottom:12px; flex-wrap:wrap; }
input[type=text], input[type=email], input[type=date], select, textarea { border:1px solid #d1d5db; border-radius:4px; padding:6px 8px; font-size:13px; }
label { display:block; margin-bottom:4px; color:#374151; font-weight:600; }
.field { margin-bottom:12px; max-width:420px; }

.pager { display:flex; gap:4px; margin-top:12px; }
.pager a, .pager span { padding:4px 9px; border:1px solid #d1d5db; border-radius:4px; background:#fff; }
.pager span.cur { background:#2563eb; border-color:#2563eb; color:#fff; }

dialog { border:1px solid #d1d5db; border-radius:6px; padding:20px; min-width:380px; }
dialog::backdrop { background:rgba(0,0,0,.35); }

.toast { position:fixed; right:20px; bottom:20px; background:#111827; color:#fff; padding:10px 16px; border-radius:4px; display:none; }
.toast.show { display:block; }

.spinner { display:none; padding:40px; text-align:center; color:#6b7280; }
.spinner.show { display:block; }

/* BUG-08: 상세화면 뱃지가 absolute로 제목 위에 겹친다 */
.detail-head { position:relative; }
.detail-head .overlap-badge {
  position:absolute; left:0; top:2px;
  background:#fde68a; color:#92400e; padding:3px 10px; border-radius:10px; font-size:12px;
}

/* BUG-07: 통계 테이블이 컨테이너 밖으로 넘친다 (overflow-x 없음) */
.wide-table { min-width:2400px; }
`;

export function shell(opts: {
  title: string;
  activeHref: string;
  body: string;
  /** 페이지별 추가 스크립트 */
  script?: string;
}): string {
  const nav = NAV.map(
    (n) =>
      `<a href="${n.href}" class="${opts.activeHref === n.href ? "on" : ""}" data-testid="nav-${n.href.slice(1)}">${n.label}</a>`,
  ).join("\n      ");

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title} | Fixture Admin</title>
<style>${CSS}</style>
</head>
<body>
<div class="app">
  <nav class="side" aria-label="주 메뉴">
    <h2>Fixture Admin</h2>
      ${nav}
  </nav>
  <div class="main">
    <header class="top">
      <div id="notice-badge" data-testid="notice-badge"></div>
      <div class="who">admin 님 <a href="/logout" data-testid="logout">로그아웃</a></div>
    </header>
    <main class="content" role="main">
${opts.body}
    </main>
  </div>
</div>
<div class="toast" id="toast" role="status"></div>
<script>
  window.showToast = function (msg) {
    var t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('show');
    setTimeout(function () { t.classList.remove('show'); }, 2500);
  };
  // BUG-02: 모든 화면에서 공지 뱃지 API가 404를 낸다 (반복 발생 → dedup 대상)
  fetch('/api/notice/badge')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (d) document.getElementById('notice-badge').textContent = '공지 ' + d.count + '건';
    })
    .catch(function () {});
</script>
${opts.script ? `<script>${opts.script}</script>` : ""}
</body>
</html>`;
}
