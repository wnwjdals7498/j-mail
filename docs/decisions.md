# j-mail 설계 결정

j-mail 최소 구현에 필요한 설계 결정을 정리한다. 제품군 공통 기준은 `j-groupware/docs/architecture.md`를 따르고, 이 문서는 그 위에서 j-mail이 정한 내용만 적는다. 각 결정은 PMT project `8144d327-0a0f-4c2e-94c2-687028657332`에 같은 번호의 `결정 N` 레코드로 기록되어 있다.

결정일: 2026-10-07

2026-10-07 갱신: j-groupware 결정 20(서비스 가입 모델·서비스별 DB)과 결정 22(화면은 j-groupware에서만 표시)에 따라 다시 정리했다. 바뀐 내용은 다음과 같다.
- 결정 2: Mailpit 웹 UI + gateway `auth_request` 방식을 j-mail 받은편지함 API 방식으로 바꿨다.
- 결정 5: 웹 UI 주소를 뺐다.
- 결정 8: DB를 추가했다.
- 결정 9: 새로 만들었다.
- Item: E3을 바꾸고 E4를 없앴다.

PMT에서는 결정 0·2·5·8을 supersede하고 결정 9를 만들어야 한다(대기 중).

## 0. 범위

- **범위(architecture.md §4):**
  - 테스트 전용 메일 서버다.
  - 외부 발신을 차단하고, hosts 수정으로 임시 도메인(`*.jgw.test`)을 쓴다.
  - 캡처형 SMTP를 써서 직접 만들 부분을 최소화한다.
  - 받은편지함은 API로만 제공하고, 화면은 j-groupware "메일" 메뉴가 그린다.
- **완료 기준:** 고객 VM 내부에서 보낸 메일을 j-groupware 메일 화면에서 확인하고, 외부 도메인 발신 시도는 거부된다.
- **배치:**
  - 고객 VM(tenant plane) 안에서 동작한다.
  - API는 내부 포트로만 열고 j-groupware 서버가 중계한다(j-groupware 결정 17).
  - j-mail에 가입한 고객에게만 설치한다(architecture.md 3장 서비스 가입 모델).

## 1. 메일 서버

### 결정 1. 메일 서버 구성
- **결정:**
  - Mailpit 단독으로 SMTP 수신·보관·REST API를 제공한다.
  - 외부 relay는 설정하지 않는다.
  - Mailpit 웹 UI와 REST API는 loopback에만 bind하고 gateway에 노출하지 않는다.
  - Mailpit 이미지는 정확한 버전으로 고정한다. 옵션명·API 경로·지원 버전은 공식 문서와 저장소로 확인한다.
- **이유:** architecture.md 기준안(캡처형 SMTP)과 같고 직접 만들 부분이 가장 적다. relay가 없으므로 외부 발신 경로 자체가 없다.

### 결정 3. 외부 도메인 발신 거부
- **결정:**
  - Mailpit 허용 수신자 정규식으로 허용 tenant의 `<tenant>.jgw.test` 주소만 받고, 나머지는 SMTP 단계에서 거부한다.
  - relay는 설정하지 않는다.
  - VM 방화벽에서 외부 25/465/587 egress를 막는다.
- **이유:** 설정 하나가 잘못되어도 다른 방어선이 남는다. 완료 기준의 "거부"를 SMTP 응답으로 직접 증명한다.

### 결정 5. 임시 도메인·주소 규칙
- **결정:**
  - 메일 주소는 `<username>@<tenant>.jgw.test`다.
  - 허용 수신자 정규식은 허용 tenant 목록에서 만든다.
  - 웹 UI용 서브도메인(`mail.<tenant>.jgw.test`)은 두지 않는다(j-groupware 결정 22).
- **이유:** tenant 경계가 주소에 드러나므로 받은편지함 API가 수신자 도메인으로 tenant를 걸러낼 수 있다(결정 2).

### 결정 7. SMTP 발신 접근 제어
- **결정:**
  - Mailpit SMTP는 VM 내부(loopback) 주소에만 bind하고 방화벽에서 열지 않는다.
  - 각 서비스는 `SMTP_HOST`/`SMTP_PORT` 설정만 가진다.
  - SMTP AUTH·STARTTLS는 backlog다.
- **이유:** 테스트 전용 서버라 비밀값을 늘리지 않는다. 외부 접근 경로가 없다.

## 2. 받은편지함 API와 권한

