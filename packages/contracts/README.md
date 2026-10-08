# @j-mail/contracts 0.1.0

메일 목록/상세의 내부 GET 경로, DTO, 오류/자원 한도와 서버 응답 검증 함수다. Mailpit 원본 API를 외부에 공개하지 않는다. 표시 주소는 헤더이며 수신 권한·알림 대상 목록이 아니다. HTML은 untrusted 문자열이며 화면 구현에서 sandbox가 필요하다. 페이지의 total은 테넌트 필터 뒤 계산하고 scan 1000개를 넘으면 잘린 성공 대신 503이다. 모든 함수는 승인된 loopback registry의 immutable exact version으로 소비한다.
