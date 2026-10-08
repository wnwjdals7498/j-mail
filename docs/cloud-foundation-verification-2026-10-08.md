# 메일 기반 클라우드 검증 (2026-10-08)

E1/E2의 ML-01·02와 ML-30 DB/Compose 골격을 구현했다. ML-03의 relay 없음·격리 수신은 검증했지만 고객 VM 방화벽은 미실행이다. ML-30 outbox·E3 API·VM 설치는 아직 없다.

Mailpit 1.31.4 이미지는 `sha256:b68349e3a014b90c5610bfb26b2ae36f3892d7b8cf25ee140c6c71c98d2fcf48`로 고정했다. 전용 `jgw_mail`은 non-superuser, NOCREATEDB/NOCREATEROLE, 자기 DB CONNECT만 가능하며 advisory lock/checksum으로 migration 재적용과 변경을 관리한다. 메일 원본을 PostgreSQL에 복사하지 않는다. production profile은 한 tenant의 loopback SMTP/API와 고정 volume, relay/forward/remote checker 없음이다. Compose·env 예시는 설치/배포하지 않았다.

| 실행 | 결과 |
| --- | --- |
| Node24.19·Node22.18 `npm run test:integration` | 각각 실제 SMTP/Mailpit/PG 6/6, fail/skip0 |
| `npm run check` | build/typecheck·unit2·deploy3·lint/format 통과 |
| 최초 PG 설정 실행 | mount source0600 때문에 PG 초기화 중 종료; 각 Node 실행 setup 실패/6 skip. 통과로 계산하지 않음 |

실제 수신 허용/외부·미허용·suffix·subdomain 거절, 복수 수신자, 재기동 동일 id/volume, 위조된 To와 첫 Received 비교, 컨테이너 network none/read-only/cap-drop, migration 재적용, 타 DB CONNECT·CREATE ROLE 거절을 확인했다. PG 데이터/기존 암호를 보존하고 source 공개 코드만 읽기 가능하게 조정한 뒤 미실행 init을 한 번 적용했다. 외부 SMTP에 연결하지 않았다.

결과는 `/workspace/.suite-runtime/j-mail/foundation-results.json`, `foundation-node22-results.json`, `foundation-check.log`이며 최초 실패는 `foundation-setup-failure-node24.json`·`foundation-setup-failure-node22.json`에 보존했다. runtime env/개인키는 commit하지 않는다. contracts는 private이며 E3를 구현·검증하기 전 게시하지 않는다.

## E3 실측과 E8 차단

[공식 runtime 옵션](https://mailpit.axllent.org/docs/configuration/runtime-options/), [고정 버전 SMTP 소스](https://github.com/axllent/mailpit/blob/v1.31.4/internal/smtpd/main.go), [API](https://mailpit.axllent.org/docs/api-v1/)를 확인하고 실제 SMTP로 실측했다. To/Cc/Bcc는 헤더에서 나온 표시 자료여서 테넌트 권한 근거가 아니다. 위조 To가 다른 tenant를 가리켜도 실제 첫 SMTP 수신자는 Mailpit이 추가한 첫 Received에 남는다. 고객 VM당 한 tenant의 Mailpit과 SMTP-only capture를 전제로 E3는 이 근거를 확인한 뒤 필터/페이지/단건 조회해야 한다. 다른 tenant 상세를 먼저 읽으면 native GET의 Read 변경 부작용이 생겨 readonly headers 검사부터 해야 한다.

Mailpit은 전체 SMTP envelope 목록을 독립 metadata로 보존하지 않으며 첫 Received에는 첫 수신자만 있다. 이 자료만으로 E8 모든 수신자 알림의 누락 없는 대상을 확정할 수 없다. FS-U07의 webhook 수신 전 누락 한계와 함께 E8 결정이 필요하다. 임의의 ingress proxy·복구·MTA 정책을 추가하지 않았다. ML-T04/05 전체·브라우저 sandbox·운영/VM egress는 미실행이다.
