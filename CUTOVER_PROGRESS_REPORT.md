# AI Cutover 운영 진행 보고서 (2026-03-11)

---

## [2026-03-11] 502 COPILOT_PROXY_FAILED 근본 원인 분석 및 조치

### 원인
`GET /api/ai/health`, preflight, `GET /api/ai/token`은 모두 PASS인데,  
`POST /api/ai/chat`(minted token)에서만 `COPILOT_PROXY_FAILED`와 함께  
`ENOENT: no such file or directory, mkdir '/etc/secrets/cache'`가 반복됩니다.

현재 증거로는 `MYAGENT_HOME=/etc/secrets`일 때 런타임 캐시 경로 생성 실패가 핵심 원인으로 보입니다.  
(`MYAGENT_GITHUB_TOKEN` 미설정 가설은 현재 로그와 정합되지 않음)

### 조치 내용
1. `verify-cutover.ps1` 패치: 에러 응답 본문 추출 우선순위 강화(`ErrorDetails` + stream + curl fallback)
2. `src/runtime-token.ts` 패치: 쓰기 가능한 캐시 경로만 사용하도록 변경(권장 fallback 캐시 경로 우선)
3. `setup-render-github-token.ps1` 신규 작성: Render API로 `MYAGENT_GITHUB_TOKEN` 설정 + 재배포 + verify 자동화

### 다음 실행 순서
```powershell
Set-Location "C:\Users\jichu\Downloads\iran_abu_dash-main"
.\standalone-package\setup-render-github-token.ps1 -PromptForMissing -RunVerify
```
프롬프트에서 순서대로 입력:
1. Render API 키 (`dashboard.render.com → Account Settings → API Keys`)
2. GitHub PAT (`Copilot 접근 권한 있는 ghp_... 또는 ghu_...`)

---

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
7. `2026-03-11 10:41:27+04:00` 기준 재검증
   - `verify-cutover.ps1` 실행
     - `GET /api/ai/health` = 200 (PASS)
     - `OPTIONS` 허용 origin = 204 (PASS)
     - `OPTIONS` 금지 origin = 403 (PASS)
     - `GET /api/ai/token` = 200 (PASS)
     - `minted endpoint` = `https://iran-abu-ai-proxy.onrender.com/api/ai/chat` (PASS)
     - `POST /api/ai/chat`(minted token) = **502** (FAIL)
   - 응답 본문:
     - `{\"error\":\"COPILOT_PROXY_FAILED\",\"detail\":\"ENOENT: no such file or directory, mkdir '/etc/secrets/cache'\",\"code\":\"unknown\"}`
   - 판정: 여전히 `/etc/secrets/cache` 쓰기 실패 경로 오류가 남아 백엔드 chat 경로 미복구.

### 판정
- 현재 상태는 **백엔드 chat 502 단일 실패**로 수렴했으며, 원인 후보는 캐시 경로 생성 실패(`/etc/secrets/cache`)로 좁혀짐.
- 최근 `verify-cutover` 결과: `health`, `preflight`, `token mint`는 모두 PASS, `chat with minted token`만 `502 COPILOT_PROXY_FAILED`.
- `src/runtime-token.ts` 패치는 반영되었으나 Render 운영 반영이 아직 필요함. 반영 후 재배포/재검증으로 통과 여부를 판정.

### 8) `2026-03-11 10:44:10+04:00` 추가 재검증
- `verify-cutover.ps1` 실행
  - `GET /api/ai/health` = 200 (PASS)
  - `OPTIONS` 허용 origin = 204 (PASS)
  - `OPTIONS` 금지 origin = 403 (PASS)
  - `GET /api/ai/token` = 200 (PASS)
  - `minted endpoint` = `https://iran-abu-ai-proxy.onrender.com/api/ai/chat` (PASS)
  - `POST /api/ai/chat`(minted token) = **502** (FAIL)
- 응답 본문:
  - `{"requestId":"2b54eea3-b29f-455c-bfed-f335009a6ddd","error":"COPILOT_PROXY_FAILED","detail":"ENOENT: no such file or directory, mkdir '/etc/secrets/cache'","code":"unknown"}`
- 판정: 동일 증상 재현. 여전히 `/etc/secrets/cache` 경로 기반 런타임 캐시 처리 실패가 차단 요인.

### 9) `2026-03-11 11:20:00+04:00` 패치 반영 후 재검증
- `verify-cutover.ps1` 실행 결과
  - `GET /api/ai/health` = 200 (PASS)
  - `OPTIONS` 허용 origin = 204 (PASS)
  - `OPTIONS` 금지 origin = 403 (PASS)
  - `GET /api/ai/token` = 200 (PASS)
  - `minted endpoint` = `https://iran-abu-ai-proxy.onrender.com/api/ai/chat` (PASS)
  - `POST /api/ai/chat`(minted token) = **502** (FAIL)
- `verify-cutover` 오류 바디 캡처 결과:
  - `{"requestId":"72dc10dd-87ba-4720-a47f-53ed33fe7faf","error":"COPILOT_PROXY_FAILED","detail":"ENOENT: no such file or directory, mkdir '/etc/secrets/cache'","code":"unknown"}`
- 현재 판단: 코드 패치 자체는 원격 반영이 전제되어야 확인 가능하므로, Render 재배포 후 재실행해야 함.

## 5) 단계별 대응(계획 고정)

### `2026-03-11 11:02:00+04:00` 로컬 패치 반영 직후 검증 상태
- `verify-cutover.ps1` 실행 결과 (현재 코드 상태, 1차 재실행)
  - `GET /api/ai/health` = 200 (PASS)
  - `OPTIONS` 허용 origin = 204 (PASS)
  - `OPTIONS` 금지 origin = 403 (PASS)
  - `GET /api/ai/token` = 200 (PASS)
  - `minted endpoint` = `https://iran-abu-ai-proxy.onrender.com/api/ai/chat` (PASS)
  - `POST /api/ai/chat`(minted token) = **502** (FAIL)
- 현재 502 원인은 아직도 `/etc/secrets/cache` 경로에서의 `mkdir` 에러로 추정.
- 이 시점에 적용된 코드:
  - `src/runtime-token.ts`에서 캐시 경로를 쓰기 가능성 기준으로 probe 후 선별
  - `verify-cutover.ps1` 에러 본문 추출 경로 개선
  - `setup-render-github-token.ps1` 신규 자동화 스크립트 추가
- 판단: 로컬 코드만 바꾼 상태에서는 해결되지 않음. Render 재배포가 우선입니다.

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
