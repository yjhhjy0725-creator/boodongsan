function dashboard() {
  const byId = (id) => document.getElementById(id);
  const state = new Map();
  const canvas = byId('map');
  const ctx = canvas.getContext('2d');
  const zoom = 11;
  function project(lat, lng) {
    const size = 256 * 2 ** zoom;
    const rad = lat * Math.PI / 180;
    return [(lng + 180) / 360 * size, (1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2 * size];
  }
  const [centerX, centerY] = project(37.56, 126.98);
  const x0 = Math.floor(centerX - canvas.width / 2);
  const y0 = Math.floor(centerY - canvas.height / 2);
  const tiles = [];
  let displayed = [];
  let projects = [];
  let projectRevision;
  let syncing = false;
  let lastAttempt = 0;
  const refreshIntervalMs = 120_000;
  function draw() {
    ctx.fillStyle = '#e7eeeb';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const { img, x, y } of tiles) {
      if (img.naturalWidth) ctx.drawImage(img, x * 256 - x0, y * 256 - y0);
    }
    for (const ad of displayed) {
      if (!ad.pin) continue;
      const [x, y] = project(...ad.pin);
      ctx.beginPath();
      ctx.arc(x - x0, y - y0, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#0a664b';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }
  }
  for (let x = Math.floor(x0 / 256); x * 256 < x0 + canvas.width; x += 1) {
    for (let y = Math.floor(y0 / 256); y * 256 < y0 + canvas.height; y += 1) {
      const img = new Image();
      tiles.push({ img, x, y });
      img.onload = draw;
      img.src = 'https://tile.openstreetmap.org/' + zoom + '/' + x + '/' + y + '.png';
    }
  }
  function renderRows() {
    const district = byId('district').value;
    const term = byId('search').value.trim().toLowerCase();
    const budget = byId('budget').valueAsNumber;
    displayed = [...state.values()].filter((ad) =>
      (!district || district === ad.district) &&
      (!term || [ad.name, ad.district, ad.id].some((value) => String(value).toLowerCase().includes(term))) &&
      (!Number.isFinite(budget) || (ad.price !== null && ad.price <= budget)));
    displayed.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    draw();
    const priced = displayed.filter((ad) => ad.price !== null);
    const average = priced.length ? (priced.reduce((sum, ad) => sum + ad.price, 0) / priced.length).toFixed(2) + '억' : '—';
    byId('results').textContent = displayed.length + '건 · 평균 관찰호가 ' + average;
    byId('pinStatus').textContent = '검색 결과 내 검증된 건물 핀 ' + displayed.filter((ad) => ad.pin).length + '건';
    const fragment = document.createDocumentFragment();
    for (const ad of displayed) {
      const tr = document.createElement('tr');
      for (const value of [ad.name, ad.district || '—', ad.price ?? '—', ad.area ?? '—', ad.score ?? '—', ad.confidence ?? '—']) {
        const td = document.createElement('td');
        td.textContent = value;
        tr.append(td);
      }
      fragment.append(tr);
    }
    byId('rows').replaceChildren(fragment);
  }
  function renderProjects() {
    const district = byId('district').value;
    const term = byId('projectSearch').value.trim().toLowerCase();
    const visible = projects.filter((project) =>
      (!district || district === project.district) &&
      (!term || [project.name, project.type].some((value) => value.toLowerCase().includes(term))));
    byId('projectStatus').textContent = '표시 ' + visible.length + '건 / 원장 ' + projects.length + '건';
    const fragment = document.createDocumentFragment();
    for (const project of visible) {
      const tr = document.createElement('tr');
      for (const value of [project.name, project.district, project.type, project.boundaryStatus]) {
        const td = document.createElement('td');
        td.textContent = value || '—';
        tr.append(td);
      }
      fragment.append(tr);
    }
    byId('projects').replaceChildren(fragment);
  }
  async function sync() {
    if (syncing) return;
    syncing = true;
    lastAttempt = Date.now();
    byId('refresh').disabled = true;
    byId('status').textContent = '원장 조회 중';
    try {
      const response = await fetch('/api/radar?action=sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revisions: [...state.values()].map(({ id, revision }) => [id, revision]), projectRevision }),
      });
      if (response.status === 401) { location.reload(); return; }
      if (!response.ok) throw new Error();
      const payload = await response.json();
      const { changed, removed, counts, fetchedAt } = payload;
      if (payload.projects) projects = payload.projects;
      projectRevision = payload.projectRevision;
      for (const id of removed) state.delete(id);
      for (const ad of changed) state.set(ad.id, ad);
      byId('status').textContent = '원문 ' + counts.raw + '행 · 고유 ' + counts.unique + '건 · 중복 ' +
        counts.duplicates + '행 · ' + new Date(fetchedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) + ' 원장 조회';
      renderRows();
      renderProjects();
    } catch {
      byId('status').textContent = state.size ? '원장에 연결할 수 없습니다. 마지막 조회 결과를 표시합니다.' : '원장에 연결할 수 없습니다.';
    } finally {
      syncing = false;
      byId('refresh').disabled = false;
    }
  }
  function refreshWhenVisible() {
    if (!document.hidden && Date.now() - lastAttempt >= refreshIntervalMs) sync();
  }
  for (const id of ['district', 'search', 'budget']) byId(id).addEventListener('input', renderRows);
  byId('district').addEventListener('input', renderProjects);
  byId('projectSearch').addEventListener('input', renderProjects);
  byId('openOfficialMap').addEventListener('click', (event) => {
    const link = byId('officialMapLink');
    const frame = document.createElement('iframe');
    frame.title = '서울플랜+ 공식 도시계획사업 지도';
    frame.referrerPolicy = 'no-referrer';
    frame.sandbox.add('allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-popups', 'allow-popups-to-escape-sandbox');
    frame.src = link.href;
    byId('officialMap').replaceChildren(frame);
    event.currentTarget.hidden = true;
  });
  byId('refresh').addEventListener('click', sync);
  document.addEventListener('visibilitychange', refreshWhenVisible);
  window.addEventListener('online', refreshWhenVisible);
  window.setInterval(refreshWhenVisible, refreshIntervalMs);
  draw();
  sync();
}

const districts = '강남구 강동구 강북구 강서구 관악구 광진구 구로구 금천구 노원구 도봉구 동대문구 동작구 마포구 서대문구 서초구 성동구 성북구 송파구 양천구 영등포구 용산구 은평구 종로구 중구 중랑구'.split(' ');
const styles = `
*{box-sizing:border-box}body{margin:0;color:#192d26;background:#f3f6f3;font:15px/1.55 system-ui,sans-serif}
header{background:#103e30;color:#fff;padding:22px max(20px,calc((100vw - 1220px)/2));display:flex;align-items:center;justify-content:space-between;gap:12px}
main{max-width:1220px;margin:24px auto;padding:0 16px}h1,h2,p{margin:0}h1{font-size:clamp(22px,4vw,30px)}h2{font-size:18px}
section{background:#fff;border:1px solid #d8e4dc;border-radius:16px;padding:18px;margin-bottom:16px}
label{display:grid;gap:5px}input,select,button{font:inherit;border-radius:8px;padding:8px 10px;border:1px solid #a7bcb0}
button{background:#0b654c;color:white;cursor:pointer;border-color:#0b654c}button:disabled{opacity:.6}
.login{max-width:410px;margin:12vh auto}.login form{display:grid;gap:16px;margin-top:16px}
.filters{display:flex;flex-wrap:wrap;gap:12px;align-items:end}.filters input,.filters select{width:100%}
.grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);gap:16px}
.meta{color:#526b60;margin:8px 0}.error{color:#a02525;margin-top:8px}
canvas{display:block;width:100%;height:auto;border-radius:10px}a{color:#135340}
iframe{display:block;width:100%;height:540px;border:1px solid #d8e4dc;border-radius:10px;margin-top:12px}
.links{display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin:12px 0}
.project-filter{max-width:420px}
.scroll{overflow:auto;max-height:530px}table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:9px 7px;border-bottom:1px solid #e5eee8}th{position:sticky;top:0;background:#eaf2ed}
@media(max-width:850px){.grid{grid-template-columns:1fr}}
`;

export function render(nonce, mode, message = '') {
  const app = mode === 'app';
  const content = app ? `
<header><h1>RADAR 부동산 통합관리</h1><form action="/api/radar?action=logout" method="post"><button>로그아웃</button></form></header>
<main>
  <section aria-label="매물 검색"><div class="filters">
    <label>자치구<select id="district"><option value="">서울 전체</option>${districts.map((district) => '<option>' + district + '</option>').join('')}</select></label>
    <label>단지명·광고키<input id="search" type="search"></label>
    <label>최대 관찰호가 (억)<input id="budget" type="number" min="0" step="0.1"></label>
    <button id="refresh" type="button">원장 새로고침</button>
  </div><p class="meta" id="status" role="status"></p><small>이 화면이 열려 있는 동안 2분마다 원장을 확인합니다.</small></section>
  <div class="grid">
    <section><h2>서울 지도</h2><p class="meta" id="pinStatus">좌표 조회 중</p>
      <canvas id="map" width="720" height="540" aria-label="검증된 건물 위치 지도"></canvas>
      <small>© <a href="https://www.openstreetmap.org/copyright" rel="noreferrer">OpenStreetMap</a> · 정비사업 경계는 아래 서울시 공식 지도에서 확인할 수 있습니다.</small>
    </section>
    <section><h2>매물 검색·분석</h2><p class="meta" id="results"></p><p class="meta">투자 적합도와 근거 신뢰도는 사전 검토 지표입니다.</p>
      <div class="scroll"><table><thead><tr><th>단지</th><th>자치구</th><th>호가(억)</th><th>전용㎡</th><th>적합도</th><th>신뢰도</th></tr></thead><tbody id="rows"></tbody></table></div>
    </section>
  </div>
  <section aria-labelledby="projectHeading">
    <h2 id="projectHeading">정비사업 경계 조회</h2>
    <p class="meta">서울플랜+ 지도에서 사업명을 검색한 뒤 지정·변경 고시를 확인하세요. 원장 목록과 공식 지도는 자동으로 대조되지 않습니다.</p>
    <div class="links">
      <button id="openOfficialMap" type="button">공식 지도 표시</button>
      <a id="officialMapLink" href="https://urban.seoul.go.kr/view/html/PMNU1100000001" target="_blank" rel="noreferrer">서울플랜+ 새 창</a>
      <a href="https://cleanup.seoul.go.kr/" target="_blank" rel="noreferrer">정비사업 정보몽땅</a>
      <a href="https://data.seoul.go.kr/dataList/OA-22712/F/1/datasetView.do" target="_blank" rel="noreferrer">공간정보 원본·이용조건</a>
    </div>
    <div id="officialMap"></div>
    <label class="project-filter">원장 사업명·사업유형 검색<input id="projectSearch" type="search"></label>
    <p class="meta" id="projectStatus" role="status"></p>
    <div class="scroll"><table><thead><tr><th>사업명</th><th>자치구</th><th>사업유형</th><th>원장 경계 자료</th></tr></thead><tbody id="projects"></tbody></table></div>
  </section>
</main><script nonce="${nonce}">(${dashboard.toString()})();</script>` : `
<main class="login"><section><h1>RADAR 부동산 통합관리</h1>
  ${message ? '<p class="error" role="status">' + message + '</p>' : ''}
  ${mode === 'login' ? '<form method="post" action="/api/radar?action=login"><label>접속 비밀번호<input name="password" type="password" required maxlength="512" autocomplete="current-password"></label><button>접속</button></form>' : ''}
</section></main>`;
  return '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>RADAR 부동산 통합관리</title><style nonce="' +
    nonce + '">' + styles + '</style></head><body>' + content + '</body></html>';
}
