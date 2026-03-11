# AI Cutover 운영 진행 보고서 (2026-03-11)

## 1) 운영 목표 (요청 반영)

- `AI_PROXY_DISABLED` / `AI_PROXY_ENABLED=0` 상태를 해소하고 운영 기준으로 AI 게이트를 고정한다.
- 브라우저 경로는 `GET /api/ai/token`(Vercel) → `signed token` 발급 → 프록시 `POST /api/ai/chat` 호출로 유지한다.
- `verify-cutover` PASS 후 Ask AI / Simulator AI 보조 / SourceGapPanel 재분석 스모크를 연쇄 확인한다.

## 2) 실행 기준

### Vercel production env (필수)
- `AI_PROXY_ENABLED=1`
- `AI_PROXY_ENDPOINT=https://iran-abu-ai-proxy.onrender.com/api/ai/chat`
- `AI_PROXY_ACTIVE_SIGNING_SECRET=<SECRET_A>`
- `AI_PROXY_TOKEN_ISSUER=iran-abu-dash`
- `AI_PROXY_TOKEN_AUDIENCE=myagent-copilot-standalone`
- `AI_PROXY_TOKEN_TTL_SECONDS=300`

### Vercel preview env
- `AI_PROXY_ENABLED=0`

### 배포 경로
- `vercel deploy`는 항상 `--cwd <react>`로 고정해 실행합니다.

## 3) 적용 상태(코드)

- `standalone-package/activate-vercel-ai-cutover.ps1` 정비
  - `vercel env add`를 `--value` + stdin fallback 2중 경로로 통일
  - placeholder/`< >`/공백/비ASCII 토큰 사전 차단
  - `VERCEL_TOKEN` 유효성 실패 시 `vercel whoami` 세션으로 fallback
  - `preview`에서 `git_branch_required` 시 브랜치 재시도
  - 재배포는 `vercel deploy --prod -y --cwd <react>` 고정
- `standalone-package/verify-cutover.ps1` 정비
  - 항목별 실패 시 다음 조치 힌트 출력
  - `status=0`, token 403, endpoint mismatch, invalid token 케이스 분기 메시지
  - token endpoint empty body 경고 처리 추가

## 4) 누적 실패/성공 기록 (실측)

### 성공 확인
- `vercel whoami` 로그인 세션 확인됨 (`mscho715-9387`).
- 이전 로그에서 인증/권한 교체 흐름은 동작했으나, 최종 cutover 단계는 게이트/배포 정합성 문제로 미완료.

### 실패 기록
1. `--VERCEL_TOKEN`에 플레이스홀더를 넣은 실행
   - `invalid token value` 에러 반복 (`<...>`/설명문 입력).
2. `VERCEL_TOKEN` 짧은 값(`wlrwjqgkfk`) 실행
   - `VERCEL_TOKEN length is too short`.
3. `verify-cutover` 실행 결과 (여러차례)
   - `health` / `preflight` / `chat`가 `status=0`
   - 일부 구간에서 `token mint endpoint = 403`
   - `minted endpoint mismatch` / `token parsing failed`
4. `activate-vercel-ai-cutover.ps1` 실행 경로에서 `--token` 전달 값 유효성 선검증 추가로 `wlrwjqgkfk` 같은 짧은 문자열은 즉시 중단되도록 정규화.
5. `Add-VercelEnv` 함수에서 Vercel CLI 버전별 동작 차이를 보완(현재 스크립트는 `--value` 실패 시 stdin 재시도).
6. `src/runtime-token.ts` 패치 후 커밋/푸시 완료.
   - 커밋: `4d6ce90`
   - 메시지: `fix: avoid write cache when myagent home path is read-only`
   - 브랜치: `chore/harden-cutover-script`
   - 푸시: `origin/chore/harden-cutover-script`

### 판정
- 현재 상태는 **백엔드 chat 502** 단일 실패로 수렴했으며, 현재 시점에서는 Render 서비스에 패치 반영 전 추정.
  - 최근 `verify-cutover` 결과: `health`, `preflight`, `token mint`는 모두 PASS, `chat with minted token`만 `502 COPILOT_PROXY_FAILED` (직전과 동일).
- `src/runtime-token.ts` 패치의 목적은 `/etc/secrets` 쓰기 실패로 인한 502를 제거하는 데 있음. Render 재배포 후 재검증이 필요.

## 5) 단계별 대응(계획 고정)

### `token=403`
- `AI_PROXY_ENABLED=1` 실제 반영 확인 → production redeploy → 재검증.

### `minted endpoint mismatch`
- Vercel `AI_PROXY_ENDPOINT`와 token 응답 `endpoint` 값 동기화.

### `status=0`
- 배포 완료/서비스 가용성/도메인 접근성부터 확인, 즉시 재시도.

### 통과 조건
- `GET <proxy>/api/ai/health = 200`
- `OPTIONS` 허용 origin `204`, 금지 origin `403`
- `GET /api/ai/token = 200` 및 `endpoint` 일치
- minted token chat `200 | 409 | 422`, invalid token `401|403`

## 6) 실행 템플릿

```powershell
Set-Location "C:\Users\jichu\Downloads\iran_abu_dash-main"
$env:VERCEL_TOKEN = "<실제_VERCEL_TOKEN>"   # 실제 값 또는 빈값 허용(로그인 세션 사용)
$secretA = "<SECRET_A>"

.\standalone-package\activate-vercel-ai-cutover.ps1 `
  -ProjectPath .\react `
  -DashUrl "https://iran-abu-dash.vercel.app" `
  -ProxyEndpoint "https://iran-abu-ai-proxy.onrender.com/api/ai/chat" `
  -VercelToken $env:VERCEL_TOKEN `
  -SecretA $secretA `
  -RunSmoke:$false
```

검증 PASS 시:

```powershell
.\standalone-package\activate-vercel-ai-cutover.ps1 ... -RunSmoke:$true
```

### 1차 실행 출력 판정 체크리스트 (요약)

`Cutover`는 아래 3개 분기로 판독한다.

1) `token endpoint = 403`
- 조치: `AI_PROXY_ENABLED=1`이 production에 반영됐는지 확인 후 재배포.
2) `minted endpoint mismatch`
- 조치: `AI_PROXY_ENDPOINT`와 token 응답 `endpoint` 값 1:1 정합.
3) `status=0`
- 조치: 배포/도메인 접근성 먼저 확인, 즉시 `verify-cutover` 재실행.

### 2차 실행(운영 전환)

1차 PASS 후 다음 커맨드만 변경해 smoke 진행:

```powershell
.\standalone-package\activate-vercel-ai-cutover.ps1 `
  -ProjectPath .\react `
  -DashUrl "https://iran-abu-dash.vercel.app" `
  -ProxyEndpoint "https://iran-abu-ai-proxy.onrender.com/api/ai/chat" `
  -RunSmoke:$true `
  -SecretA "<SECRET_A>"
```

실패 시 바로 보고할 항목:

- `verify-cutover` 실패 사유 목록(`health/preflight/token/chat`)
- 각 항목의 실제 HTTP status
- token 응답 body(특히 `endpoint`, `token` 존재 유무)

## 7) 다음 완료 조건

- 위 실행이 성공하고 `verify-cutover` pass면 즉시 다음 항목 렌더 확인:
  - Ask AI 응답 1회 성공 렌더
  - Simulator AI 보조 재분석 1회 성공 렌더
  - SourceGapPanel 재분석 1회 성공 렌더
- UI 스모크 통과 후 동일 결과를 문서 최상단에 날짜/성공코드/응답 코드로 기록.
