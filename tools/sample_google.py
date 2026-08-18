# Iapetus 미세조정.
#
#   tools\.venv\Scripts\python.exe tools\sample_google.py
#
# 목소리는 ko-KR-Chirp3-HD-Iapetus 로 정해졌다 (5 > 1 > 6).
# 여기서는 축을 하나씩만 움직여 어느 방향이 맞는지 좁힌다.
# 피치는 건드리지 않는다 — 두 방식 다 인공음이 생겼다 (voicefx.py 주석 참조).

import asyncio, base64, pathlib, sys
import aiohttp
from tts import api_key, ENV_FILE
from voicefx import process

OUT = pathlib.Path(__file__).parent.parent / "audio" / "_samples"
RAW = OUT / "_raw"
URL = "https://texttospeech.googleapis.com/v1/text:synthesize"

LINE = "지금 떠오르는 일 중에 오늘 밤 해결할 수 있는 것은 하나도 없습니다."
# 자음이 많은 문장. 혀 꼬임(조음 뭉개짐)은 여기서 제일 잘 드러난다.
FLOW = ("이제 몸을 훑어 가겠습니다. 발가락에서 시작합니다. "
        "발바닥이 넓어집니다. 종아리가 풀립니다. 손가락이 하나씩 펴집니다.")

# 목표: 게롤트(위쳐) 같은 낮고 거친 판타지 톤.
# 반대말은 "50대 수학 선생님" = informative / clear / formal 계열.
#
# 중역을 깊게 깎으면 안 된다. 거친 질감(gravel)이 2~4kHz 에 있어서
# -8dB 로 깎던 이전 설정이 원하는 질감을 지우고 있었다.
# 저역만 약간 올리고 치찰음만 눕힌다.
VOICE = "ko-KR-Chirp3-HD-Algieba"   # 8번 확정
BASE = dict(bite_db=-2.0, bite_hz=3500, body_db=2.5, body_hz=150,
            air_db=-2.0, air_hz=7500, gain_db=-1.0)

# 속도만 분리해서 본다. EQ 는 고정 — 축을 하나만 움직여야 판단이 된다.
# (이름, 속도, 덮어쓸 값)
# E 확정 (저역 +3@120 · 명료도 +3@3.8k · 컴프). EQ 를 고정하고 속도만 내려
# 혀 꼬임이 시작되는 지점을 찾는다 = 최저 안전 속도.
E = dict(body_db=3.0, body_hz=120, clarity_db=3.0, air_db=0.0, compress=True)

VARIANTS = [
    ("1-075-기준", 0.75, E),
    ("2-072",      0.72, E),
    ("3-069",      0.69, E),
    ("4-066",      0.66, E),
    ("5-063",      0.63, E),
]


async def synth(session, key, text, path, speed):
    body = {"input": {"text": text},
            "voice": {"languageCode": "ko-KR", "name": VOICE},
            "audioConfig": {"audioEncoding": "MP3", "speakingRate": speed}}
    async with session.post(URL, params={"key": key}, json=body) as r:
        if r.status != 200:
            return f"HTTP {r.status} {(await r.text())[:200]}"
        path.write_bytes(base64.b64decode((await r.json())["audioContent"]))
        return None


async def main():
    key = api_key("GOOGLE_TTS_API_KEY")
    if not key:
        sys.exit(f"GOOGLE_TTS_API_KEY 가 없습니다. {ENV_FILE} 확인.")

    OUT.mkdir(parents=True, exist_ok=True)
    RAW.mkdir(exist_ok=True)
    for p in OUT.glob("*.mp3"):
        p.unlink()

    print(f"{VOICE} · {len(VARIANTS)}개 · 사용 {len(FLOW)*len(VARIANTS)}자 / 무료 1,000,000자\n")

    async with aiohttp.ClientSession() as s:
        for name, speed, over in VARIANTS:
            eq = {**BASE, **over}
            raw = RAW / f"{name}.mp3"
            err = await synth(s, key, FLOW, raw, speed)
            if err:
                print(f"  {name}  실패: {err}")
                continue
            process(raw, OUT / f"{name}.mp3", **eq)
            bits = [f"속도{speed}", f"저역+{eq['body_db']}@{eq['body_hz']}"]
            if eq.get("rasp_db"):
                bits.append(f"질감+{eq['rasp_db']}@{eq.get('rasp_hz', 2000)}")
            if eq.get("compress"):
                bits.append("컴프")
            print(f"  {name:<12} {' · '.join(bits)}")

    for p in RAW.glob("*.mp3"):
        p.unlink()
    RAW.rmdir()


asyncio.run(main())
