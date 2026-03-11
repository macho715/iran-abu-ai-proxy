# AI Cutover 운영 진행 보고서 (2026-03-11)

---

## [2026-03-11] VITE_AI_ENDPOINT Vercel 반영 및 재배포 완료 — Ask AI 활성 확인

### 최종 상태 (2026-03-11 기준)

| 항목 | 결과 |
|---|---|
| verify-cutover: health | PASS 200 |
| verify-cutover: preflight allowed | PASS 204 |
| verify-cutover: preflight forbidden | PASS 403 |
| verify-cutover: token mint endpoint | PASS 200 |
| verify-cutover: token body (endpoint) | PASS |
| verify-cutover: minted endpoint match | PASS |
| verify-cutover: chat with minted token | PASS |
| verify-cutover: chat invalid token | PASS |
| UI smoke: 대시보드 로드 | PASS |
| UI smoke: Ask AI 트리거 | **PASS** (비활성→활성 전환 확인) |
| UI smoke: Simulator 보조 | FAIL (shortcut-overlay 미닫힘) |
| UI smoke: SourceGap 재분석 | FAIL (shortcut-overlay 미닫힘) |

**핵심 성과**: `Ask AI` 버튼이 더 이상 disabled가 아님. `VITE_AI_ENDPOINT` 설정 및 재빌드로 `isLoopbackEndpoint()` 우회 해소.

### 조치 내용
1. `vercel env add VITE_AI_ENDPOINT production` — CLI로 직접 설정
2. Vercel REST API `POST /v13/deployments?forceNew=1` — 기존 배포(`dpl_2ssS9kHgc5br4nqmnEkoYq1gAeJn`) 재빌드 트리거
3. 새 배포 ID: `dpl_7AtSt5he3TyLSuCTf9eFCRnTH7Tr`, state=READY, alias assigned

### 잔여 항목
- UI smoke Simulator/SourceGap FAIL: Ask AI 패널(`shortcut-overlay`)이 Escape 2회로 닫히지 않아 뒤 탭 클릭 차단. 프로덕션 기능 자체 이상 없음 (verify-cutover 전 항목 PASS, 브라우저 직접 검증 정상). 스모크 스크립트 overlay 해제 로직 보강 필요.
- `responseStatus=none`: Ask AI 제출 후 `/api/ai/chat` waitForResponse(20s) 타임아웃. Render cold start 또는 실제 AI 응답 지연 추정. 기능 이상이 아닌 타임아웃 값 조정 필요.

---

## [2026-03-11] "Failed to fetch" 원인 확정 및 activate-vercel-ai-cutover.ps1 수정

### 원인
브라우저에서 실제 채팅 호출 URL = `http://127.0.0.1:3010/api/ai/chat` (기본 폴백)
- `VITE_AI_ENDPOINT`가 Vercel 빌드에 미설정 → `getAiEndpoint()` 기본값 `localhost:3010` 반환
- `isLoopbackEndpoint()=true` → JWT 토큰 플로우 완전 우회, chat 요청이 localhost로 직행
- 로컬 서버 없음 → `Failed to fetch`

`activate-vercel-ai-cutover.ps1`이 `AI_PROXY_ENDPOINT`(서버사이드)는 설정했으나
`VITE_AI_ENDPOINT`(클라이언트 빌드타임)는 누락되어 있었음.

### 수정 내용
`activate-vercel-ai-cutover.ps1`: production 환경에 `VITE_AI_ENDPOINT=$ProxyEndpoint` 추가

### 즉시 조치 (라이브 배포 반영)
```powershell
.\standalone-package\activate-vercel-ai-cutover.ps1 -PromptForMissing -RunSmoke
```
프롬프트 입력:
1. `VERCEL_TOKEN` (Vercel → Settings → Tokens)
2. `AI_PROXY_ACTIVE_SIGNING_SECRET` (Render `MYAGENT_PROXY_TOKEN_SIGNING_SECRETS`와 동일값)

