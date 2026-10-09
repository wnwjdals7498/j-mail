# j-mail 기능 명세

작성일: 2026-10-08. 상태: **구현·인수 시험 전**. [목록](features.md), [결정](decisions.md), [공통 기준](../../j-groupware/docs/suite-feature-specifications.md)을 따른다. 테스트 전용 내부 SMTP와 같은 tenant의 공유 받은편지함이다. 개인별 받은편지함은 만들지 않는다.

## 입출력과 흐름

| 대상      | 최소 계약                                                                                                                                                                                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SMTP      | loopback으로 받은 메일 중 허용 tenant의 `<username>@<tenant>.jgw.test` 수신자만 받는다. 실제 SMTP 수신자 주소를 검사하며 외부 relay는 설정하지 않는다.                                                                                                                  |
| 목록·상세 | Bearer의 tenant와 `mail:read`를 검사한 뒤 Mailpit 메시지를 조회한다. 목록은 수신자·발신자·제목·시각·페이지, 상세는 헤더·텍스트·HTML이다. BFF가 HTML을 sandbox로 표시한다.                                                                                               |
| 격리      | Mailpit 수신자 자료에서 해당 tenant 메일인지 확인한다. 필터 이후 페이지를 계산하고 단건에도 같은 검사를 적용한다. SMTP envelope와 Mailpit의 수신자 필드 대응은 E3 실측으로 고정한다.                                                                                    |
| 저장      | 메일 원본은 Mailpit 고정 볼륨, `jgw_mail`은 notification_outbox다. API·webhook 어댑터가 Mailpit id를 유지하며 API에서 원본을 다른 DB에 복사하지 않는다.                                                                                                                 |
| 알림      | trusted SMTP capture adapter가 승인된 전체 `RCPT TO`를 보존하고 Mailpit ID와 연결한다. webhook은 marker·mapping을 확인한 뒤 같은 tenant의 username 전체를 한 `mail.new` event로 PG outbox에 적재한다. outbox에는 Mailpit id 기반 dedupKey·전송 상태·재시도 정보를 둔다. |

정상 흐름은 내부 SMTP 발송 → trusted capture adapter → Mailpit 보관 → j-mail 권한·tenant 검사 → BFF 목록·상세다. 알림은 capture가 실제 승인 envelope를 PG에 저장하고 메시지에 capture UUID를 넣은 뒤 → Mailpit webhook의 native ID를 read-only headers로 marker 검증 → PG outbox 저장 → G22 송신이다. 같은 webhook을 다시 받아도 같은 사건이며 다중 수신자 중 한 명만 남기는 중복 제거를 하지 않는다. adapter·capture mapping이 없거나 recipient/ID 검증이 실패하면 outbox를 만들지 않고 503을 돌려준다.

## 기능별 계약

| 기능 ID | PMT Item | 입력·정상 동작·출력                                 | 권한·실패 경계                                        | 인수 시험     |
| ------- | -------- | --------------------------------------------------- | ----------------------------------------------------- | ------------- |
| ML-01   | E1       | 내부 SMTP 메일→Mailpit 보관·재기동 후 조회          | SMTP/API/UI loopback, 볼륨과 정확 버전 고정           | ML-T01        |
| ML-02   | E2       | 허용 목록에서 정규식→수신자 SMTP 수락/거부          | 외부·미허용 tenant 거부; 무시 후250 옵션 금지         | ML-T01        |
| ML-03   | E2·E7    | relay 미설정·외부25/465/587 egress 차단             | 받은 메일 조회와 외부 전달 경로를 구별                | ML-T01·ML-T05 |
| ML-10   | E3       | 목록 요청→tenant 메일과 페이지 정보                 | mail:read, 다른 tenant가 페이지/건수에 섞이지 않음    | ML-T02        |
| ML-11   | E3       | Mailpit id→헤더·텍스트·HTML                         | 없는/다른 tenant id404, 원문 로그 없음                | ML-T02        |
| ML-12   | E3       | 토큰 tenant↔수신자 도메인 검사                      | query/body tenant로 우회 불가                         | ML-T02        |
| ML-13   | E3       | j-mail aud·issuer·azp·role 검증                     | 무효401·권한403·Mailpit/JWKS 장애503                  | ML-T03        |
| ML-20   | E8       | webhook→수신자별 대상 목록·outbox→mail.new          | 적재 후 재시도·동일 사건1건, 수신 전 누락은 별도 한계 | ML-T04        |
| ML-30   | E1       | jgw_mail·전용 계정·outbox migration·Mailpit Compose | DB와 Mailpit 볼륨 백업을 구별                         | ML-T05        |
| ML-31   | E3       | 목록/상세·페이지·오류 DTO 게시                      | Mailpit 원본 API를 브라우저에 직접 노출하지 않음      | ML-T02·ML-T03 |
| ML-32   | E7       | 고객 VM 설치→화면조회→해지·볼륨백업                 | 내부 포트·egress 차단·systemd·빈 gateway 경계         | ML-T05        |

