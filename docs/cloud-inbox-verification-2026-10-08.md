# 받은편지함 E3 클라우드 구현·검증 (2026-10-08)

ML-10·11·12·13·31의 서버 계약을 구현했다. `@j-mail/contracts@0.1.0`은 승인된 loopback Verdaccio에만 게시했고 별도 소비자 설치·lock origin/version·실제 pack SHA512 동일성을 확인했다. 공개 npm 게시·운영 배포·외부 이메일 송신은 없다.

## API와 수신 근거

`GET /mail/messages?offset=0&limit=20`과 `GET /mail/messages/:id`는 `j-mail` 단일 audience, 정확한 issuer/tenant/azp, 유효 sid/회원 username과 `mail:read`가 필요하다. Bearer 외 cookie 인증을 거부한다. query tenant/source 추가나 잘못된 페이지/id는400, 무효401, 권한403, 없는/다른 tenant id404, Mailpit/JWKS 장애503이다. 명시되지 않은 native/send/relay API는 노출하지 않는다. 서버 HTTPS와 파일·자격 설정은 loopback/체크아웃 밖으로 제한한다.

Mailpit To/Cc/Bcc는 표시용 헤더다. pinned 1.31.4의 SMTP-only capture와 한 tenant production profile에서, Mailpit이 삽입한 **첫 Received의 마지막 SMTP 수신 marker**로 tenant를 확인한다. 위조 To/EHLO/뒤에 붙인 Received가 권한을 넓히지 않는다. 목록의 모든 후보를 readonly headers로 확인한 뒤 total/offset/limit를 계산한다. native detail GET이 Read를 바꾸므로 다른 tenant 단건은 headers만 읽고404다. UI·native ingest가 같은 저장소에 쓰는 배치는 이 신뢰 전제에 포함되지 않는다.

고정 loopback source, redirect 금지, 전체 upstream body16MiB/5초와 최대 후보1000/동시검사8을 적용한다. 후보가1000을 넘거나 snapshot/JSON이 불완전하면 잘린 성공 대신503이다. 표시 주소100/제목1000/헤더64KiB/본문각4MiB의 bounds와 DTO projection으로 native 내부 필드를 제거한다. HTML은 JSON 문자열로만 반환하며 실행·remote content fetch를 하지 않는다. 실제 브라우저 sandbox 구현/Playwright 인수는 **미실행**이다.

## 실제 시험과 실패 이력

| 실행 | 결과 |
| --- | --- |
| Node24.19·Node22.18 `npm run test:integration` | 각각 실제 Mailpit/SMTP/Keycloak/j-auth/PG/HTTPS **18/18**, fail/skip0 |
| `npm run check` | build/typecheck·unit9·deploy3·lint/format 통과 |
| `npm run test:registry` | 실제 loopback 게시 패키지/별도 exact 소비자/pack integrity1/1 통과 |
| `npm ci --ignore-scripts --offline --cache=/workspace/.cloud-setup/cache/npm` | 공용 캐시/lock 기반 설치 통과 |

실제 j-auth API로 새 두 격리 tenant/메일 구독과 같은 tenant 회원2명·무권한 회원1명을 만들었다. 정식 Authorization Code+PKCE 후 실제 token exchange로 j-mail aud를 받았으며 시험 소유 realm/DB 등록만 제거했다. 기존 realm·키·DB·실행 중 서비스는 보존했다. 혼합6메일에 반대 tenant To를 넣어도 전체건수/페이지/단건과 같은 tenant 공유가 유지됐다. 외국 id404 때 native Read 변화 없음, 실제401/403, Mailpit stop/restart503/복구, 새 verifier가 closed loopback JWKS에 연결할 때503, compiled HTTPS restart 조회, 민감 로그 부재를 확인했다. JWKS 시험은 기존 Keycloak 전체를 중지한 시험이 아니라 새 verifier의 실제 연결 장애다.

첫 API 실행은 기존 imported sample-a에서 scoped 회원 자격의 mail:read 매핑이 실제403→j-auth503이어서12 skip됐다. 해당 실패를 통과로 표시하거나 기존 realm 권한을 확장하지 않았다. UUID/카탈로그와 permission target은 readonly로 일치 확인했으나 이 샘플 permission 평가 원인은 **아직 해결되지 않았다**. canonical 신규 tenant는 동일 API로 정상 부여됐다. 새 fixture 초기에 JSON Content-Type만 붙인 empty PUT이400인 시험 설정 오류를 수정했고, 빈 Cc/Bcc가 native list에서는null인 실제 차이를 어댑터에서 빈 배열로 정규화했다. 이전 실패 결과와 최종18 통과를 구별한다.

결과: `/workspace/.suite-runtime/j-mail/inbox-results.json`, `inbox-node22-results.json`, `api-check.log`, `contracts-registry.log`, `contracts-publish.log`, `api-npm-ci.log`. 이전 실패: `inbox-initial-setup-failure.json`, `inbox-diagnostic-results.json`, `inbox-native-null-failure.json`과 로그. runtime env/개인키·본문/JWT는 commit하지 않는다.

ML-T02의 BFF/browser sandbox, ML-T04의 E8, ML-T05 VM/egress/systemd/설치·해지/백업은 아직 전체 통과가 아니다. E8은 첫 Received에 없는 전체 envelope 수신자 보존 및 FS-U07 수신 전 누락 기준이 필요하다. outbox/recovery/ingress proxy 정책을 임의로 추가하지 않았다.

## 후속 imported sample 호환 수정

[j-auth 수정 fbbb7382eb5dc4805aab4bbf5e0d3b634aef03e0](https://github.com/wnwjdals7498/j-auth/commit/fbbb7382eb5dc4805aab4bbf5e0d3b634aef03e0)의 [원인·증거](https://github.com/wnwjdals7498/j-auth/blob/fbbb7382eb5dc4805aab4bbf5e0d3b634aef03e0/docs/cloud-imported-role-compatibility-2026-10-08.md)로 기존 sample-a 회원 생성503의 원인을 수정했다. import scope 방향 오류가 login client에 동명 mail:read alias를 만들었고, 이름만 조회한 DB 매핑이 허용된 j-mail 대신 이 alias를 선택했다. 이제 카탈로그 역할 소유 client를 함께 조회하며 기존 FGAP/role/scope를 변경하지 않는다.

기존 sample의 실제 생성201·canonical 회수/재부여200·wrong alias403·실제 축소 JWT mail:read와 새 실제 import/PKCE 흐름을 Node22/24 각각6개로 검증했다. 전후 managed FGAP/catalog hash가 같다. 기존 scope drift는 보존했지만 실제 축소 JWT에 정상 role이 있어 추가 실패로 단정하지 않는다. j-auth 전체69개 및 이 저장소의 실제18개 회귀는 fail/skip0으로 통과했다. 이전 미해결/실패 이력은 당시 기록이며 현재 역할 부여 문제는 해결됐다. E8/UI/VM 미완료와 구별한다.

메일 회귀 결과는 `/workspace/.suite-runtime/j-mail/auth-compat-regression-results.json`이다. 메일 코드·contracts0.1.0은 변경하거나 다시 게시하지 않았다.