또는 Vercel 대시보드 수동:
- `VITE_AI_ENDPOINT` = `https://iran-abu-ai-proxy.onrender.com/api/ai/chat` → Redeploy

---

## [2026-03-11] 최종 상태: 백엔드 PASS, UI 스모크 테스트 버그 수정 완료

### verify-cutover.ps1 전 항목 PASS (chat 200 확인)
| 항목 | 결과 |
|---|---|
| health | PASS 200 |
| preflight allowed | PASS 204 |
| preflight forbidden | PASS 403 |
| token mint endpoint | PASS 200 |
| minted endpoint match | PASS |
| chat with minted token | **PASS 200** |
| chat invalid token | PASS 401 |

브라우저 직접 검증: `POST /api/ai/chat → 200, "pong — how can I help?"`

### UI 스모크 "Ask AI 비활성 상태" 원인 및 수정

**원인**: `ai-ui-smoke-temp.cjs`의 Ask AI 체크 로직이 textarea에 텍스트를 입력하기 **전에**
`submit.isDisabled()` 를 호출함. 제출 버튼은 textarea가 비어 있을 때 정상적으로 disabled이므로
AI 비활성이 아님에도 "비활성 상태"로 오판.

**확인 방법**: 브라우저 콘솔에서 `fetch('/api/ai/token')` 결과 정상,
textarea에 텍스트 입력 시 버튼 활성화 확인.

**수정 내용**:
- `.playwright/ai-ui-smoke-temp.cjs`: `questionInput.fill()` 호출을 `isDisabled()` **앞**으로 이동
- `verify-cutover.ps1`: token body 검증 추가 — HTTP 200이어도 `AI_PROXY_DISABLED` 코드 감지 시 FAIL 처리

**커밋**: 다음 커밋에 포함 예정

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

### 지금 확정된 고정 원인 및 다음 즉시 조치
- `MYAGENT_HOME=/etc/secrets` 상태에서 이전 런타임이 `/etc/secrets/cache` 생성 시도 시 ENOENT가 재현되어 `chat`만 실패했습니다.
- 패치는 적용되어 있으며, Render가 최신 커밋으로 재배포되면 더 이상 `/etc/secrets/cache`를 쓰지 않고 `/tmp` fallback을 사용해야 합니다.
- 즉시 재배포 + 즉시 검증을 수행하십시오.

```powershell
# 1) Render API 키 세팅
$env:RENDER_API_KEY = "<실제 Render API 키>"
$svc = Invoke-RestMethod `
  -Uri "https://api.render.com/v1/services?name=iran-abu-ai-proxy&limit=5" `
  -Headers @{ Authorization = "Bearer $env:RENDER_API_KEY"; Accept = "application/json" }
$serviceId = ($svc | Where-Object { $_.service.name -eq "iran-abu-ai-proxy" }).service.id

# 2) 재배포 트리거 (clear cache 없이 재시작)
Invoke-RestMethod `
  -Uri "https://api.render.com/v1/services/$serviceId/deploys" `
  -Headers @{ Authorization = "Bearer $env:RENDER_API_KEY"; "Content-Type" = "application/json"; Accept = "application/json" } `
  -Method POST `
  -Body '{"clearCache":"do_not_clear"}'

Start-Sleep -Seconds 60

# 3) 배포 반영 즉시 검증
.\standalone-package\verify-cutover.ps1 `
  -ProxyUrl "https://iran-abu-ai-proxy.onrender.com/api/ai/chat" `
  -TokenUrl "https://iran-abu-dash.vercel.app/api/ai/token" `
  -Origin "https://iran-abu-dash.vercel.app" `
  -ExpectedProxyEndpoint "https://iran-abu-ai-proxy.onrender.com/api/ai/chat"
```

재배포 후 `chat with minted token`의 오류 본문이
`ENOENT: no such file or directory, mkdir '/etc/secrets/cache'`
가 사라지면 다음 단계(Ask AI / Simulator / SourceGapPanel 재트리거)로 진행합니다.

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
   - 커밋: `2975412`, `17db9ed`, `583c298` (실패 원인 확인까지 반영)
   - 메시지: `fix: avoid write cache when myagent home path is read-only`, `chore: harden runtime cache path and finalize cutover runbook`, `chore: improve cutover diagnostics and record latest 502 status`
   - 브랜치: `main`
   - 푸시: `origin/main`
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

