# 음성 후보 비교용 샘플 생성
#   tools\.venv\Scripts\python.exe tools\sample.py
#
# rate 파라미터는 타임스트레치다. 크게 늦추면 모델이 자연 속도로 학습한 억양이
# 잡아 늘려져 뭉개진다 (-28% 는 "끔찍하다"는 평을 받았다).
# 느린 느낌은 목소리가 아니라 문장 사이 침묵으로 만든다 — 그건 앱이 제어한다.
# 그래서 후보를 자연 속도(0 ~ -10%) 근처로만 좁힌다.

import asyncio, pathlib, edge_tts

OUT = pathlib.Path(__file__).parent.parent / "audio" / "_samples"
VOICE = "ko-KR-HyunsuMultilingualNeural"

LINES = [
    "지금 떠오르는 일 중에 오늘 밤 해결할 수 있는 것은 하나도 없습니다.",
    "몸은 이미 쉴 준비가 되어 있습니다.",
]

# (이름, 속도, 톤)
VARIANTS = [
    ("A-그대로",     "+0%",  "+0Hz"),
    ("B-살짝느리게", "-8%",  "+0Hz"),
    ("C-낮게",       "+0%",  "-8Hz"),
    ("D-살짝낮게",   "-8%",  "-5Hz"),
]


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for path in OUT.glob("*.mp3"):
        path.unlink()
    for name, rate, pitch in VARIANTS:
        for i, text in enumerate(LINES, start=1):
            path = OUT / f"{name}-{i}.mp3"
            await edge_tts.Communicate(text, VOICE, rate=rate, pitch=pitch).save(str(path))
            print(f"{path.name:<22} {path.stat().st_size:>7,} bytes")


asyncio.run(main())
