# 나레이션 mp3 생성기
#
#   tools\.venv\Scripts\python.exe tools\tts.py --state racing
#   tools\.venv\Scripts\python.exe tools\tts.py                 (전부)
#   tools\.venv\Scripts\python.exe tools\tts.py --force         (이미 있어도 다시)
#
# data/narration.json 을 읽어 조각을 문장 단위로 쪼개 각각 mp3 로 뽑고,
# 그 경로를 다시 narration.json 의 files 에 써 넣는다. 코드는 건드리지 않는다.
#
# 왜 문장별인가:
#   TTS 모델은 대화용으로 최적화돼 있어서 긴 침묵을 오류로 보고 자동으로 줄인다.
#   수면 나레이션은 그 침묵이 본질이다. 그래서 문장을 따로 뽑고 침묵은 앱이 넣는다.
#   덕분에 병합·무음삽입·인코딩이 전혀 필요 없다 (ffmpeg 불필요).

import argparse, asyncio, json, pathlib, re, sys
import edge_tts

ROOT = pathlib.Path(__file__).parent.parent
MANIFEST = ROOT / "data" / "narration.json"
OUT_DIR = ROOT / "audio" / "narration"
LAYERS = ("intro", "body", "outro")

# audio.js 의 splitSentences 와 같은 규칙.
# 다만 files 가 있으면 앱은 이 목록을 그대로 쓰므로 둘이 어긋나도 깨지지 않는다.
SPLIT = re.compile(r"(?<=[.!?。])\s+")


def sentences(text):
    return [s.strip() for s in SPLIT.split(text or "") if s.strip()]


async def synth(text, path, voice, rate, pitch, sem):
    async with sem:
        for attempt in range(3):
            try:
                await edge_tts.Communicate(text, voice, rate=rate, pitch=pitch).save(str(path))
                return path.stat().st_size
            except Exception as e:  # 네트워크가 가끔 끊긴다. 조용히 재시도.
                if attempt == 2:
                    print(f"  실패 {path.name}: {e}", file=sys.stderr)
                    return 0
                await asyncio.sleep(1.5 * (attempt + 1))


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--state", help="한 상태만 (racing, anxious, wired, awoken, unknown, calm, nap)")
    # 확정값. rate 를 크게 낮추면 타임스트레치라 억양이 뭉개진다 — -18%, -28% 는 못 들을 수준이었다.
    # 느린 느낌은 목소리가 아니라 문장 사이 침묵으로 만든다(app 설정의 sentenceGap).
    # pitch 는 타임스트레치가 아니라서 낮춰도 음질이 거의 안 상한다.
    ap.add_argument("--voice", default="ko-KR-HyunsuMultilingualNeural")
    ap.add_argument("--rate", default="-5%")
    ap.add_argument("--pitch", default="-8Hz")
    ap.add_argument("--force", action="store_true", help="이미 있는 파일도 다시 만든다")
    ap.add_argument("--jobs", type=int, default=4)
    args = ap.parse_args()

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    states = manifest["states"]
    targets = [args.state] if args.state else list(states)
    for s in targets:
        if s not in states:
            sys.exit(f"그런 상태가 없습니다: {s}\n있는 것: {', '.join(states)}")

    sem = asyncio.Semaphore(args.jobs)
    tasks, plan = [], []

    for sid in targets:
        state = states[sid]
        (OUT_DIR / sid).mkdir(parents=True, exist_ok=True)
        for layer in LAYERS:
            for piece in state.get(layer, []):
                parts = sentences(piece.get("text"))
                if not parts:
                    continue
                files = []
                for i, sentence in enumerate(parts):
                    path = OUT_DIR / sid / f"{piece['id']}-{i}.mp3"
                    files.append(f"audio/narration/{sid}/{path.name}")
                    if args.force or not path.exists():
                        tasks.append(synth(sentence, path, args.voice, args.rate, args.pitch, sem))
                        plan.append(path.name)
                piece["files"] = files

    print(f"음성 {args.voice} · 속도 {args.rate} · 톤 {args.pitch}")
    print(f"상태 {len(targets)}개 · 새로 만들 파일 {len(tasks)}개\n")

    sizes = await asyncio.gather(*tasks) if tasks else []
    ok = sum(1 for s in sizes if s)
    total = sum(sizes)

    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"\n생성 {ok}/{len(tasks)}개, {total/1024/1024:.1f}MB")
    print(f"매니페스트 갱신: {MANIFEST.relative_to(ROOT)}")
    if ok < len(tasks):
        print("일부 실패했습니다. 같은 명령을 다시 실행하면 빠진 것만 채웁니다.", file=sys.stderr)
        sys.exit(1)


asyncio.run(main())