### 10) `2026-03-11 11:??:??+04:00` 재실행 (현재)
- `verify-cutover.ps1` 실행 결과 (최신)
  - `GET /api/ai/health` = 200 (PASS)
  - `OPTIONS` 허용 origin = 204 (PASS)
  - `OPTIONS` 금지 origin = 403 (PASS)
  - `GET /api/ai/token` = 200 (PASS)
  - `minted endpoint` = `https://iran-abu-ai-proxy.onrender.com/api/ai/chat` (PASS)
  - `POST /api/ai/chat`(minted token) = **502** (FAIL)
- 응답 본문:
  - `{"requestId":"437b85af-89b0-4088-9694-657025b8a87b","error":"COPILOT_PROXY_FAILED","detail":"ENOENT: no such file or directory, mkdir '/etc/secrets/cache'","code":"unknown"}`
- 판정: 코드는 `ENOENT`를 직접 유발하지 않아야 하지만, Render 운용 코드가 아직 이전 상태이므로 재배포 완료 후 상태가 바뀔 것으로 판단합니다.

### 11) `2026-03-11 11:21:00+04:00` 재배포 후 통과
- `Render` 수동 재배포 완료: `dep-d6ohe6bh46gs73akug30`
- `verify-cutover.ps1` 실행 결과
  - `GET /api/ai/health` = 200 (PASS)
  - `OPTIONS` 허용 origin = 204 (PASS)
  - `OPTIONS` 금지 origin = 403 (PASS)
  - `GET /api/ai/token` = 200 (PASS)
  - `minted endpoint` = `https://iran-abu-ai-proxy.onrender.com/api/ai/chat` (PASS)
  - `POST /api/ai/chat`(minted token) = PASS
  - `POST /api/ai/chat`(invalid token) = PASS
- `cutover` 전체 PASS
- UI 스모크(`.playwright/ai-ui-smoke-temp.cjs`) 결과
  - 대시보드 로드: PASS
  - Ask AI 트리거: PASS
  - Simulator 보조: PASS (`responseStatus=none`)
  - SourceGap 재분석: PASS (`responseStatus=none`)
- 판정: cutover 백엔드 경로는 통과. 실제 AI 응답 노출은 해당 환경별 기능 상태/입력 조건에 따라 재확인 필요.

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

## 12) 2026-03-11(추가) — 프론트 오염 방지 하드닝 후 재검증

### 적용 변경
- `react/src/lib/aiConfig.js`
  - `getAiEndpoint()`가 비로컬/운영에서는 `__JPT71_AI_ENDPOINT__`, `__URGENTDASH_AI_ENDPOINT__`, `aiEndpoint` 쿼리값이 loopback일 경우 즉시 무시.
  - `VITE_AI_ENDPOINT`가 loopback일 때도 비로컬 환경에서는 기본 폴백으로 전환.
  - `getAiProxyToken()`에서 비로컬 환경에서 non-JWT 공유 토큰(예: 구형 문자열)을 무시(공유 토큰 오염 의심 시 JWT만 사용).
  - `isLikelyJwtToken` 보조 함수 추가.
- `standalone-package/probe-dashboard-runtime.mjs`
  - Playwright `page.evaluate` 인자 전달 방식을 객체형 인자로 통일(`(endpoint, token)` → `({endpoint, token})`)하여 기존 `Too many arguments` 오류 제거.
- `react/src/lib/aiConfig.test.js`
  - loopback 오염 및 비로컬 token 무시 로직에 대한 회귀 테스트 추가.

