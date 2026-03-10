# MyAgent Copilot Standalone Package

이 폴더는 `myagent-proxy`를 OpenClaw 앱/게이트웨이/CLI와 분리해 별도 프로젝트처럼 실행하기 위한 최소 패키지입니다.

실운영 기준 권장 구조는 `Vercel 대시보드 + 별도 HTTPS 프록시 서버`입니다. 이 패키지 자체를 Vercel에 올리는 방식은 권장하지 않습니다.

## 이 패키지가 하는 일

- `POST /api/ai/chat`
- `GET /api/ai/health`
- GitHub device login 기반 Copilot 인증 저장
- Copilot runtime token 교환
- DLP, 라우팅 게이트, CORS, 토큰 인증

## 이 패키지가 아직 하지 않는 일

- OpenClaw 전체 기능 복제
- 로컬 LLM runner 포함
- 멀티 에이전트/채널/세션 시스템

## 빠른 시작

```bash
pnpm install
pnpm login
pnpm dev
```

기본 서버:

- `http://127.0.0.1:3010`

실운영 문서:

- `OPERATIONS.md`
- `deploy/systemd/myagent-copilot-standalone.service`
- `deploy/caddy/Caddyfile`
- `deploy/nginx/api.your-domain.com.conf`
- `deploy/vercel/runtime-config.example.html`

로컬 기본 허용 origin:

- `http://127.0.0.1:5173`
- `http://localhost:5173`
- `http://127.0.0.1:4173`
- `http://localhost:4173`
- `http://127.0.0.1:18789`

## 설치 후 첫 실행 순서

### 1) 의존성 설치

```bash
pnpm install
```

### 2) GitHub Copilot 로그인

```bash
pnpm login
```

실행 중 출력되는:

- verification URL
- user code

를 GitHub에 입력하면 토큰이 `~/.myagent-copilot/auth-profiles.json`에 저장됩니다.

### 3) 런타임 토큰 확인

```bash
pnpm token
pnpm usage
```

### 4) 프록시 기동

로컬:

```bash
pnpm serve:local
```

퍼블릭 canonical:

```bash
MYAGENT_PROXY_HOST="127.0.0.1" \
MYAGENT_PROXY_REQUIRE_PUBLIC_GUARDS="1" \
MYAGENT_PROXY_AUTH_MODE="jwt" \
MYAGENT_PROXY_TOKEN_SIGNING_SECRETS="replace-with-secret-a,replace-with-secret-b" \
MYAGENT_PROXY_TOKEN_ISSUER="iran-abu-dash" \
MYAGENT_PROXY_TOKEN_AUDIENCE="myagent-copilot-standalone" \
MYAGENT_PROXY_CORS_ORIGINS="https://iran-abu-dash.vercel.app" \
MYAGENT_PROXY_ALLOW_SANITIZED_TO_COPILOT="0" \
MYAGENT_GITHUB_TOKEN="ghu_xxx" \
pnpm serve:public
```

권장 운영 방식:

- 프록시는 VM/Fly/Render에서 상시 실행
- 공개 HTTPS는 Caddy/Nginx가 받고 내부적으로 `127.0.0.1:3010`으로 프록시
- 브라우저는 Vercel 대시보드에서 `https://api.your-domain.com/api/ai/chat`만 호출

## Windows 배치 파일

빌드 후에는 아래 `.bat`만으로 실행할 수 있습니다.

```bat
build.bat
login.bat
token.bat
usage.bat
health.bat
serve-local.bat
serve-public.bat
export-release.bat
```

권장 순서:

1. `build.bat`
2. `login.bat`
3. `token.bat`
4. `serve-local.bat` 또는 `serve-public.bat`

퍼블릭 실행 전:

```bat
set MYAGENT_PROXY_HOST=127.0.0.1
set MYAGENT_PROXY_REQUIRE_PUBLIC_GUARDS=1
set MYAGENT_PROXY_AUTH_MODE=jwt
set MYAGENT_PROXY_TOKEN_SIGNING_SECRETS=replace-with-secret-a,replace-with-secret-b
set MYAGENT_PROXY_TOKEN_ISSUER=iran-abu-dash
set MYAGENT_PROXY_TOKEN_AUDIENCE=myagent-copilot-standalone
set MYAGENT_PROXY_CORS_ORIGINS=https://iran-abu-dash.vercel.app
set MYAGENT_PROXY_ALLOW_SANITIZED_TO_COPILOT=0
set MYAGENT_GITHUB_TOKEN=ghu_xxx
serve-public.bat
```

