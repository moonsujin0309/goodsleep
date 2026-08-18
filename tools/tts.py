# 나레이션 mp3 생성기
#
#   tools\.venv\Scripts\python.exe tools\tts.py --engine google --state racing
#   tools\.venv\Scripts\python.exe tools\tts.py --engine google            (전부)
#   tools\.venv\Scripts\python.exe tools\tts.py --engine google --force    (이미 있어도 다시)
#
# data/narration.json 을 읽어 대본을 토막 단위로 쪼개 각각 mp3 로 뽑고,
# 그 경로를 다시 narration.json 의 files 에 써 넣는다. 앱 코드는 건드리지 않는다.
#
# 왜 토막별인가:
#   TTS 모델은 대화용으로 최적화돼 있어서 긴 침묵을 오류로 보고 자동으로 줄인다.
#   수면 나레이션은 그 침묵이 본질이다. 그래서 토막을 따로 뽑고 침묵은 앱이 넣는다.
#   덕분에 병합·무음삽입·인코딩이 전혀 필요 없다 (ffmpeg 불필요).

import argparse, asyncio, json, os, pathlib, sys
import edge_tts

# 쪼개는 규칙은 chunking.py 한 곳에만 둔다. audio.js 의 splitChunks 와 짝이다 —
# 생성기와 재생기가 다르게 쪼개면 파일과 침묵이 어긋난다.
from chunking import chunks as split_chunks

ROOT = pathlib.Path(__file__).parent.parent
MANIFEST = ROOT / "data" / "narration.json"
ENV_FILE = pathlib.Path(__file__).parent / ".env"
OUT_DIR = ROOT / "audio" / "narration"
# 층 이름을 고정하지 않는다. 상태마다 sequence 가 정한다 (3층·5층이 섞여 있다).
DEFAULT_LAYERS = ("intro", "body", "outro")

GOOGLE_URL = "https://texttospeech.googleapis.com/v1/text:synthesize"
GOOGLE_VOICE = "ko-KR-Chirp3-HD-Algieba"

# 확정 설정 (전부 귀로 고른 값).
#   속도 0.69  — 조음의 바닥. 그 아래로 내리면 자음이 뭉개져 "혀 꼬인" 소리가 난다.
#                남은 느림은 앱의 침묵에서 가져온다.
#   저역 +3@120 — 가슴 울림. 150~250 을 올리면 무게보다 먹먹함이 먼저 와서 "노인" 이 된다.
#   명료도 +3@3.8k — 자음 또렷함. 저역을 올렸으면 여기도 올려야 균형이 맞는다.
#   컴프        — 숨·입소리를 끌어올려 "가까이서 말하는" 느낌. 친밀감의 핵심.
# 피치는 건드리지 않는다 — 내리면 인공음이 생긴다 (voicefx.py 주석 참조).
VOICE_EQ = dict(bite_db=0.0, body_db=3.0, body_hz=120,
                clarity_db=3.0, clarity_hz=3800,
                air_db=0.0, compress=True, gain_db=-1.0)


def api_key(name):
    """tools/.env 또는 환경변수에서 읽는다. 절대 출력하지 않는다."""
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                if k.strip() == name:
                    return v.strip().strip("'\"")
    return os.environ.get(name)


def sentences(text):
    return [c for c, _ in split_chunks(text)]


def apply_fx(path, args):
    """합성 직후 제자리에서 EQ 를 건다. --no-fx 면 건너뛴다."""
    if getattr(args, "no_fx", False):
        return
    from voicefx import process
    tmp = path.with_suffix(".tmp.mp3")
    process(path, tmp, **VOICE_EQ)
    tmp.replace(path)


# ── 엔진 ──────────────────────────────────────────────────

async def edge_engine(text, path, args, session=None):
    await edge_tts.Communicate(text, args.voice, rate=args.rate, pitch=args.pitch).save(str(path))


