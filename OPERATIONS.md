# Standalone Proxy Operations

이 패키지의 실운영 기준 구조는 아래입니다.

```text
사용자 브라우저
  -> https://iran-abu-dash.vercel.app
  -> https://api.your-domain.com/api/ai/chat

Vercel
  -> 대시보드 정적/Vite 배포

VM 또는 Render/Fly 인스턴스
  -> Caddy/Nginx HTTPS termination
  -> myagent-copilot-standalone (127.0.0.1:3010)
```

핵심 원칙:

- `standalone-package` 자체를 Vercel에 올리지 않는다.
- Vercel은 대시보드만 배포한다.
- 프록시는 별도 서버에서 상시 실행한다.
- 프록시는 가능하면 `127.0.0.1:3010`에만 바인드하고 Caddy/Nginx가 외부 HTTPS를 받는다.
- 퍼블릭 canonical 운영에서는 `MYAGENT_PROXY_REQUIRE_PUBLIC_GUARDS=1`, `MYAGENT_PROXY_AUTH_MODE=jwt`, `MYAGENT_PROXY_TOKEN_SIGNING_SECRETS`, `MYAGENT_PROXY_CORS_ORIGINS`를 함께 쓴다.

## 1. 서버 측 권장 절차

1. Node 22.12+와 pnpm을 설치한다.
2. 이 폴더를 서버에 복사하거나 release zip을 푼다.
3. `pnpm install --frozen-lockfile`
4. `pnpm build`
5. VM 장기 운영이면 `pnpm login`으로 Copilot device login을 1회 완료한다.
6. Render 같은 관리형 PaaS면 `MYAGENT_GITHUB_TOKEN`을 환경변수로 준비한다.
6. `/etc/myagent-copilot-standalone.env` 같은 환경파일을 둔다.
7. `deploy/systemd/myagent-copilot-standalone.service`를 설치한다.
8. `deploy/caddy/Caddyfile` 또는 `deploy/nginx/api.your-domain.com.conf`를 적용한다.

## 2. 권장 환경파일

```env
MYAGENT_HOME=/opt/myagent-copilot
MYAGENT_PROXY_HOST=127.0.0.1
MYAGENT_PROXY_PORT=3010
MYAGENT_PROXY_OPS_LOGS=1
MYAGENT_PROXY_ALLOW_SANITIZED_TO_COPILOT=0
MYAGENT_PROXY_REQUIRE_PUBLIC_GUARDS=1
MYAGENT_PROXY_ALLOW_INSECURE_PUBLIC=0
MYAGENT_PROXY_AUTH_MODE=jwt
MYAGENT_PROXY_TOKEN_SIGNING_SECRETS=replace-with-secret-a,replace-with-secret-b
MYAGENT_PROXY_TOKEN_ISSUER=iran-abu-dash
MYAGENT_PROXY_TOKEN_AUDIENCE=myagent-copilot-standalone
MYAGENT_PROXY_CORS_ORIGINS=https://iran-abu-dash.vercel.app
MYAGENT_GITHUB_TOKEN=ghu_xxx
```

운영 포인트:

- 프런트 origin은 실제 프로덕션 대시보드 URL만 넣는다.
- Vercel preview URL은 기본적으로 허용하지 않는 편이 안전하다.
- preview에서도 AI를 써야 하면 별도 preview 프록시 또는 임시 origin 추가를 사용한다.

## 3. Vercel 측 설정

대시보드는 Vercel에 배포하고, AI 호출은 `GET /api/ai/token` 단기 서명 토큰 mint route로 맞춘다.

필수 env:

- `AI_PROXY_ENABLED=1`
- `AI_PROXY_ENDPOINT=https://api.your-domain.com/api/ai/chat`
- `AI_PROXY_ACTIVE_SIGNING_SECRET=replace-with-secret-a`
- `AI_PROXY_TOKEN_ISSUER=iran-abu-dash`
- `AI_PROXY_TOKEN_AUDIENCE=myagent-copilot-standalone`
- `AI_PROXY_TOKEN_TTL_SECONDS=300`

프런트는 endpoint만 알고, 토큰은 localStorage나 bundle에 저장하지 않는다. preview는 기본적으로 `AI_PROXY_ENABLED=0`으로 두는 편이 안전하다.

## 4. 검증

서버에서:

```bash
node dist/cli.js health
curl https://api.your-domain.com/api/ai/health
```

브라우저 origin 검증:

1. Vercel `GET /api/ai/token` -> `200` 또는 preview disabled면 `403`
1. 허용 origin으로 `OPTIONS /api/ai/chat` -> `204`
2. 정상 signed token `POST /api/ai/chat` -> `200`
3. 잘못된 origin -> `403`
4. 만료/오서명 토큰 -> `401`
5. DLP 차단 payload -> `422`

## 5. 새 보호장치

이 패키지는 아래 조건이면 기본적으로 기동을 거부한다.

- `MYAGENT_PROXY_AUTH_MODE=shared`인데 `MYAGENT_PROXY_AUTH_TOKEN`이 비어 있음
- `MYAGENT_PROXY_REQUIRE_PUBLIC_GUARDS=1`인데 `MYAGENT_PROXY_CORS_ORIGINS`가 비어 있거나 로컬 기본 allowlist만 사용함
- `MYAGENT_PROXY_AUTH_MODE=jwt`인데 `MYAGENT_PROXY_TOKEN_SIGNING_SECRETS`가 비어 있음
- `MYAGENT_PROXY_HOST=0.0.0.0` 같은 공개 바인드인데 인증/CORS 보호가 빠져 있음

긴급 디버깅이 아니면 `MYAGENT_PROXY_ALLOW_INSECURE_PUBLIC=1`은 쓰지 않는다.