배포 zip 생성:

```bat
export-release.bat
```

산출물:

- `release/myagent-copilot-standalone-v0.1.0.zip`

## 주요 명령

```bash
pnpm login
pnpm token
pnpm usage
pnpm dev
pnpm serve:local
pnpm serve:public
pnpm build
pnpm export:zip
pnpm serve
```

빌드 후 dist 직접 실행:

```bash
node dist/cli.js serve --host 127.0.0.1 --port 3010
node dist/cli.js token --json
node dist/cli.js usage --json
```

릴리스 zip 생성:

```bash
pnpm export:zip
```

## API 엔드포인트

- `GET /api/ai/health`
- `POST /api/ai/chat`

요청 예시:

```json
{
  "model": "github-copilot/gpt-5-mini",
  "sensitivity": "internal",
  "messages": [
    { "role": "user", "content": "요약해줘" }
  ]
}
```

퍼블릭 모드에서는 다음 중 하나가 추가로 필요합니다.

- canonical: Vercel `GET /api/ai/token`이 발급한 short-lived signed token
- breakglass/local: `x-ai-proxy-token: <shared-secret>` 또는 `Authorization: Bearer <shared-secret>`

## 환경변수

- `MYAGENT_HOME`
- `MYAGENT_PROXY_HOST`
- `MYAGENT_PROXY_PORT`
- `MYAGENT_PROXY_CORS_ORIGINS`
- `MYAGENT_PROXY_AUTH_MODE`
- `MYAGENT_PROXY_AUTH_TOKEN`
- `MYAGENT_PROXY_TOKEN_SIGNING_SECRETS`
- `MYAGENT_PROXY_TOKEN_ISSUER`
- `MYAGENT_PROXY_TOKEN_AUDIENCE`
- `MYAGENT_PROXY_ALLOW_SANITIZED_TO_COPILOT`
- `MYAGENT_PROXY_REQUIRE_PUBLIC_GUARDS`
- `MYAGENT_PROXY_ALLOW_INSECURE_PUBLIC`
- `MYAGENT_GITHUB_TOKEN`
- `COPILOT_GITHUB_TOKEN`
- `GH_TOKEN`
- `GITHUB_TOKEN`

퍼블릭 운영 보호 규칙:

- `MYAGENT_PROXY_REQUIRE_PUBLIC_GUARDS=1`이면 auth mode에 맞는 인증 설정과 명시적 CORS origin 없이 기동하지 않습니다.
- `MYAGENT_PROXY_HOST=0.0.0.0`로 공개 바인드하는데 보호 설정이 없으면 기동하지 않습니다.
- 긴급 디버깅이 아니면 `MYAGENT_PROXY_ALLOW_INSECURE_PUBLIC=1`은 쓰지 마십시오.

Render 같은 관리형 PaaS에서는 interactive `pnpm login` 대신 `MYAGENT_GITHUB_TOKEN`을 운영 예외로 사용할 수 있습니다. VM 장기 운영은 standalone auth store를 기본값으로 유지합니다.

## 인증 우선순위

1. 환경변수 토큰
2. `~/.myagent-copilot/auth-profiles.json`
3. 기존 OpenClaw auth store 호환 fallback
   - `~/.openclaw/agents/main/agent/auth-profiles.json`
   - `~/.openclaw/auth-profiles.json`

## 모델/엔드포인트

- 기본 모델: `github-copilot/gpt-5-mini`
- 기본 엔드포인트: `responses`
- `gpt-4o`는 `chat/completions`로 라우팅

v1 목표는 안정적인 standalone 분리입니다. 모델 카탈로그 전체 복제는 의도적으로 제외했습니다.

## 파일 구조

```text
standalone-package/
  OPERATIONS.md
  deploy/
  package.json
  tsconfig.json
  src/
    cli.ts
    server.ts
    proxy-middleware.ts
    copilot-bridge.ts
    device-flow.ts
    auth-store.ts
    runtime-token.ts
    dlp.ts
    routing.ts
    ops-log.ts
    state.ts
```
