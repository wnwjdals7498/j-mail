# 새 메일 알림 구현 handoff — 2026-10-09

상태: **구현 및 isolated 실제 통합 검증 완료.** jgw_mail migration과 actual SMTP/Mailpit/PG/GWA 경로를 시험했지만 ML-T04 운영완료나 운영설치를 뜻하지 않는다.

## 계약과 동작

선택형 `createMailCaptureServer`는 loopback SMTP 터널이다. SMTP command/reply를 순차 처리하고 실제 Mailpit upstream의 RCPT 승인 뒤에만 주소를 보관한다. tenant mail 주소만 받으며 username은 소문자로 정규화하고 중복 수신자는 한 username으로 묶는다. `DATA` 전 `smtp_envelope_captures`에 capture UUID와 전체 usernames를 commit한다. RFC 헤더 boundary를 확인하고 기존 `X-JGW-Capture-ID` 및 continuation을 제거한 다음 새 UUID marker를 하나 삽입한다. 운영 SMTP 경로는 변경하지 않았으며 `JML_SMTP_CAPTURE_PORT`와 `JML_MAILPIT_SMTP_PORT`를 둘 다 외부에 명시하지 않으면 adapter는 시작되지 않는다.

Mailpit webhook은 summary의 native `ID`만 입력으로 신뢰한다. j-mail은 해당 ID의 headers endpoint를 읽어 marker 하나를 확인하고 capture row의 tenant·수신자·기존 ID consistency를 확인한다. outbox insert·capture-ID 연결은 같은 PostgreSQL transaction에 있으며 `(tenant_id, mailpit_message_id)` 충돌은 내용을 바꾸지 않고 기존 capture/수신자가 동일한지 검증한다. 성공 commit 후 204를 반환하고 G22 비활성/중단은 lease 기반 2–60초 retry 대상이다. 같은 event의 GWA `dedupKey`는 Mailpit ID다.

## Schema handoff

Migration 순번·파일은 j-mail 오케스트레이터가 단일 writer로 통합한다. 필요한 j-mail 소유 표는 아래다.

- `smtp_envelope_captures`: `capture_id uuid PK`, `tenant_id text`, `usernames jsonb` (1–100 unique lowercase usernames), `message_id text NULL UNIQUE` (Mailpit ID pattern), `created_at timestamptz`, `linked_at timestamptz NULL`.
- `notification_outbox`: `id uuid PK`, `tenant_id text`, `mailpit_message_id text`, `capture_id uuid FK`, `usernames jsonb`, `event_type='mail.new'`, `created_at`, `available_at`, `attempts`, `locked_until`, `lease_token`, `delivered_at`, `last_error`; unique `(tenant_id, mailpit_message_id)` and partial pending claim index `(tenant_id, available_at, created_at, id) WHERE delivered_at IS NULL`.
- Public grants are revoked. The application role remains the existing dedicated non-superuser `jgw_mail`.

추가 registry/contract dependency는 없다. Migration 없이 전체 build가 가능하나 webhook/outbox와 runtime adapter를 실제 DB에서 켜면 안 된다.

## Official provenance

고정 버전 Mailpit v1.31.4 공식 [`internal/smtpd/main.go`](https://github.com/axllent/mailpit/blob/v1.31.4/internal/smtpd/main.go)는 SMTP handler에 accepted `to []string` 전체를 넘기고, `internal/smtpd/smtpd.go`는 `MsgIDHandler` 반환 ID를 `250 2.0.0 Ok: queued as <message-id>`로 회신한다고 정의한다. [Webhook docs](https://mailpit.axllent.org/docs/integration/webhook/)는 webhook이 message summary만 보내며 기본 1 req/sec rate limit, 실패 재시도 없음으로 기록한다. 따라서 headers/Received/To/Cc/Bcc로 SMTP envelope를 복원했다고 주장하지 않는다.

## 검증 결과와 대기

Node 22.18 `npm run build`, test TypeScript `npm run typecheck`, 신규 `tests/server/mail-notifications.test.ts` 5/5 통과. 시험은 spoof marker strip·single marker insertion, 잘못된 marker fail-closed, multi-username outbox 입력, Mailpit ID 기반 GWA payload를 확인한 unit 시험이다.

실제 통합 시험은 격리 tenant와 owned Mailpit 1.31.4, 실제 j-mail PostgreSQL migration, 실제 SMTP capture proxy, j-mail Fastify webhook route, j-groupware PostgreSQL notification receiver로 수행했다. 두 SMTP RCPT를 받아 capture row의 usernames와 native Mailpit `queued as` ID를 확인했고 spoofed header/To를 신뢰하지 않았다. Mailpit fixture에는 테스트 전용 `MP_WEBHOOK_URL=http://127.0.0.1:<ephemeral>/internal/mailpit/webhook`과 `MP_WEBHOOK_LIMIT=0`을 설정했다. 이 단일 fixture만 host network를 사용해 owned loopback listener에 webhook을 전송하며, 실제 Mailpit `User-Agent` 요청에서 SMTP queued ID와 같은 ID가 도착해 PG outbox에 commit됨을 확인했다. 이후 동일 summary를 Fastify `inject`로 반복 제출해도 outbox는 한 건만 유지됐다. 미매핑 ID는 503으로 fail-closed했다. GWA receiver 중단으로 전송 실패를 만든 뒤 PostgreSQL retry 시각에 따라 재시도했고, 복구 receiver에서 실제 `mail.new` 저장과 전체 usernames 및 Mailpit ID dedup key를 확인했다. 일반 capture fixture는 계속 network-none이며 운영 Compose나 SMTP 경로에는 host networking, webhook URL, rate limit 설정을 적용하지 않았다.

검증 결과: Node 22.18/24.19에서 신규 `test:integration -- tests/integration/notification.integration.test.ts` 각 1/1 통과, 전체 `test:integration` 각 19/19 통과, 전체 package `check` 통과. 상세 로그는 `/workspace/.suite-runtime/j-groupware/task25-mail-e8-producer-final2-node22.log`, `task25-mail-e8-producer-final-node24.log`, `task25-mail-full-integration-final-node22.log`, `task25-mail-full-integration-node24.log`, `task25-mail-check-post-producer-final-node22.log`, `task25-mail-check-post-producer-node24.log`에 있다.

FS-U07 최소 한계를 유지한다: Mailpit가 webhook을 보내기 전 생략·호출 실패 복구는 포함하지 않는다. `MP_WEBHOOK_LIMIT=0`은 burst 누락 완화에 필요하지만 운영 Mailpit Compose에는 반영하지 않았다. 운영 G22 URL/key, 운영 SMTP adapter binding, customer VM, CA/firewall, deployment는 설치·생성·활성화하지 않았다.
