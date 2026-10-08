# j-mail

테스트 전용 내부 SMTP·같은 tenant의 공유 받은편지함이다. Mailpit 기반 SMTP 수신과 j-mail 인증 목록/상세 API를 구현했다. 외부 이메일 발송·운영 설치를 수행하지 않는다.

Node 22.18 이상, PostgreSQL 18.6, Mailpit 1.31.4의 정확한 digest를 사용한다. `.npmrc.example`을 ignored `.npmrc`로 복사하고 승인된 loopback 레지스트리에서 `npm ci` 한다. `@j-auth/contracts`·`@j-auth/token-verifier`와 `@j-mail/contracts@0.1.0`은 exact version이며 형제 저장소 source를 생산 코드에서 참조하지 않는다.

```sh
npm run check
npm run test:registry
node scripts/prepare-cloud-tests.mjs
docker compose --env-file ../.suite-runtime/j-mail/compose.env -f ../.suite-runtime/j-mail/compose.yaml -p j-mail-cloud-test up -d
npm run test:integration
node --env-file=/external/runtime/mail.env apps/server/dist/main.js
```

prepare는 새 격리 fixture에만 사용한다. 기존 env·DB·키를 덮어쓰지 않는다. TLS·env·시험 결과는 체크아웃 밖 private 폴더에 둔다. fixture 암호·인증서는 운영 자격이 아니다. 생산 설정 예시와 Compose는 아직 적용하지 않은 입력이며 고객 VM 설치기가 아니다. 서버는 명시적인 loopback HTTPS 포트로만 수신하고 API Bearer를 검증한다. `deploy/server.env.example`의 placeholder를 외부 설정으로 채운다.

생산 Mailpit profile은 고객 VM당 한 tenant, SMTP/API/UI loopback, 릴레이 없음, 고정 volume, 명시적인 SMTP 수신자 허용 regex다. 테스트는 `--network none` 컨테이너의 private Unix socket만 loopback으로 연결하여 실제 SMTP를 보내므로 외부 발송 경로가 없다. 두 tenant를 허용하는 capture는 혼합 자료 음성 시험에만 사용한다. VM egress/systemd/설치와 정식 브라우저 화면은 미실행이다.

[API/검증 기록](docs/cloud-inbox-verification-2026-10-08.md), [기능 명세](docs/feature-specifications.md), [기반 검증](docs/cloud-foundation-verification-2026-10-08.md)을 따른다. 메일 원본은 Mailpit volume에만 있다. jgw_mail migration 골격은 있지만 outbox/E8 알림은 아직 없다.