## 인수 시험

| ID     | 관찰할 결과                                                                                                                                    |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| ML-T01 | 실제 SMTP의 내부 주소 성공·외부/미허용 주소 거부 응답·복수 수신자, relay 없음, 저장 볼륨 재기동 보존. SMTP 거부를 HTTP 상태로 대신하지 않는다. |
| ML-T02 | 두 tenant 메일 혼합 자료에서 페이지 경계·전체 건수·단건 격리, 같은 tenant 두 회원이 같은 편지함 조회, BFF HTML script 미실행.                  |
| ML-T03 | 실제 토큰의 401/403·타 tenant id404, Mailpit·JWKS 중단503, 금지된 응답에 다른 메일 자료가 없음.                                                |
| ML-T04 | 여러 수신자와 반복 webhook→같은 사건1건·대상 누락 없음, G22 중단 뒤 outbox 재송신, burst·webhook 수신기 중단 시 발생한 누락을 별도로 기록.     |
| ML-T05 | DB 전용 접속·migration, VM 설치·화면·외부 egress 거절, 해지 시 Mailpit 중지·메일 볼륨과 DB 백업·다른 서비스 보존.                              |

## 공식 확인과 미정

[Mailpit 옵션](https://mailpit.axllent.org/docs/configuration/runtime-options/)의 `MP_SMTP_BIND_ADDR`, `MP_UI_BIND_ADDR`, `MP_SMTP_ALLOWED_RECIPIENTS`와 relay 비활성 상태를 고정 버전에서 확인한다. `MP_SMTP_IGNORE_REJECTED_RECIPIENTS`로 거부를 무시하면 요구한 SMTP 거부가 성립하지 않는다.

[공식 webhook](https://mailpit.axllent.org/docs/integration/webhook/)은 `MP_WEBHOOK_URL`로 설정하며 message summary만 보내고 기본 빈도 제한으로 일부 사건이 생략되며 실패를 재시도하지 않는다. 선택형 운영 binding은 burst 유실을 줄이기 위해 `MP_WEBHOOK_LIMIT=0`이 필요하다. FS-U07의 최소 범위대로 webhook 도착 전 누락·호출 실패 복구는 제공하지 않고, PG outbox commit 뒤 G22 전송 재시도만 보장한다.

Mailpit v1.31.4 [공식 SMTP source](https://github.com/axllent/mailpit/blob/v1.31.4/internal/smtpd/main.go)에서 accepted SMTP `to []string`가 message-ID 저장 handler로 전달되며, [SMTP server source](https://github.com/axllent/mailpit/blob/v1.31.4/internal/smtpd/smtpd.go)는 저장 ID의 `queued as` response 형식을 정의한다. j-mail capture adapter는 full envelope를 먼저 보존하고 고유 marker로 webhook ID와 대응한다. 이 source binding은 외부 설정 없이는 켜지지 않고 제품 Compose를 변경하지 않는다.

E8 webhook은 native ID와 capture mapping을 검증한 뒤 outbox transaction commit 후에만 204를 반환한다. 현재 개발 unit 시험은 adapter framing/marker·multi-username payload·fail-closed와 단위 outbox 호출을 확인한다. 실제 Mailpit + jgw_mail + GWA 수신 통합은 migration 통합 후 실행 gate이며 아직 ML-T04 완료로 보지 않는다. 보존 정책·개인별 필터·실제 MTA/mail 인증·SMTP AUTH/STARTTLS는 기존 이후 범위다.