### 결정 2. 받은편지함 API와 접근 제어
2026-10-07 j-groupware 결정 22에 따라 다시 썼다. 이전 내용은 "j-mail 서버가 자체 로그인으로 `mail:read` 세션을 발급하고, gateway `auth_request`로 Mailpit 웹 UI를 연다"였다.
- **결정:**
  - j-mail 서버(`apps/server`)가 Mailpit REST API를 감싸 받은편지함 API를 제공한다.
    - 목록 API: 수신자, 발신자, 제목, 시각, 페이지
    - 상세 API: 헤더, 텍스트·HTML 본문
    - 경로와 필드명은 `packages/contracts`에서 정한다.
  - 호출은 j-groupware 서버만 한다. 요청에는 `Authorization: Bearer <j-auth access token>`이 붙어 있다.
  - j-mail은 j-auth 결정 19 기준(RS256, iss, `azp=j-auth`, aud에 `j-mail`, `tenant` claim, 허용 tenant)으로 토큰을 검증하고 `mail:read`를 검사한다. tenant는 토큰 claim에서만 정한다.
  - **tenant 격리:** 목록과 상세 모두 수신자 주소가 `@<그 tenant>.jgw.test`인 메일만 돌려준다. 다른 tenant의 메일 id로 상세를 요청하면 404다.
  - 같은 tenant 안에서는 메일 전체를 공유한다. 사용자별 필터는 backlog다.
  - 자체 로그인 화면, 세션 쿠키, `auth_request` 확인 엔드포인트는 만들지 않는다.
  - 응답 구분: 토큰 무효 401, `mail:read` 없음 403, 없음(다른 tenant 포함) 404, Mailpit·j-auth JWKS 장애 503.
  - 토큰 갱신은 j-groupware가 한다(j-groupware 결정 2).
- **이유:** 화면은 j-groupware에 있고(결정 22), j-customer-auth-db·j-approval과 같은 "Bearer 검증 내부 API" 형태라 규칙이 하나다.

### 결정 6. 메일 권한 이름과 위치
- **결정:**
  - 고객 realm의 role 전용 client `j-mail`에 기능 role `mail:read`를 둔다(j-auth 결정 16·23).
  - j-mail에 가입한 고객의 `tenant:admin` 묶음과 회원 관리 API 부여 가능 role에 들어간다.
  - `j-auth` client audience mapper에 aud `j-mail`이 있다.
  - 가입하지 않은 고객 realm에는 client·role·aud가 모두 없다(j-auth 결정 25).
- **이유:** j-customer-auth-db 결정 4와 같은 방식이다. 권한 있는 하위 회원과 없는 회원을 모두 테스트할 수 있다.

### 결정 4. j-messenger mail 인증 모드
- **결정:** j-messenger는 `AUTH_MODE=j-auth`를 쓴다. Mailpit은 메일 계정·IMAP이 없어 mail 인증을 제공하지 않는다. 그래서 mail 모드는 코드 변경 없이 그대로 두고, 실제 MTA 기반 연결은 backlog로 둔다.
- **이유:** j-groupware 결정 15에서 "j-mail 차례에 다시 정함"으로 보류한 항목이다. 결정 1과 맞고 j-messenger 변경 범위를 늘리지 않는다.

## 3. 데이터·검증·배포

### 결정 9. j-mail 전용 DB
- **결정:**
  - 서비스 가입 모델(architecture.md 3장, A안)에 따라 고객 VM PostgreSQL 인스턴스에 database `jgw_mail`과 전용 계정을 둔다.
  - 드라이버는 `pg`, 마이그레이션은 node-pg-migrate SQL 파일 방식이고, 버전은 정확히 고정한다.
  - 최소 구현에서 j-mail 서버가 저장할 상태는 없다. 메일 원본은 Mailpit이 보관한다. 그래서 database·계정·마이그레이션 골격(빈 baseline)만 두고 기동할 때 접속을 확인한다.
  - 사용자별 필터, 보존 정책, 열람 기록이 생기면 이 database에 둔다.
  - Mailpit의 내부 저장소는 외부 제품의 저장 방식이라 이 원칙에서 예외로 둔다. 버전 고정 Compose 볼륨에 둔다.
- **이유:** 모든 서비스가 같은 "API + DB" 형태를 갖추어야 가입·해지·백업 절차가 서비스마다 같아진다(j-groupware 결정 20).

