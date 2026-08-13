# 음성 후보 비교용 샘플 생성
#   tools\.venv\Scripts\python.exe tools\sample.py
#
# 알아낸 것:
#   - rate 를 낮추면 타임스트레치라 억양이 뭉개진다. -5% 이상 내리지 않는다.
#   - pitch 는 타임스트레치가 아니라서 많이 내려도 음질이 거의 안 상한다. 여기를 쓴다.
#   - ko-KR 음성은 VoicePersonalities 가 "Friendly, Positive" 뿐이고
#     calm/whispering 같은 스타일이 없다. 그래서 "상담사 톤"이 한계다.
#     volume 을 낮추면 게인만 주는지 딜리버리까지 부드러워지는지 여기서 확인한다.

import asyncio, pathlib, edge_tts

OUT = pathlib.Path(__file__).parent.parent / "audio" / "_samples"
VOICE = "ko-KR-HyunsuMultilingualNeural"

LINES = [
    "지금 떠오르는 일 중에 오늘 밤 해결할 수 있는 것은 하나도 없습니다.",
    "이제 아무것도 하지 않아도 됩니다.",
]

# (이름, 속도, 톤, 볼륨)
VARIANTS = [
    ("E-지금",       "-5%", "-8Hz",  "+0%"),
    ("F-작게",       "-5%", "-8Hz",  "-30%"),
    ("G-깊게",       "-5%", "-20Hz", "-30%"),
    ("H-가장깊게",   "-5%", "-30Hz", "-45%"),
]


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for path in OUT.glob("*.mp3"):
        path.unlink()
    for name, rate, pitch, volume in VARIANTS:
        for i, text in enumerate(LINES, start=1):
            path = OUT / f"{name}-{i}.mp3"
            await edge_tts.Communicate(text, VOICE, rate=rate, pitch=pitch, volume=volume).save(str(path))
            print(f"{path.name:<20} {path.stat().st_size:>7,} bytes")


asyncio.run(main())
