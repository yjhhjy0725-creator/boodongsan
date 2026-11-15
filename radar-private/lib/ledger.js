import { createHash } from 'node:crypto';

const ranges = [
  "'개별매물_원문확인'!A1:V",
  "'RADAR_v2_투자적합순위'!A1:AA",
  "'MAP_EXPORT_v1'!A1:V",
  "'RADAR_구역폴리곤상태'!A1:I",
  "'지도위치_좌표관리'!A1:P",
  "'정비사업_지도레이어'!A1:N",
  "'매물_링크_허브'!A1:I",
  "'BUILDING_VERIFICATION_v1'!A1:Q",
];
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('base64url');
let token;
let snapshot;
let pending;

async function googleToken(oidcToken) {
  if (token?.expires > Date.now()) return token.value;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const audience = process.env.GOOGLE_WORKLOAD_PROVIDER;
  if (!email || !audience || typeof oidcToken !== 'string') throw new Error('Google federation configuration missing');
  const exchange = await fetch('https://sts.googleapis.com/v1/token', {
    method: 'POST', signal: AbortSignal.timeout(8000),
    body: new URLSearchParams({
      audience,
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      subject_token: oidcToken,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
    }),
  });
  if (!exchange.ok) throw new Error('Google federation exchange failed');
  const { access_token: federatedToken } = await exchange.json();
  const response = await fetch('https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/' +
    encodeURIComponent(email) + ':generateAccessToken', {
    method: 'POST', signal: AbortSignal.timeout(8000),
    headers: { Authorization: 'Bearer ' + federatedToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: ['https://www.googleapis.com/auth/spreadsheets.readonly'] }),
  });
  if (!response.ok) throw new Error('Google service account token request failed');
  const result = await response.json();
  token = { value: result.accessToken, expires: Date.parse(result.expireTime) - 60_000 };
  return token.value;
}

function rows(values, required) {
  const [header = [], ...data] = values ?? [];
  if (!required.every((field) => header.includes(field))) throw new Error('Sheet columns changed');
  return data.map((row) => Object.fromEntries(header.map((field, i) => [field, row[i]])));
}

const number = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const yes = (value) => value === true || ['true', 'yes', 'y'].includes(String(value).trim().toLowerCase());

function metric(value) {
  if (typeof value !== 'string') return number(value);
  const text = value.trim();
  return /^\d+(?:\.\d+)?$/.test(text) ? number(Number(text)) : null;
}

function coordinates(lat, lng) {
  return number(lat) !== null && number(lng) !== null && lat >= 37.4 && lat <= 37.75 &&
    lng >= 126.7 && lng <= 127.25 ? [lat, lng] : null;
}

function estimate(row, precisionField, addressField) {
  const precision = row?.[precisionField];
  const point = coordinates(row?.['위도'], row?.['경도']);
  return point && ['동 중심 추정', '구 중심 추정'].includes(precision)
    ? { point, precision, area: row[addressField] || '' }
    : null;
}

function link(value, allowed) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && !url.username && !url.password && allowed(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}

const adHost = (host) => /(^|\.)(daangn\.com|naver\.com|zigbang\.com|dabangapp\.com|hogangnono\.com|kbland\.kr)$/.test(host);
const notionHost = (host) => ['app.notion.com', 'www.notion.so', 'notion.so'].includes(host);
const officialHost = (host) => /\.(go\.kr|seoul\.kr)$/.test(host);
const byKey = (entries, field) => new Map(entries.filter(row => row[field]).map(row => [String(row[field]).trim(), row]));