async def eleven_engine(text, path, args, session):
    key = api_key("ELEVENLABS_API_KEY")
    if not key:
        raise RuntimeError(
            "ELEVENLABS_API_KEY 가 없습니다.\n"
            f"{ENV_FILE} 에 넣어 주세요 (이 파일은 git 에 올라가지 않습니다)."
        )
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{args.voice}"
    body = {
        "text": text,
        "model_id": args.model,
        "voice_settings": {
            "stability": args.stability,
            "similarity_boost": 0.75,
            "style": 0.0,
            "use_speaker_boost": False,
        },
    }
    async with session.post(url, json=body, headers={"xi-api-key": key}) as r:
        if r.status != 200:
            raise RuntimeError(f"HTTP {r.status} {(await r.text())[:300]}")
        path.write_bytes(await r.read())


async def google_engine(text, path, args, session):
    import base64
    key = api_key("GOOGLE_TTS_API_KEY")
    if not key:
        raise RuntimeError(
            "GOOGLE_TTS_API_KEY 가 없습니다.\n"
            f"{ENV_FILE} 에 넣어 주세요."
        )
    audio = {"audioEncoding": "MP3", "speakingRate": args.speed}
    # Chirp3-HD 는 pitch 를 받지 않는다. 넣으면 400 이 난다.
    if "Chirp3" not in args.voice:
        audio["pitch"] = args.google_pitch
    body = {
        "input": {"text": text},
        "voice": {"languageCode": "ko-KR", "name": args.voice},
        "audioConfig": audio,
    }
    async with session.post(GOOGLE_URL, params={"key": key}, json=body) as r:
        if r.status != 200:
            raise RuntimeError(f"HTTP {r.status} {(await r.text())[:300]}")
        data = await r.json()
    path.write_bytes(base64.b64decode(data["audioContent"]))
    apply_fx(path, args)


ENGINES = {"edge": edge_engine, "elevenlabs": eleven_engine, "google": google_engine}


# ── 음성 목록 ─────────────────────────────────────────────

async def list_google_voices():
    import aiohttp
    key = api_key("GOOGLE_TTS_API_KEY")
    if not key:
        sys.exit(f"GOOGLE_TTS_API_KEY 가 없습니다. {ENV_FILE} 에 넣어 주세요.")
    async with aiohttp.ClientSession() as s:
        async with s.get("https://texttospeech.googleapis.com/v1/voices",
                         params={"key": key, "languageCode": "ko-KR"}) as r:
            if r.status != 200:
                sys.exit(f"HTTP {r.status} {(await r.text())[:400]}")
            data = await r.json()
    rows = sorted(data.get("voices", []), key=lambda v: (v["ssmlGender"], v["name"]))
    print(f"{'이름':<32} {'성별':<8} 샘플레이트")
    for v in rows:
        print(f"{v['name']:<32} {v['ssmlGender']:<8} {v.get('naturalSampleRateHertz', '?')}")
    males = [v for v in rows if v["ssmlGender"] == "MALE"]
    print(f"\n총 {len(rows)}개 · 남성 {len(males)}개")


async def list_eleven_voices():
    import aiohttp
    key = api_key("ELEVENLABS_API_KEY")
    if not key:
        sys.exit(f"ELEVENLABS_API_KEY 가 없습니다. {ENV_FILE} 에 넣어 주세요.")
    async with aiohttp.ClientSession() as s:
        async with s.get("https://api.elevenlabs.io/v1/voices", headers={"xi-api-key": key}) as r:
            if r.status != 200:
                sys.exit(f"HTTP {r.status} {(await r.text())[:300]}")
            data = await r.json()
        async with s.get("https://api.elevenlabs.io/v1/user/subscription",
                         headers={"xi-api-key": key}) as r:
            sub = await r.json() if r.status == 200 else {}

    print(f"{'voice_id':<24} {'이름':<22} 라벨")
    for v in data.get("voices", []):
        labels = ", ".join(f"{k}={x}" for k, x in (v.get("labels") or {}).items())
        print(f"{v['voice_id']:<24} {v['name']:<22} {labels}")
    if sub:
        used, lim = sub.get("character_count", 0), sub.get("character_limit", 0)
        print(f"\n이번 달 사용량 {used:,} / {lim:,} 자  (남은 {lim - used:,})")


# ── 본체 ──────────────────────────────────────────────────

