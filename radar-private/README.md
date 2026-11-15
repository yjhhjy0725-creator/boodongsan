# RADAR 부동산 통합관리

운영 프로젝트는 Vercel의 `radar-private`입니다. 이 디렉터리 안의 앱 파일을 프로젝트 루트로 직접 배포합니다. Git 빌드는 `radar-private-staging` 브랜치의 `radar-private` 폴더를 사용하며, 운영 설정은 별도 프로젝트에 있습니다.

| 서버 환경 변수 | 설정값 |
| --- | --- |
| `RADAR_SHARE_PASSWORD` | 비밀번호 관리자에서 생성한 20자 이상의 무작위 공유 비밀번호 |
| `RADAR_SESSION_SECRET` | 공유 비밀번호와 독립적으로 생성한 32자 이상의 무작위 서명 비밀 |
| `RADAR_SHEET_ID` | RADAR 원장 파일 ID |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Google Sheets API가 활성화된 프로젝트의 전용 서비스 계정 이메일 |
| `GOOGLE_WORKLOAD_PROVIDER` | Google STS 대상 공급자 URI. `//iam.googleapis.com/projects/…/locations/global/workloadIdentityPools/…/providers/…` 형식 |

원장을 전용 서비스 계정에 뷰어로만 공유합니다. Google Sheets API와 IAM Service Account Credentials API를 활성화하고 전용 공급자에 Vercel 팀 발급자와 팀 대상을 등록합니다. 공급자와 서비스 계정의 워크로드 권한은 운영 프로젝트의 정확한 주체에만 부여합니다. 앱은 Vercel의 단기 OIDC 토큰을 Google 읽기 전용 토큰으로 교환합니다. 비밀번호와 서명 비밀은 Vercel 서버 변수에서 관리하며, 교체한 뒤 재배포합니다. 비밀번호 또는 서명 비밀을 교체한 새 배포에서는 이전 쿠키가 만료됩니다. 이전 배포 URL도 계속 접근할 수 있는지 확인하고, 필요하면 해당 배포를 제거하거나 플랫폼에서 차단합니다.

운영은 Vercel Authentication의 Standard Protection과 앱의 서버 비밀번호 인증을 함께 사용합니다. 대표 운영 주소에서는 Vercel 계정 없이 앱 비밀번호로 로그인합니다. 미리보기와 개별 배포 주소에는 Vercel Authentication도 적용됩니다. 운영 주소를 허용 대상에게 공유하고, 공유 비밀번호는 별도 경로로 전달합니다. 접근을 회수하려면 비밀번호 교체 후 운영 재배포를 하고 이전 비밀번호와 로그인 쿠키로 데이터 API에 접근할 수 없는지 확인합니다. 개인별 접근 회수는 현재 공유 비밀번호 방식에서 지원하지 않습니다.

원장은 읽기 전용입니다. 서버는 최대 60초 동안 원장 조회 결과를 보관합니다. 브라우저는 이전 조회 이후 추가·변경·삭제된 매물과 버전이 달라진 정비사업 목록을 받습니다. 서울플랜+의 공식 지도는 사용자가 눌렀을 때 원본에서 불러옵니다. 앱 지도에는 적격·건물 주소 확인·실건물 정밀도가 일치한 매물 좌표만 그립니다. 서울시 경계 도형은 가공하거나 저장하지 않으며, 매물과 경계의 자동 중첩 및 편입 판정은 제공하지 않습니다.
