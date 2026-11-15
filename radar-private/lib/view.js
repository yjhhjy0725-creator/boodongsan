function dashboard() {
  const byId = (id) => document.getElementById(id);
  const state = new Map();
  const canvas = byId('map');
  const ctx = canvas.getContext('2d');
  let zoom = 11;
  function project(lat, lng) {
    const size = 256 * 2 ** zoom;
    const rad = lat * Math.PI / 180;
    return [(lng + 180) / 360 * size, (1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2 * size];
  }
  let [centerX, centerY] = project(37.56, 126.98);
  let x0, y0;
  const tiles = new Map();
  let visibleTiles = [];
  let displayed = [];
  let projects = [];
  let displayedProjects = [];
  let selection;
  let saved = new Set();
  try { saved = new Set(JSON.parse(localStorage.getItem('radar-saved-listings') || '[]')); } catch {}
  let projectRevision;
  let syncing = false;
  let lastAttempt = 0;
  const refreshIntervalMs = 120_000;
  function draw() {
    ctx.fillStyle = '#e7eeeb';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const { img, x, y } of visibleTiles) {
      if (img.naturalWidth) ctx.drawImage(img, x * 256 - x0, y * 256 - y0);
    }
  }
  function mapItems() {
    return [
      ...(byId('showAds').checked ? displayed.filter(row => row.location).map(row => ({ row, kind: 'ad' })) : []),
      ...(byId('showProjects').checked ? displayedProjects.filter(row => row.location).map(row => ({ row, kind: 'project' })) : []),
    ];
  }
  function textNode(tag, value, className) {
    const el = document.createElement(tag);
    el.textContent = value;
    if (className) el.className = className;
    return el;
  }
  function action(label, fn, className = 'secondary') {
    const button = textNode('button', label, className);
    button.type = 'button';
    button.addEventListener('click', fn);
    return button;
  }
  function external(label, url) {
    const anchor = textNode('a', label);
    anchor.href = url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    return anchor;
  }
  function showDetail(row, kind) {
    selection = { id: row.id, kind };
    const box = byId('detail');
    const info = kind === 'ad'
      ? [row.district, row.neighborhood, row.floor, row.price === null ? null : row.price + '억', row.area === null ? null : row.area + '㎡']
      : [row.district, row.type, row.stage, row.boundaryStatus];
    const precision = row.location ? [row.location.precision, row.location.area].filter(Boolean).join(' · ') : '지도 위치 미확보';
    box.replaceChildren(textNode('h3', row.name), textNode('p', info.filter(Boolean).join(' · '), 'meta'),
      textNode('p', precision, 'precision'));
    if (kind === 'ad') {
      const status = [row.saleStatus, row.checked && '조사 ' + row.checked].filter(Boolean).join(' · ');
      if (status) box.append(textNode('p', status, 'meta'));
    }
    const links = textNode('div', '', 'links');
    if (row.adUrl) links.append(external('광고 원문', row.adUrl));
    if (row.notionUrl) links.append(external('Notion 상세', row.notionUrl));
    if (row.searchUrl) links.append(external('유사 매물 검색', row.searchUrl));
    if (row.officialUrl) links.append(external('공식 근거', row.officialUrl));
    if (kind === 'project') links.append(external('서울플랜+에서 경계 확인', byId('officialMapLink').href));
    if (kind === 'ad') {
      links.append(action(saved.has(row.id) ? '관심 해제' : '관심 매물 저장', () => {
        if (saved.has(row.id)) saved.delete(row.id);
        else saved.add(row.id);
        try { localStorage.setItem('radar-saved-listings', JSON.stringify([...saved])); } catch {}
        renderRows();
        refreshMap();
        showDetail(row, kind);
      }));
    }
    if (row.location) links.append(action('지도에서 보기', () => {
      if (!byId(kind === 'ad' ? 'showAds' : 'showProjects').checked) byId(kind === 'ad' ? 'showAds' : 'showProjects').checked = true;
      zoom = Math.max(zoom, 13);
      [centerX, centerY] = project(...row.location.point);
      refreshMap();
      byId('mapPanel').scrollIntoView({ block: 'nearest' });
    }));
    box.append(links);
  }
  function showGroup(items) {
    const box = byId('group');
    box.hidden = items.length < 2;
    box.replaceChildren();
    if (items.length > 1) {
      box.append(textNode('h3', '이 위치의 매물·사업 ' + items.length + '건'));
      for (const { row, kind } of items) {
        box.append(action((kind === 'ad' ? '매물 · ' : '사업 · ') + row.name, () => showDetail(row, kind), 'rowLink'));
      }
    }
    showDetail(items[0].row, items[0].kind);
  }
  function refreshMap() {
    x0 = Math.floor(centerX - canvas.width / 2);
    y0 = Math.floor(centerY - canvas.height / 2);
    visibleTiles = [];
    for (let x = Math.floor(x0 / 256); x * 256 < x0 + canvas.width; x += 1) {
      for (let y = Math.floor(y0 / 256); y * 256 < y0 + canvas.height; y += 1) {
        const key = [zoom, x, y].join('/');
        if (!tiles.has(key)) {
          const img = new Image();
          img.onload = draw;
          img.src = 'https://tile.openstreetmap.org/' + key + '.png';
          tiles.set(key, { img, x, y });
        }
        visibleTiles.push(tiles.get(key));
      }
    }
    while (tiles.size > 80) tiles.delete(tiles.keys().next().value);
    draw();
    const items = mapItems();
    const groups = new Map();
    const fragment = document.createDocumentFragment();
    for (const item of items) {
      const [worldX, worldY] = project(...item.row.location.point);
      const x = worldX - x0;
      const y = worldY - y0;
      if (x < 12 || x > canvas.width - 12 || y < 12 || y > canvas.height - 12) continue;
      const key = Math.round(x / 38) + '/' + Math.round(y / 38);
      if (!groups.has(key)) groups.set(key, { x, y, members: [] });
      groups.get(key).members.push(item);
    }
    for (const { x, y, members } of groups.values()) {
      const one = members[0];
      const kind = members.length > 1 ? 'cluster' : one.kind === 'project' ? 'project' : one.row.pin ? 'verified' : 'estimate';
      const marker = action(members.length > 1 ? members.length : one.kind === 'project' ? '사' : '매',
        () => showGroup(members), 'marker ' + kind);
      marker.style.left = (x / canvas.width * 100) + '%';
      marker.style.top = (y / canvas.height * 100) + '%';
      marker.title = members.length > 1 ? '가까운 매물·사업 ' + members.length + '건' : one.row.name + ' · ' + one.row.location.precision;
      marker.setAttribute('aria-label', marker.title);
      fragment.append(marker);
    }
    byId('markers').replaceChildren(fragment);
    const shown = [...groups.values()].flatMap(g => g.members);
    byId('pinStatus').textContent = '지도 범위 내 매물 ' + shown.filter(x => x.kind === 'ad').length +
      '건 · 정비사업 ' + shown.filter(x => x.kind === 'project').length + '건 · 검증 건물 ' +
      shown.filter(x => x.row.pin).length + '건';
    byId('zoomIn').disabled = zoom >= 15;
    byId('zoomOut').disabled = zoom <= 10;
  }
  function fitMap() {
    const items = mapItems();
    if (!items.length) { refreshMap(); return; }
    zoom = 13;
    const bounds = () => {
      const points = items.map(({ row }) => project(...row.location.point));
      const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
      return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    };
    let box = bounds();
    while (zoom > 10 && (box[1] - box[0] > canvas.width - 100 || box[3] - box[2] > canvas.height - 100)) {
      zoom -= 1;
      box = bounds();
    }
    centerX = (box[0] + box[1]) / 2;
    centerY = (box[2] + box[3]) / 2;
    refreshMap();
  }
  function renderRows() {
    const district = byId('district').value;
    const term = byId('search').value.trim().toLowerCase();
    const budget = byId('budget').valueAsNumber;
    displayed = [...state.values()].filter((ad) =>
      (!district || district === ad.district) &&
      (!byId('savedOnly').checked || saved.has(ad.id)) &&
      (!term || [ad.name, ad.district, ad.id].some((value) => String(value).toLowerCase().includes(term))) &&
      (!Number.isFinite(budget) || (ad.price !== null && ad.price <= budget)));
    displayed.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    const priced = displayed.filter((ad) => ad.price !== null);
    const average = priced.length ? (priced.reduce((sum, ad) => sum + ad.price, 0) / priced.length).toFixed(2) + '억' : '—';
    byId('results').textContent = displayed.length + '건 · 평균 관찰호가 ' + average;
    const fragment = document.createDocumentFragment();
    for (const ad of displayed) {
      const tr = document.createElement('tr');
      const name = document.createElement('td');
      name.append(action((saved.has(ad.id) ? '★ ' : '') + ad.name, () => {
        byId('group').hidden = true;
        showDetail(ad, 'ad');
        byId('detail').scrollIntoView({ block: 'nearest' });
      }, 'rowLink'));
      tr.append(name);
      for (const value of [ad.district || '—', ad.price ?? '—', ad.area ?? '—', ad.score ?? '—', ad.confidence ?? '—']) {
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
    displayedProjects = projects.filter((project) =>
      (!district || district === project.district) &&
      (!term || [project.name, project.type].some((value) => value.toLowerCase().includes(term))));
    byId('projectStatus').textContent = '표시 ' + displayedProjects.length + '건 / 원장 ' + projects.length + '건';
    const fragment = document.createDocumentFragment();
    for (const project of displayedProjects) {
      const tr = document.createElement('tr');
      const name = document.createElement('td');
      name.append(action(project.name, () => {
        byId('group').hidden = true;
        showDetail(project, 'project');
        byId('detail').scrollIntoView({ block: 'nearest' });
      }, 'rowLink'));
      tr.append(name);
      for (const value of [project.district, project.type, project.boundaryStatus]) {
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
      const firstLoad = !projectRevision;
      const { changed, removed, counts, fetchedAt } = payload;
      if (payload.projects) projects = payload.projects;
      projectRevision = payload.projectRevision;
      for (const id of removed) state.delete(id);
      for (const ad of changed) state.set(ad.id, ad);
      byId('status').textContent = '원문 ' + counts.raw + '행 · 고유 ' + counts.unique + '건 · 중복 ' +
        counts.duplicates + '행 · ' + new Date(fetchedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) + ' 원장 조회';
      const changedMap = firstLoad || changed.length || removed.length || payload.projects;
      if (changedMap) {
        renderRows();
        renderProjects();
        byId('group').hidden = true;
        if (firstLoad) fitMap();
        else refreshMap();
      }
      if (selection && changedMap) {
        const row = selection.kind === 'ad' ? state.get(selection.id) : projects.find(project => project.id === selection.id);
        if (row) showDetail(row, selection.kind);
        else {
          selection = undefined;
          byId('detail').textContent = '선택한 항목이 원장에서 사라졌습니다.';
        }
      }
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
  function applyFilters() {
    renderRows();
    renderProjects();
    byId('group').hidden = true;
    fitMap();
  }
  for (const id of ['district', 'search', 'budget', 'savedOnly', 'projectSearch', 'showAds', 'showProjects']) {
    byId(id).addEventListener('input', applyFilters);
  }
  function changeZoom(step) {
    zoom += step;
    centerX *= 2 ** step;
    centerY *= 2 ** step;
    refreshMap();
  }
  byId('zoomIn').addEventListener('click', () => changeZoom(1));
  byId('zoomOut').addEventListener('click', () => changeZoom(-1));
  byId('fitMap').addEventListener('click', fitMap);
  let drag;
  canvas.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    drag = [event.clientX, event.clientY];
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointercancel', () => { drag = undefined; });
  canvas.addEventListener('pointerup', (event) => {
    if (!drag) return;
    const scale = canvas.width / canvas.getBoundingClientRect().width;
    const [left, bottom] = project(37.37, 126.67);
    const [right, top] = project(37.78, 127.28);
    centerX = Math.max(left, Math.min(right, centerX - (event.clientX - drag[0]) * scale));
    centerY = Math.max(top, Math.min(bottom, centerY - (event.clientY - drag[1]) * scale));
    drag = undefined;
    refreshMap();
  });
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
  refreshMap();
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
.mapFrame{position:relative;isolation:isolate}canvas{cursor:grab;touch-action:none}
.mapTools,.legend{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;margin:8px 0}
.mapTools label,.filters label.check{display:flex;align-items:center;gap:5px}
.filters label.check input{width:auto}
.marker{position:absolute;transform:translate(-50%,-50%);min-width:25px;height:25px;padding:0 5px;border:2px solid white;border-radius:50%;box-shadow:0 1px 5px #243b30aa;z-index:1;font-size:12px;font-weight:750}
.marker:focus-visible,.marker:hover{z-index:3;outline:2px solid #172c38;outline-offset:2px}
.estimate{background:#96601a}.verified{background:#12654f}.project{background:#3c54a0}.cluster{background:#263b4d}
.legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:4px}
.secondary{background:#edf5f0;color:#174e3e;border-color:#abc4b7}
.rowLink{background:none;color:#135340;border:none;padding:2px;text-align:left;text-decoration:underline;text-underline-offset:2px}
.detail,.group{background:#f1f6f3;border-radius:10px;padding:11px;margin-top:12px}
.detail h3,.group h3{margin:0;font-size:16px}.detail .links{margin-bottom:0}
.group{max-height:168px;overflow:auto}.group button{display:block}
.precision{color:#805218;font-weight:600}
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
    <label class="check"><input id="savedOnly" type="checkbox"> 관심 매물만</label>
    <button id="refresh" type="button">원장 새로고침</button>
  </div><p class="meta" id="status" role="status"></p><small>이 화면이 열려 있는 동안 2분마다 원장을 확인합니다.</small></section>
  <div class="grid">
    <section id="mapPanel"><h2>서울 매물·정비사업 지도</h2>
      <div class="mapTools">
        <label><input id="showAds" type="checkbox" checked> 매물</label>
        <label><input id="showProjects" type="checkbox" checked> 정비사업</label>
        <button id="zoomIn" class="secondary" type="button" aria-label="지도 확대">+</button>
        <button id="zoomOut" class="secondary" type="button" aria-label="지도 축소">−</button>
        <button id="fitMap" class="secondary" type="button">검색 범위 맞춤</button>
      </div>
      <p class="meta" id="pinStatus" role="status">좌표 조회 중</p>
      <div class="mapFrame"><canvas id="map" width="780" height="550" aria-label="서울 매물·정비사업 지도. 마커 또는 매물 목록을 선택하세요."></canvas><div id="markers" aria-label="지도 마커"></div></div>
      <div class="legend"><small><i class="estimate"></i>추정 매물</small><small><i class="project"></i>사업 대표 위치</small><small><i class="verified"></i>검증 건물</small><small><i class="cluster"></i>가까운 항목 묶음</small></div>
      <small>동·구 중심 추정 핀으로 실건물 위치나 구역 편입을 판단할 수 없습니다. © <a href="https://www.openstreetmap.org/copyright" rel="noreferrer">OpenStreetMap</a> contributors</small>
      <div id="group" class="group" hidden></div>
      <div id="detail" class="detail" aria-live="polite">핀이나 목록을 선택하면 상세 정보가 표시됩니다.</div>
    </section>
    <section><h2>매물 검색·분석</h2><p class="meta" id="results"></p><p class="meta">관심 매물은 현재 브라우저에 저장됩니다. 투자 적합도와 근거 신뢰도는 사전 검토 지표입니다.</p>
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
