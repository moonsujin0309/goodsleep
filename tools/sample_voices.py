# 남성 Chirp3-HD 목소리 전수 비교.
#
#   tools\.venv\Scripts\python.exe tools\sample_voices.py
#
# EQ 를 전혀 걸지 않는다. 저역 부스트(+3@120)가 "늙은 교수" 소리의 원인 후보라,
# 그걸 씌운 채 비교하면 16개가 전부 같은 색으로 물든다. 맨소리로 목소리만 고른다.
# 속도는 배포본과 같은 0.69 — 그래야 판단이 지금 듣는 것과 바로 이어진다.
#
# 후보를 3개로 좁힌 다음에 EQ·속도를 sample_google.py 방식으로 다시 만진다.

import asyncio, base64, pathlib, sys
import aiohttp
from tts import api_key, ENV_FILE

OUT = pathlib.Path(__file__).parent.parent / "audio" / "_samples" / "voices"
URL = "https://texttospeech.googleapis.com/v1/text:synthesize"
SPEED = 0.69

# 실제 나레이션 이완 층 문장. 바디스캔이라 톤의 나이가 제일 잘 드러난다.
TEXT = ("이제 몸을 훑어 가겠습니다. 발가락에서 시작합니다. "
        "발바닥이 넓어집니다. 종아리가 풀립니다. 손가락이 하나씩 펴집니다.")

# ko-KR Chirp3-HD 중 ssmlGender=MALE 전부 (voices.list 로 확인).
MALE = ["Achird", "Algenib", "Algieba", "Alnilam", "Charon", "Enceladus",
        "Fenrir", "Iapetus", "Orus", "Puck", "Rasalgethi", "Sadachbia",
        "Sadaltager", "Schedar", "Umbriel", "Zubenelgenubi"]
SEEN = {"Algieba": "현재 배포본", "Iapetus": "그전 후보"}


async def synth(session, key, name, path):
    body = {"input": {"text": TEXT},
            "voice": {"languageCode": "ko-KR", "name": f"ko-KR-Chirp3-HD-{name}"},
            "audioConfig": {"audioEncoding": "MP3", "speakingRate": SPEED}}
    async with session.post(URL, params={"key": key}, json=body) as r:
        if r.status != 200:
            return f"HTTP {r.status} {(await r.text())[:160]}"
        path.write_bytes(base64.b64decode((await r.json())["audioContent"]))
        return None


async def main():
    key = api_key("GOOGLE_TTS_API_KEY")
    if not key:
        sys.exit(f"GOOGLE_TTS_API_KEY 가 없습니다. {ENV_FILE} 확인.")

    OUT.mkdir(parents=True, exist_ok=True)
    for p in OUT.glob("*.mp3"):
        p.unlink()

    print(f"남성 {len(MALE)}개 · 맨소리(EQ 없음) · 속도 {SPEED} · "
          f"사용 {len(TEXT) * len(MALE)}자 / 무료 1,000,000자\n")

    async with aiohttp.ClientSession() as s:
        for i, name in enumerate(MALE, 1):
            path = OUT / f"{i:02d}-{name}.mp3"
            err = await synth(s, key, name, path)
            tag = f"  ({SEEN[name]})" if name in SEEN else ""
            print(f"  {i:02d} {name:<14}{'실패: ' + err if err else 'ok'}{tag}")

    print(f"\n{OUT}")


asyncio.run(main())
