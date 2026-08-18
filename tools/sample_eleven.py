# ElevenLabs 한국어 남성 음성 후보 비교 샘플.
#
#   tools\.venv\Scripts\python.exe tools\sample_eleven.py
#
# 무료 티어는 월 10,000자다. 후보 5개 × 2문장 ≈ 270자로 전체의 3%만 쓴다.
# 통째로 뽑아놓고 마음에 안 드는 게 제일 비싸므로 짧게 먼저 듣는다.

import asyncio, pathlib, sys
import aiohttp
from tts import api_key, ENV_FILE

OUT = pathlib.Path(__file__).parent.parent / "audio" / "_samples"
MODEL = "eleven_multilingual_v2"

LINES = [
    "지금 떠오르는 일 중에 오늘 밤 해결할 수 있는 것은 하나도 없습니다.",
    "이제 아무것도 하지 않아도 됩니다.",
]

# 무료 계정은 API 로 라이브러리 음성을 쓸 수 없다 (HTTP 402 paid_plan_required).
# 한국어 원어민 음성 64개도, 사용자가 고른 Nathaniel C 도 전부 막힌다.
# 무료로 API 에서 쓸 수 있는 것은 기본 내장 음성뿐이고 전부 영어다.
# 다국어 모델이 한국어를 읽기는 하지만 억양이 묻어나는지가 관건이다.
CANDIDATES = [
    ("1-Brian-깊고편안", "nPczCjzI2devNBz1zQrb"),  # Deep, Resonant and Comforting
    ("2-George-이야기꾼", "JBFqnCBsd6RMkjVDRZzb"),  # Warm, Captivating Storyteller (영국)
    ("3-Daniel-차분",   "onwK4e9ZLuTAKqWW03F9"),  # Steady Broadcaster (영국)
    ("4-Bill-원숙",     "pqHfZKP75CvOlQylNhV4"),  # Wise, Mature, Balanced
    ("5-Eric-부드러움",  "cjVigY5qzO86Huf0OWal"),  # Smooth, Trustworthy
]

SETTINGS = {"stability": 0.55, "similarity_boost": 0.75, "style": 0.0, "use_speaker_boost": False}


async def synth(session, voice_id, text, path):
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
    body = {"text": text, "model_id": MODEL, "voice_settings": SETTINGS}
    async with session.post(url, json=body) as r:
        if r.status != 200:
            return f"HTTP {r.status} {(await r.text())[:160]}"
        path.write_bytes(await r.read())
        return None


async def main():
    key = api_key("ELEVENLABS_API_KEY")
    if not key:
        sys.exit(f"ELEVENLABS_API_KEY 가 없습니다. {ENV_FILE} 확인.")

    OUT.mkdir(parents=True, exist_ok=True)
    for p in OUT.glob("*.mp3"):
        p.unlink()

    used = sum(len(t) for t in LINES) * len(CANDIDATES)
    print(f"모델 {MODEL} · 후보 {len(CANDIDATES)}개 · 예상 사용 {used}자\n")

    async with aiohttp.ClientSession(headers={"xi-api-key": key}) as s:
        for name, vid in CANDIDATES:
            for i, text in enumerate(LINES, start=1):
                path = OUT / f"{name}-{i}.mp3"
                err = await synth(s, vid, text, path)
                if err:
                    print(f"  {name}-{i}  실패: {err}")
                else:
                    print(f"  {path.name:<22} {path.stat().st_size:>7,} bytes")

        async with s.get("https://api.elevenlabs.io/v1/user/subscription") as r:
            if r.status == 200:
                d = await r.json()
                print(f"\n사용량 {d['character_count']:,} / {d['character_limit']:,} 자")


asyncio.run(main())
