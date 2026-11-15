import { createHash } from 'node:crypto';

const ranges = [
  "'개별매물_원문확인'!A1:V",
  "'RADAR_v2_투자적합순위'!A1:AA",
  "'MAP_EXPORT_v1'!A1:V",
  "'RADAR_구역폴리곤상태'!A1:I",
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

export function projectLedger([raw, ranking, locations, zoneLedger]) {
  const ads = rows(raw.values, ['외부매물키', '서울자치구', '단지', '매도호가_억', '전용면적_㎡']);
  const scores = new Map(rows(ranking.values, ['매물고유키', '투자 적합도 100', '근거 신뢰도 100'])
    .map((row) => [String(row['매물고유키'] ?? '').trim(), row]));
  const pins = new Map();
  const locationFields = ['external_key', 'export_eligible', 'building_address_verified', 'coordinate_precision', 'lat', 'lng'];
  for (const row of rows(locations.values, locationFields)) {
    const lat = number(row.lat);
    const lng = number(row.lng);
    if (yes(row.export_eligible) && yes(row.building_address_verified) &&
      ['building_verified', 'verified_building', '실건물확정', '실건물좌표 확인'].includes(String(row.coordinate_precision).trim().toLowerCase()) &&
      lat >= 37.4 && lat <= 37.75 && lng >= 126.7 && lng <= 127.25) {
      pins.set(String(row.external_key ?? '').trim(), [lat, lng]);
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
    const listing = {
      id, district: row['서울자치구'] ?? '', name: row['단지'] || '단지명 미확인',
      price: number(row['매도호가_억']), area: number(row['전용면적_㎡']),
      score: number(score?.['투자 적합도 100']), confidence: number(score?.['근거 신뢰도 100']),
      pin: pins.get(id) ?? null,
    };
    unique.set(id, { ...listing, revision: hash(listing) });
  }
  const listings = [...unique.values()];
  const zones = new Map();
  for (const row of rows(zoneLedger.values, ['정비사업키', '자치구', '사업명', '사업유형', '경계 파일 확보'])) {
    const id = String(row['정비사업키'] ?? '').trim();
    if (!id || zones.has(id)) continue;
    zones.set(id, {
      district: String(row['자치구'] ?? '').trim(),
      name: String(row['사업명'] ?? '').replace(/^\s*[^[]*\[정비사업\]\s*/, '').trim(),
      type: String(row['사업유형'] ?? '').trim(),
      boundaryStatus: row['경계 파일 확보'] === '도형 미확보' ? '도형 미확보' : '출처 확인 필요',
    });
  }
  const projects = [...zones.values()];
  return {
    listings, fetchedAt: new Date().toISOString(),
    projects, projectRevision: hash(projects),
    counts: { raw: rawCount, unique: listings.length, duplicates: rawCount - listings.length,
      pins: listings.filter((row) => row.pin).length },
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