export function projectLedger([raw, ranking, locations, zoneLedger, adMap, projectMap, linkLedger, verificationLedger]) {
  const ads = rows(raw.values, ['외부매물키', '서울자치구', '단지', '매도호가_억', '전용면적_㎡']);
  const scores = new Map(rows(ranking.values, ['매물고유키', '투자 적합도 100', '근거 신뢰도 100'])
    .map((row) => [String(row['매물고유키'] ?? '').trim(), row]));
  const pins = new Map();
  const estimates = byKey(rows(adMap.values, ['외부매물키', '좌표 정밀도', '위도', '경도']), '외부매물키');
  const projectPoints = byKey(rows(projectMap.values, ['정비사업키', '위치정밀도', '위도', '경도']), '정비사업키');
  const adLinks = byKey(rows(linkLedger.values, ['외부매물키', '원본광고(해당 매물 직접)']), '외부매물키');
  const verificationByKey = new Map();
  const verificationFields = ['external_key', 'building_official_source_url', 'official_address_verified_at',
    'building_pnu', 'verification_status', 'zone_inclusion_status', 'last_updated_at'];
  for (const row of rows(verificationLedger.values, verificationFields)) {
    const id = String(row.external_key ?? '').trim();
    if (!id) continue;
    const previous = verificationByKey.get(id);
    const date = String(row.last_updated_at ?? '');
    if (!previous || date >= String(previous.last_updated_at ?? '')) verificationByKey.set(id, row);
  }
  const locationFields = ['external_key', 'export_eligible', 'building_address_verified', 'coordinate_precision', 'lat', 'lng'];
  for (const row of rows(locations.values, locationFields)) {
    const point = coordinates(row.lat, row.lng);
    if (yes(row.export_eligible) && yes(row.building_address_verified) &&
      ['building_verified', 'verified_building', '실건물확정', '실건물좌표 확인'].includes(String(row.coordinate_precision).trim().toLowerCase()) &&
      point) {
      pins.set(String(row.external_key ?? '').trim(), point);
    }
  }
  const unique = new Map();
  let rawCount = 0;
  for (const row of ads) {
    const id = String(row['외부매물키'] ?? '').trim();
    if (!id) continue;
    rawCount += 1;
    if (unique.has(id)) continue;
    const score = scores.get(id);
    const mapRow = estimates.get(id);
    const links = adLinks.get(id);
    const pin = pins.get(id) ?? null;
    const review = verificationByKey.get(id);
    const addressSource = link(review?.building_official_source_url, officialHost);
    const boundarySource = link(review?.official_boundary_source_url, officialHost);
    const verifiedAddress = addressSource && review?.official_address_verified_at && review?.building_address;
    const pnu = addressSource && /^\d{19}$/.test(String(review?.building_pnu ?? ''));
    const spatialStatus = boundarySource && review?.boundary_version_date &&
      ['구역내_공간대조', '구역외_공간대조', '경계_검증필요'].includes(review?.zone_inclusion_status)
      ? review.zone_inclusion_status : '미확인';
    const listing = {
      id, district: row['서울자치구'] ?? '', name: row['단지'] || '단지명 미확인',
      price: metric(row['매도호가_억']), area: metric(row['전용면적_㎡']),
      score: metric(score?.['투자 적합도 100']), confidence: metric(score?.['근거 신뢰도 100']),
      pin, location: pin ? { point: pin, precision: '검증 건물', area: '' } :
        estimate(mapRow, '좌표 정밀도', '지도표시주소(매물주소 아님)'),
      neighborhood: mapRow?.['기준법정동'] || '',
      floor: row['층'] || '', saleStatus: row['실제 판매 확인'] || '',
      checked: row['조사 확인일'] || '',
      adUrl: link(row['원문매물링크'], adHost) ?? link(links?.['원본광고(해당 매물 직접)'], adHost),
      notionUrl: link(row['노션 상세'], notionHost) ?? link(mapRow?.['노션 상세URL'], notionHost),
      naverUrl: link(links?.['네이버 동일매물 직접링크(검증시)'], host => /(^|\.)land\.naver\.com$/.test(host)),
      searchUrl: link(links?.['네이버 개별매물 검색(미확인)'], host => host === 'search.naver.com'),
      verification: {
        address: verifiedAddress || null,
        addressDate: verifiedAddress ? review.official_address_verified_at : '',
        addressSource,
        pnu: Boolean(pnu),
        spatialStatus,
        boundarySource,
        boundaryDate: boundarySource ? review.boundary_version_date || '' : '',
        status: ['미검증', '검증완료', '보류', '오류'].includes(review?.verification_status) ? review.verification_status : '미검증',
        lastUpdated: review?.last_updated_at || '',
      },
    };
    unique.set(id, { ...listing, revision: hash(listing) });
  }
  const listings = [...unique.values()];
  const zones = new Map();
  for (const row of rows(zoneLedger.values, ['정비사업키', '자치구', '사업명', '사업유형', '경계 파일 확보'])) {
    const id = String(row['정비사업키'] ?? '').trim();
    if (!id || zones.has(id)) continue;
    const mapRow = projectPoints.get(id);
    zones.set(id, {
      id,
      district: String(row['자치구'] ?? '').trim(),
      name: String(row['사업명'] ?? '').replace(/^\s*[^[]*\[정비사업\]\s*/, '').trim(),
      type: String(row['사업유형'] ?? '').trim(),
      boundaryStatus: row['경계 파일 확보'] === '도형 미확보' ? '도형 미확보' : '출처 확인 필요',
      location: estimate(mapRow, '위치정밀도', '지도 대표주소'),
      stage: mapRow?.['기존조사단계'] || '',
      notionUrl: link(mapRow?.['원본 노션URL'], notionHost),
      officialUrl: link(mapRow?.['공개 근거URL'], officialHost),
    });
  }
  const projects = [...zones.values()];
  return {
    listings, fetchedAt: new Date().toISOString(),
    projects, projectRevision: hash(projects),
    counts: { raw: rawCount, unique: listings.length, duplicates: rawCount - listings.length,
      pins: listings.filter((row) => row.pin).length,
      listingLocations: listings.filter((row) => row.location).length,
      projectLocations: projects.filter((row) => row.location).length },
  };
}

async function load(oidcToken) {
  const sheetId = process.env.RADAR_SHEET_ID;
  if (!sheetId || !/^[\w-]+$/.test(sheetId)) throw new Error('Sheet ID missing');
  const query = new URLSearchParams({ valueRenderOption: 'UNFORMATTED_VALUE' });
  for (const range of ranges) query.append('ranges', range);
  const response = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + sheetId + '/values:batchGet?' + query, {
    headers: { Authorization: 'Bearer ' + await googleToken(oidcToken) }, signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('Sheet read failed');
  return projectLedger((await response.json()).valueRanges);
}

export async function getSnapshot(oidcToken) {
  if (snapshot && Date.now() - Date.parse(snapshot.fetchedAt) < 60_000) return snapshot;
  pending ??= load(oidcToken).then((result) => { snapshot = result; return result; }).finally(() => { pending = undefined; });
  return pending;
}

export function delta({ listings, fetchedAt, counts, projects, projectRevision }, revisions, knownProjectRevision) {
  const known = new Map(revisions);
  const changed = listings.filter((listing) => {
    const revision = known.get(listing.id);
    known.delete(listing.id);
    return revision !== listing.revision;
  });
  return {
    changed, removed: [...known.keys()], fetchedAt, counts, projectRevision,
    ...(projectRevision === knownProjectRevision ? {} : { projects }),
  };
}
