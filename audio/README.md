# audio/

## narration/ — 나레이션 음성 (전 상태 완료)

`tools/tts.py` 가 생성하고 `data/narration.json` 의 `files: [...]` 에 경로를 써 넣는다.
조각 하나가 **토막(mp3) 여러 개**로 쪼개져 있고, 토막 사이 침묵은 앱이 넣는다
(TTS 모델은 긴 침묵을 오류로 보고 줄이기 때문 — 쪼개는 규칙은 `tools/chunking.py`
와 `audio.js splitChunks` 가 반드시 같아야 한다).

확정 설정 (전부 귀로 고른 값 — `tools/tts.py` 상단 주석 참조):

```
엔진   Google Cloud TTS · ko-KR-Chirp3-HD-Algieba
속도   0.69 (조음의 바닥. 남은 느림은 침묵이 만든다)
EQ     저역 +3dB@120 · 명료도 +3dB@3.8k · 컴프레서 · 피치 무변경
쪼개기 문장 + 쉼표까지만 (연결어미 쪼개기는 시도 후 폐기 — 툭툭 끊긴다)
```

대본을 고치면:

```
tools\.venv\Scripts\python.exe tools\rewrite_states.py   (또는 rewrite_racing.py)
tools\.venv\Scripts\python.exe tools\tts.py --engine google --state <상태>
tools\.venv\Scripts\python.exe tools\preview.py --state <상태>   (검수용 합본)
```

**주의**: `rewrite_*.py` 는 상태 객체를 통째로 교체해서 `files` 배열이 지워진다.
실행 후 `tts.py` 를 (해당 상태 파일을 지우고) 다시 돌려야 배열이 복원된다.
텍스트가 바뀌었는데 파일명이 같으면 옛 음성이 남으므로 **상태 폴더를 지우고** 뽑을 것.

## 배경 사운드 — 파일 없음, 전부 코드 합성

10종(비·파도·모닥불·바람·시냇물·풀벌레·선풍기·백색·핑크·브라운)은 `audio.js` 가
브라우저에서 실시간 합성한다. 라이선스 문제도, 루프 이음매도, 다운로드도 없다.
음원 파일을 넣고 싶어지면 먼저 STATUS.md 의 "음원을 다운로드하지 않은 이유"를 읽을 것.

`.gitignore` 가 오디오 확장자를 막고 있고 `audio/narration/**/*.mp3` 만 예외다 —
직접 생성한 음성이라 라이선스가 없기 때문. 외부 음원은 CC0 확인 전에 예외에 넣지 말 것.