### 결정 8. 저장소·기동·테스트
- **결정:**
  - j-messenger에서 workspaces·도구·scripts를 복사해 줄이고, 버전을 같게 고정한다(`apps/server`, `packages/contracts`).
  - Mailpit은 버전을 고정한 Docker Compose로, j-mail 서버는 systemd로 실행한다.
  - Vitest로 실제 Mailpit·j-auth·Keycloak·PostgreSQL을 대상으로 API 시나리오를 검증한다. 화면 e2e는 j-groupware G14에서 한다.
  - 로컬에서 완료한 뒤 고객 VM에서 다시 검증한다.
  - 로컬 HTTPS, 비표준 기본 포트 + 설정 변경, 3001 미사용.
- **이유:** j-auth·j-groupware 결정 12, j-customer-auth-db 결정 10과 같은 원칙이다.

## 4. 작업 구성

### 결정 0. PMT 계층과 Item 구성
- PMT 계층은 environment `j-groupware-suite` → repository `j-mail`(`d26e1aab-c7b2-4afb-9644-5352c337e224`) → project `j-mail`(`8144d327-0a0f-4c2e-94c2-687028657332`)이다.
- Work W1 "j-mail 최소 구현"의 완료 기준은 0장 완료 기준과 같다. 사용자가 제안 구성을 승인했다.
- 2026-10-07 갱신(PMT supersede 대기):
  - E3을 받은편지함 API로 바꿨다.
  - E4(gateway 조각)를 폐기했다.
  - E7 선행에 j-groupware G14·G18을 더했다.
  - E6은 반영이 확인되었다.

| 순서 | Item | 완료 기준 요약 | 선행 |
| --- | --- | --- | --- |
| E1 | 저장소 골격 | workspaces(apps/server, packages/contracts), j-messenger 도구 복사·버전 고정, `jgw_mail` database·전용 계정·마이그레이션 골격, Mailpit Compose(SMTP·API·UI loopback), 로컬 HTTPS·비표준 포트, 비밀값은 Git 제외 env | j-auth I4 |
| E2 | 외부 발신 차단 | 허용 수신자 정규식, relay 미설정, 외부·다른 tenant 수신자 SMTP 거부, 공식 근거 기록 | E1 |
| E6 | 변경 요청 | 5장 요청을 j-auth·j-groupware에 전달하고 등록 확인 (반영 확인됨, PMT finish 대기) | - |
| E3 | 받은편지함 API·권한 게이트 | contracts(목록·상세 DTO, 오류 코드, `npm pack` 가능), j-auth contracts vendor, Bearer 검증(aud `j-mail`), `mail:read`, 수신자 도메인 tenant 필터, Mailpit API 래핑, 401·403·404·503 구분 | E1, j-auth I2·I4 |
| ~~E4~~ | ~~gateway 조각~~ | 폐기(j-groupware 결정 17·22). gateway에 노출하지 않음 | - |
| E5 | 완료 기준 테스트 | 실제 의존성 Vitest: 내부 메일 발송 → API 목록·상세 확인, 외부 거부, tenant 격리, 401·403, j-auth 장애 503 | E2, E3 |
| E7 | 고객 VM 검증 | VM에서 `deploy/provision-service`로 database 생성, Compose·systemd·내부 포트, egress 차단, j-groupware 메일 화면에서 내부 메일 확인, 외부 거부, VM 대상 E5 통과 | E5, E6, j-groupware G10·G14·G18 |

backlog: 사용자별 받은편지함 필터, j-messenger mail 모드 연결(실제 MTA), SMTP AUTH·STARTTLS, OIDC 전환, 메일 보존 정책.

## 5. 다른 서비스에 넘길 변경 요청

2026-10-07 모두 반영되었다.

1. **j-auth:** 고객 realm에 role 전용 client `j-mail`과 `mail:read` 추가, `tenant:admin` 묶음에 포함(결정 16 방식). → 반영됨: j-auth 결정 23. 가입 연동은 j-auth 결정 25.
2. **j-auth:** `j-auth` client audience mapper에 aud `j-mail` 추가(결정 19). → 반영됨: j-auth 결정 23.
3. **j-auth:** 회원 관리 API(결정 14)의 부여 가능 role에 `mail:read` 추가. 테스트 계정에 `mail:read` 보유·미보유 하위 회원 포함. → 반영됨: j-auth 결정 23(`a-mail`, `a-member`).
4. **j-groupware:**
   - 원래 요청: 권한 표에 메일 메뉴, 회원 관리 화면에서 `mail:read` 부여, gateway include에 `mail.` 조각 추가.
   - 반영됨: j-groupware 결정 19.
   - 이후 결정 22로 "j-groupware 메일 화면(G14) + j-mail 받은편지함 API"로 바뀌었고, `mail.` 조각은 필요 없어졌다.
