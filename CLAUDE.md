# CLAUDE.md
# 정보 수집 에이전트 지시

버튼을 누르면 다음 정보를 수집하고, reports/{오늘의 날짜}_(번호두자리).md 에 추기해 주세요.
파일이 이미 존재하는 경우 덮어쓰기가 아닌 추가(append)할 것.

## 수집할 정보

### 기술 정보
- Velog 트렌드 (상위 5개): https://velog.io/
- 요즘IT 인기 기사 (상위 5개): https://yozm.wishket.com/
- GitHub Trending (당일): https://github.com/trending

### 경제 정보
- 코스피/코스닥 지수 (현재값·전일 대비)
- USD/KRW 환율 (현재값)
- 주요 마켓 뉴스 (3건 정도)

## 출력 포맷

각 섹션에 「취득 시각」을 기재할 것.
기사 제목, 요약, URL을 세트로 출력할 것.
경제 뉴스는 1행 요약으로 기재할 것.

## md file viewer 업데이트
이미 만들어져 있으면 업데이트만
index.html로 md viewer를 만들어서 업데이트
왼쪽은 view, 오른쪽은 리스트, 리스트 클릭하면 view가 보일 수 있도록
