# j-mail 설계 결정

j-mail만의 설계 결정을 적는다. 제품군 공통 결정은 [`j-groupware/docs/architecture.md`](https://github.com/wnwjdals7498/j-groupware/blob/main/docs/architecture.md)(이하 architecture.md)의 S 번호를 따르고 여기서는 링크만 한다. PMT는 통합 project `j-groupware-suite`의 분류 `j-mail`에 같은 번호로 기록한다(S16).

정리일: 2026-10-07. 통합 정리에서 결정 번호를 다시 매겼다. 이전 번호는 끝의 대응 표를 본다.

## 0. 범위

- **범위:**
  - 테스트 전용 메일 서버다.
  - 외부 발신을 차단하고, 임시 도메인 `*.jgw.test`를 hosts로 쓴다.
  - 캡처형 SMTP(Mailpit)로 직접 만들 부분을 최소화한다.
  - 받은편지함은 API로만 제공하고, 화면은 j-groupware "메일" 메뉴다(j-groupware 결정 11).
- **완료 기준:** 고객 서버 내부에서 보낸 메일을 j-groupware 메일 화면에서 확인하고, 외부 도메인 발신은 거부된다.
- **배치:** 고객 서버의 선택 서비스다. API는 내부 포트로만 열고 j-groupware가 중계한다.
- **관련 공통 결정:** S2(서비스·DB), S3(권한), S4(토큰 전달), S5(화면), S12~S14.

## 1. 메일 서버

### 결정 1. Mailpit 구성
- **결정:**
  - Mailpit 단독으로 SMTP 수신·보관·REST API를 제공한다. 외부 relay는 설정하지 않는다.
  - Mailpit 웹 UI와 REST API는 loopback에만 bind하고 gateway에 노출하지 않는다.
  - Mailpit 이미지는 정확한 버전으로 고정한다. 옵션명·API 경로는 공식 문서로 확인한다.
- **이유:** 직접 만들 부분이 가장 적다. relay가 없으므로 외부 발신 경로 자체가 없다.

### 결정 2. 외부 도메인 발신 거부
- **결정:**
  - Mailpit 허용 수신자 정규식으로 허용 tenant의 `<tenant>.jgw.test` 주소만 받고, 나머지는 SMTP 단계에서 거부한다.
  - 고객 서버 방화벽에서 외부 25/465/587 egress를 막는다.
- **이유:** 설정 하나가 잘못되어도 다른 방어선이 남는다. "거부"를 SMTP 응답으로 직접 증명한다.

### 결정 3. 주소 규칙
- **결정:**
  - 메일 주소는 `<username>@<tenant>.jgw.test`다.
  - 허용 수신자 정규식은 허용 tenant 목록에서 만든다.
  - 웹 UI용 서브도메인은 두지 않는다(S5).
- **이유:** tenant 경계가 주소에 드러나서 받은편지함 API가 수신자 도메인으로 tenant를 걸러낼 수 있다.

### 결정 4. SMTP 발신 접근
- **결정:**
  - Mailpit SMTP는 loopback에만 bind한다.
  - 각 서비스는 `SMTP_HOST`/`SMTP_PORT` 설정만 가진다.
  - SMTP AUTH·STARTTLS는 backlog다.
- **이유:** 테스트 전용 서버라 비밀값을 늘리지 않는다.

## 2. 받은편지함 API와 권한

### 결정 5. 받은편지함 API
- **결정:**
  - j-mail 서버가 Mailpit REST API를 감싸 목록(수신자·발신자·제목·시각, 페이지)과 상세(헤더, 텍스트·HTML 본문) API를 제공한다. 경로와 필드명은 contracts에서 정한다.
  - j-groupware가 전달한 Bearer를 j-auth 기준으로 검증하고(aud `j-mail`, S4) `mail:read`를 검사한다.
  - **tenant 격리:** 수신자 주소가 `@<그 tenant>.jgw.test`인 메일만 돌려준다. 다른 tenant의 메일 id는 404다.
  - 같은 tenant 안에서는 메일 전체를 공유한다. 사용자별 필터는 backlog다.
  - 응답 구분: 401, 403, 404, 503(Mailpit·JWKS 장애).
- **이유:** 다른 서비스와 같은 "Bearer 검증 내부 API" 형태다.

### 결정 6. 메일 권한
- **결정:** 기능 role `mail:read`는 role client `j-mail`에 있다(S3 카탈로그). 가입하지 않은 고객 realm에는 client·role·aud가 없다.
- **이유:** 권한 있는 회원과 없는 회원을 모두 테스트할 수 있다.

### 결정 7. j-messenger mail 인증 모드
- **결정:** Mailpit은 메일 계정·IMAP이 없어 mail 인증을 제공하지 않는다. j-messenger의 mail 모드는 코드 변경 없이 두고, 실제 MTA 기반 연결은 backlog다.
- **이유:** j-messenger 변경 범위를 늘리지 않는다.

### 결정 10. 새 메일 알림 송신
- **결정:**
  - Mailpit 새 메일 webhook(옵션명은 공식 문서로 확인)을 j-mail 서버 loopback 엔드포인트로 받는다.
  - 수신자 주소가 `<username>@<tenant>.jgw.test`인 메일마다 j-groupware 알림 센터(S17)에 `mail.new`를 보낸다. 받는 사람은 `usernames: [username]`이다. 그 회원에게 `mail:read`가 있을 때만 j-groupware가 보여 준다.
  - 알림 기록은 `jgw_mail`의 `notification_outbox`에 두고 송신 루프가 재시도한다(`dedupKey` = Mailpit 메일 id). 이것이 `jgw_mail`의 첫 실제 사용처다.
- **이유:** 새 메일을 j-groupware 알림으로 알 수 있다.

## 3. 데이터·검증·배포

### 결정 8. j-mail DB
- **결정:**
  - 고객 서버 PostgreSQL에 database `jgw_mail`과 전용 계정을 둔다(S2).
  - 첫 사용처는 알림 outbox(결정 10)다. 사용자별 필터·보존 정책이 생기면 여기에 둔다.
  - Mailpit 내부 저장소는 외부 제품의 저장 방식이라 예외로 두고, 버전 고정 Compose 볼륨에 둔다.
- **이유:** 가입·해지·백업 절차를 모든 서비스에서 같게 한다(S2, 사용자).

### 결정 9. 저장소·기동·테스트
- **결정:**
  - S11 골격(`apps/server`, `packages/contracts`)을 쓰고, contracts는 레지스트리에 게시한다(S10).
  - Mailpit은 Compose로, j-mail 서버는 systemd로 실행한다.
  - Vitest로 실제 Mailpit·j-auth·Keycloak·PostgreSQL을 대상으로 시나리오를 검증한다. `mail:read` 회원은 테스트가 j-auth 회원 관리 API로 만들고 지운다(S12).
  - 화면 e2e는 j-groupware G14에서 한다.
- **이유:** 제품군 공통 원칙과 같다.

## 4. 작업 구성

PMT 통합 project 분류 `j-mail`.

| Item | 완료 기준 요약 | 선행 |
| --- | --- | --- |
| E1 저장소 골격 | S11 골격, `jgw_mail`·전용 계정·마이그레이션 골격, Mailpit Compose(SMTP·API·UI loopback), 로컬 HTTPS·포트, Git 제외 env | j-auth I4, X1 |
| E2 외부 발신 차단 | 허용 수신자 정규식, relay 미설정, 외부·다른 tenant 수신자 SMTP 거부, 공식 근거 기록 | E1 |
| E3 받은편지함 API·권한 게이트 | contracts(목록·상세, 오류 코드, 레지스트리 게시), `@j-auth/contracts` 설치, 결정 5 검증·tenant 필터·Mailpit 래핑 | E1, j-auth I2·I4 |
| E5 완료 기준 테스트 | 실제 의존성 Vitest: 내부 메일 발송 → API 목록·상세, 외부 거부, tenant 격리, 401·403, 503 | E2, E3, j-auth I6 |
| E7 고객 서버 검증 | `provision-service`로 설치·해지(Mailpit 중지·볼륨 백업), systemd·내부 포트, egress 차단, j-groupware 메일 화면 확인, VM 대상 E5 | E5, j-groupware G10·G14·G18 |
| E8 알림 송신 | 결정 10(Mailpit webhook, outbox, 재시도), 실제 j-groupware 알림 센터 대상 테스트 | E5, j-groupware G22 |
| E4 | 취소(Canceled): gateway 조각은 필요 없음 | - |
| E6 | 완료(Done): 변경 요청 반영 확인 | - |

backlog: 사용자별 받은편지함 필터, j-messenger mail 모드 연결(실제 MTA), SMTP AUTH·STARTTLS, 메일 보존 정책.

## 이전 번호 대응

| 새 | 이전 | 새 | 이전 |
| --- | --- | --- | --- |
| 1 | 1 | 6 | 6 |
| 2 | 3 | 7 | 4 |
| 3 | 5 | 8 | 9 |
| 4 | 7 | 9 | 8 |
| 5 | 2 | 10 | 새로 추가(알림 송신) |
| - | - | - | 0 → 4장 작업 구성, 5장 요청은 모두 반영되어 삭제 |