async def synth(text, path, args, sem, session):
    async with sem:
        for attempt in range(3):
            try:
                await ENGINES[args.engine](text, path, args, session)
                return path.stat().st_size
            except Exception as e:  # 네트워크가 가끔 끊긴다. 조용히 재시도.
                if attempt == 2:
                    print(f"  실패 {path.name}: {e}", file=sys.stderr)
                    return 0
                await asyncio.sleep(1.5 * (attempt + 1))


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--state", help="한 상태만 (racing, anxious, wired, awoken, unknown, calm, nap)")
    ap.add_argument("--engine", choices=list(ENGINES), default="google")
    ap.add_argument("--voice", default=None, help="Edge/Google: 음성 이름 / ElevenLabs: voice_id")
    ap.add_argument("--rate", default="-10%", help="Edge 전용")
    ap.add_argument("--pitch", default="-8Hz", help="Edge 전용")
    ap.add_argument("--model", default="eleven_multilingual_v2", help="ElevenLabs 전용")
    ap.add_argument("--stability", type=float, default=0.55, help="ElevenLabs 전용")
    ap.add_argument("--speed", type=float, default=0.69, help="Google 전용 speakingRate")
    ap.add_argument("--google-pitch", type=float, default=-2.0, help="Google 전용 (Chirp3 는 무시)")
    ap.add_argument("--no-fx", action="store_true", help="EQ 후처리를 건너뛴다")
    ap.add_argument("--list-voices", action="store_true", help="음성 목록만 출력")
    ap.add_argument("--force", action="store_true", help="이미 있는 파일도 다시 만든다")
    ap.add_argument("--jobs", type=int, default=4)
    args = ap.parse_args()

    if args.voice is None:
        args.voice = {"edge": "ko-KR-HyunsuMultilingualNeural",
                      "google": GOOGLE_VOICE}.get(args.engine, "")

    if args.list_voices:
        await (list_google_voices() if args.engine == "google" else list_eleven_voices())
        return

    if args.engine != "edge" and not args.voice:
        sys.exit(f"--voice 가 필요합니다.\n"
                 f"  tools\\.venv\\Scripts\\python.exe tools\\tts.py --engine {args.engine} --list-voices")

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    states = manifest["states"]
    targets = [args.state] if args.state else list(states)
    for s in targets:
        if s not in states:
            sys.exit(f"그런 상태가 없습니다: {s}\n있는 것: {', '.join(states)}")

    sem = asyncio.Semaphore(args.jobs)
    plan = []

    for sid in targets:
        state = states[sid]
        (OUT_DIR / sid).mkdir(parents=True, exist_ok=True)
        for layer in state.get("sequence", DEFAULT_LAYERS):
            for piece in state.get(layer, []):
                parts = sentences(piece.get("text"))
                if not parts:
                    continue
                files = []
                for i, part in enumerate(parts):
                    path = OUT_DIR / sid / f"{piece['id']}-{i}.mp3"
                    files.append(f"audio/narration/{sid}/{path.name}")
                    if args.force or not path.exists():
                        plan.append((part, path))
                piece["files"] = files

    detail = {
        "edge": f"속도 {args.rate} · 톤 {args.pitch}",
        "elevenlabs": f"모델 {args.model} · 안정성 {args.stability}",
        "google": f"속도 {args.speed}" + ("" if args.no_fx else " · EQ 적용"),
    }[args.engine]
    print(f"[{args.engine}] 음성 {args.voice} · {detail}")
    print(f"상태 {len(targets)}개 · 새로 만들 파일 {len(plan)}개\n")

    import aiohttp
    async with aiohttp.ClientSession() as session:
        tasks = [synth(t, p, args, sem, session) for t, p in plan]
        sizes = await asyncio.gather(*tasks) if tasks else []

    ok = sum(1 for s in sizes if s)
    total = sum(sizes)

    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"\n생성 {ok}/{len(plan)}개, {total/1024/1024:.1f}MB")
    print(f"매니페스트 갱신: {MANIFEST.relative_to(ROOT)}")
    if ok < len(plan):
        print("일부 실패했습니다. 같은 명령을 다시 실행하면 빠진 것만 채웁니다.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":   # 다른 스크립트가 api_key 만 가져다 쓸 때 본체가 돌면 안 된다
    asyncio.run(main())
