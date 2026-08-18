# ElevenLabs 보이스 라이브러리에서 한국어 음성을 찾는다.
#
#   tools\.venv\Scripts\python.exe tools\find_ko_voices.py
#
# 내 계정 라이브러리(--list-voices)에는 영어 음성만 있다. 공용 라이브러리에서
# 한국어로 학습된 음성을 찾으면 억양 문제 없이 갈 수 있다.

import asyncio, sys
import aiohttp
from tts import api_key, ENV_FILE

BASE = "https://api.elevenlabs.io/v1/shared-voices"


async def main():
    key = api_key("ELEVENLABS_API_KEY")
    if not key:
        sys.exit(f"ELEVENLABS_API_KEY 가 없습니다. {ENV_FILE} 확인.")

    rows = []
    async with aiohttp.ClientSession(headers={"xi-api-key": key}) as s:
        for params in (
            {"language": "ko", "gender": "male", "page_size": 30},
            {"language": "ko", "page_size": 30},
            {"search": "korean", "page_size": 30},
        ):
            async with s.get(BASE, params=params) as r:
                if r.status != 200:
                    print(f"  {params} → HTTP {r.status} {(await r.text())[:200]}")
                    continue
                data = await r.json()
            for v in data.get("voices", []):
                key_id = v.get("voice_id")
                if any(x[0] == key_id for x in rows):
                    continue
                rows.append((
                    key_id,
                    (v.get("name") or "")[:26],
                    v.get("gender") or "?",
                    v.get("language") or "?",
                    (v.get("descriptive") or v.get("category") or "")[:18],
                    (v.get("use_case") or "")[:20],
                    v.get("cloned_by_count", 0),
                ))

    if not rows:
        print("한국어 음성을 찾지 못했습니다.")
        return

    rows.sort(key=lambda r: -r[6])
    print(f"{'voice_id':<24} {'이름':<26} {'성별':<7} {'lang':<5} {'묘사':<18} {'용도':<20} 사용수")
    for r in rows[:30]:
        print(f"{r[0]:<24} {r[1]:<26} {r[2]:<7} {r[3]:<5} {r[4]:<18} {r[5]:<20} {r[6]}")
    print(f"\n총 {len(rows)}개")


asyncio.run(main())
