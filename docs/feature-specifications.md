# j-mail 기능 명세

작성일: 2026-10-08. 상태: **구현·인수 시험 전**. [목록](features.md), [결정](decisions.md), [공통 기준](../../j-groupware/docs/suite-feature-specifications.md)을 따른다. 테스트 전용 내부 SMTP와 같은 tenant의 공유 받은편지함이다. 개인별 받은편지함은 만들지 않는다.

## 입출력과 흐름

| 대상 | 최소 계약 |
| --- | --- |
| SMTP | loopback으로 받은 메일 중 허용 tenant의 `<username>@<tenant>.jgw.test` 수신자만 받는다. 실제 SMTP 수신자 주소를 검사하며 외부 relay는 설정하지 않는다. |
| 목록·상세 | Bearer의 tenant와 `mail:read`를 검사한 뒤 Mailpit 메시지를 조회한다. 목록은 수신자·발신자·제목·시각·페이지, 상세는 헤더·텍스트·HTML이다. BFF가 HTML을 sandbox로 표시한다. |
| 격리 | Mailpit 수신자 자료에서 해당 tenant 메일인지 확인한다. 필터 이후 페이지를 계산하고 단건에도 같은 검사를 적용한다. SMTP envelope와 Mailpit의 수신자 필드 대응은 E3 실측으로 고정한다. |
| 저장 | 메일 원본은 Mailpit 고정 볼륨, `jgw_mail`은 notification_outbox다. API·webhook 어댑터가 Mailpit id를 유지하며 API에서 원본을 다른 DB에 복사하지 않는다. |
| 알림 | 같은 메일의 해당 tenant 수신자 username 목록을 한 사건으로 묶어 `mail.new`를 적재한다. outbox에는 Mailpit id 기반 dedupKey·전송 상태·재시도 정보를 둔다. |

정상 흐름은 내부 SMTP 발송 → Mailpit 보관 → j-mail 권한·tenant 검사 → BFF 목록·상세다. 알림은 webhook 수신 → 유효 수신자 추출 → outbox 저장 → G22 송신이다. 같은 webhook을 다시 받아도 같은 사건이며 다중 수신자 중 한 명만 남는 중복 제거를 하지 않는다.

## 기능별 계약

| 기능 ID | PMT Item | 입력·정상 동작·출력 | 권한·실패 경계 | 인수 시험 |
| --- | --- | --- | --- | --- |
| ML-01 | E1 | 내부 SMTP 메일→Mailpit 보관·재기동 후 조회 | SMTP/API/UI loopback, 볼륨과 정확 버전 고정 | ML-T01 |
| ML-02 | E2 | 허용 목록에서 정규식→수신자 SMTP 수락/거부 | 외부·미허용 tenant 거부; 무시 후250 옵션 금지 | ML-T01 |
| ML-03 | E2·E7 | relay 미설정·외부25/465/587 egress 차단 | 받은 메일 조회와 외부 전달 경로를 구별 | ML-T01·ML-T05 |
| ML-10 | E3 | 목록 요청→tenant 메일과 페이지 정보 | mail:read, 다른 tenant가 페이지/건수에 섞이지 않음 | ML-T02 |
| ML-11 | E3 | Mailpit id→헤더·텍스트·HTML | 없는/다른 tenant id404, 원문 로그 없음 | ML-T02 |
| ML-12 | E3 | 토큰 tenant↔수신자 도메인 검사 | query/body tenant로 우회 불가 | ML-T02 |
| ML-13 | E3 | j-mail aud·issuer·azp·role 검증 | 무효401·권한403·Mailpit/JWKS 장애503 | ML-T03 |
| ML-20 | E8 | webhook→수신자별 대상 목록·outbox→mail.new | 적재 후 재시도·동일 사건1건, 수신 전 누락은 별도 한계 | ML-T04 |
| ML-30 | E1 | jgw_mail·전용 계정·outbox migration·Mailpit Compose | DB와 Mailpit 볼륨 백업을 구별 | ML-T05 |
| ML-31 | E3 | 목록/상세·페이지·오류 DTO 게시 | Mailpit 원본 API를 브라우저에 직접 노출하지 않음 | ML-T02·ML-T03 |
| ML-32 | E7 | 고객 VM 설치→화면조회→해지·볼륨백업 | 내부 포트·egress 차단·systemd·빈 gateway 경계 | ML-T05 |

## 인수 시험

| ID | 관찰할 결과 |
| --- | --- |
| ML-T01 | 실제 SMTP의 내부 주소 성공·외부/미허용 주소 거부 응답·복수 수신자, relay 없음, 저장 볼륨 재기동 보존. SMTP 거부를 HTTP 상태로 대신하지 않는다. |
| ML-T02 | 두 tenant 메일 혼합 자료에서 페이지 경계·전체 건수·단건 격리, 같은 tenant 두 회원이 같은 편지함 조회, BFF HTML script 미실행. |
| ML-T03 | 실제 토큰의 401/403·타 tenant id404, Mailpit·JWKS 중단503, 금지된 응답에 다른 메일 자료가 없음. |
| ML-T04 | 여러 수신자와 반복 webhook→같은 사건1건·대상 누락 없음, G22 중단 뒤 outbox 재송신, burst·webhook 수신기 중단 시 발생한 누락을 별도로 기록. |
| ML-T05 | DB 전용 접속·migration, VM 설치·화면·외부 egress 거절, 해지 시 Mailpit 중지·메일 볼륨과 DB 백업·다른 서비스 보존. |

## 공식 확인과 미정

[Mailpit 옵션](https://mailpit.axllent.org/docs/configuration/runtime-options/)의 `MP_SMTP_BIND_ADDR`, `MP_UI_BIND_ADDR`, `MP_SMTP_ALLOWED_RECIPIENTS`와 relay 비활성 상태를 고정 버전에서 확인한다. `MP_SMTP_IGNORE_REJECTED_RECIPIENTS`로 거부를 무시하면 요구한 SMTP 거부가 성립하지 않는다.

[공식 webhook](https://mailpit.axllent.org/docs/integration/webhook/)은 `MP_WEBHOOK_URL`로 설정하며 기본 빈도 제한으로 일부 사건이 생략되고 실패를 재시도하지 않는다. 정상 burst 수신 시험에서는 `MP_WEBHOOK_LIMIT=0` 적용을 확인한다. 이것만으로 수신기 중단 때 누락이 복구되지는 않는다. E8 전에 허용 한계·복구 필요 여부를 결정하며, 수신 이후 outbox 재시도와 구별한다.

E3에서 wrapper API 경로·DTO·Mailpit API/수신자 필드를 고정한다. E8 webhook 검증·응답 시점은 outbox 적재 완료와 맞춘다. 보존 정책·개인별 필터·실제 MTA/mail 인증·SMTP AUTH/STARTTLS는 기존 이후 범위다.
