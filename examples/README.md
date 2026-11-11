# 예시 입력

`source.txt`는 지어낸 기사, `script.txt`는 그 기사로 만든 대본이다. 대본 3번째 섹션에 결함을 하나 심어 두었다 (원문은 야간에 120석 중 60석만 개방).

```bash
npm run judge:one -- --source examples/source.txt --script examples/script.txt
```

직접 시험할 때는 쇼더스 스튜디오의 입력 단계에서 "입력한 원고"를, 대본 단계에서 각 섹션 문장을 복사해 같은 형식으로 넣으면 된다.