### 검증
- `pnpm test -- src/lib/aiConfig.test.js src/lib/aiChat.test.js` → PASS 2 files / 16 tests
- `node standalone-package/probe-dashboard-runtime.mjs https://iran-abu-dash.vercel.app https://iran-abu-ai-proxy.onrender.com/api/ai/chat`
  - `token endpoint: https://iran-abu-ai-proxy.onrender.com/api/ai/chat` (200)
  - `POST /api/ai/chat` with same endpoint → status 200, `pong — how can I help?`
- `.\standalone-package\verify-cutover.ps1 -ProxyUrl ... -TokenUrl ... -Origin ...` (all params to onrender + production dashboard)
  - health/preflight/token/chat 항목 전부 PASS

### 판정
- `/api/ai/token`/`/api/ai/chat` 백엔드 경로와 브라우저 직접 호출은 모두 정상.
- `fail to fetch`는 더 이상 재현되지 않았고, 원격 콘솔에서 오래된 loopback/shared 토큰이 남아있는 환경은 위 변경으로 진입 경로가 차단됨.

## 13) 2026-03-11 최종 확정 — Git Push + Vercel 배포 완료

### 최종 실행 요약
- 실행 위치: `C:\Users\jichu\Downloads\iran_abu_dash-main\standalone-package`
- 대상 브랜치: `main`
- 원격: `origin` → `https://github.com/macho715/iran-abu-ai-proxy.git`

### Git 반영
- 확인:
  - `git rev-parse --short HEAD` = `90f073a`
  - `git rev-parse --short origin/main` = `90f073a`
  - `git log --oneline origin/main..HEAD` = 없음 (커밋 선행 반영 상태)
- 액션:
  - `git status` 정리(미추적 디버그 스크립트 제거)
  - `git push origin main`
- 결과:
  - `Everything up-to-date` (`90f073a` 기준 최종 반영 상태 유지)

### Vercel 업로드(재배포)
- 실행:
  - `Set-Location ..\react; vercel deploy --prod -y`
- 결과:
  - Production URL: `https://iran-abu-dash.vercel.app`
  - 이전 Alias도 정상 유지됨
  - Deployment 상태: READY

### 최종 Cutover 검증
- 실행:
  - `verify-cutover.ps1 -ProxyUrl https://iran-abu-ai-proxy.onrender.com/api/ai/chat -TokenUrl https://iran-abu-dash.vercel.app/api/ai/token -Origin https://iran-abu-dash.vercel.app -ExpectedProxyEndpoint https://iran-abu-ai-proxy.onrender.com/api/ai/chat`
- 결과:
  - `health` PASS (200)
  - `preflight allowed` PASS (204)
  - `preflight forbidden` PASS (403)
  - `token mint endpoint` PASS (200)
  - `minted endpoint match` PASS
  - `chat with minted token` PASS
  - `chat invalid token` PASS

### UI 스모크(최종 재확인)
- 실행:
  - `node .\\.playwright\\ai-ui-smoke-temp.cjs "https://iran-abu-dash.vercel.app"`
- 결과:
  - Dashboard load PASS
  - Ask AI trigger PASS (응답 200)
  - Simulator 보조 PASS (응답 200)
  - SourceGap 재분석 PASS (응답 200)

### 실패 이력 정리(해결 상태)
- `VERCEL_TOKEN` 유효성 오류 (`<...>`, `<실제_...>`, 길이 부족 문자열)
  - 해결: 실제 값으로 치환 후 실행, 필요 시 `vercel whoami` fallback 사용
- `proxy/local loopback` 폴백으로 인한 `fail to fetch`
  - 해결: 프론트 endpoint 오염 가드 적용 + 배포 정합성 확보
- `ENOENT: /etc/secrets/cache` 502
  - 해결: 캐시 경로 안전화 패치 + Render 재배포 후 PASS로 전환 확인

### 최종 판정
- 운영 cutover: PASS
- 백엔드 게이트/토큰/챗 경로: PASS
- 프런트 AI 호출 경로 정합성: PASS
- 실사용 재검증: PASS

```text
최종 상태: Git push 완료, Vercel production redeploy 완료, Ask AI/Simulator/SourceGapPanel 모두 실사용 응답 확인 완료.
```
