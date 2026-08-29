# 한 상태를 통째로 미리듣는다 — 앱이 실제로 들려주는 그대로.
#
#   tools\.venv-voxcpm\Scripts\python.exe tools\preview_full.py --state racing
#
# 생성된 mp3 를 앱과 같은 규칙으로 이어붙인다:
#   층 순서대로 조각을 하나씩 고르고 (narration.js 의 조립),
#   조각 안 문장 사이에는 sentenceGap × sentenceScale × LAYER_GAP × kind,
#   조각과 조각 사이에는 gapSeconds.
# 값은 app.js 기본 설정과 같아야 한다 — 다르면 미리듣기가 거짓말을 한다.

import argparse, json, pathlib, subprocess, sys
import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from chunking import chunks as split_chunks, is_count

ROOT = pathlib.Path(__file__).parent.parent
MANIFEST = ROOT / "data" / "narration.json"
OUT = ROOT / "audio" / "_samples"

# app.js 기본 설정과 같은 값
GAP_SECONDS = 6.0
SENTENCE_GAP = 4.2
LAYER_GAP = {"settle": 1.0, "breath": 1.2, "release": 1.45, "drift": 1.75,
             "fade": 2.1, "intro": 1.0, "body": 1.2, "outro": 1.45}
DEFAULT_LAYERS = ("intro", "body", "outro")
COUNT_CADENCE = 1.0      # 숫자 세기는 정확히 1초 주기 (audio.js 와 같다)


def sentence_scale(text):
    n = len(text)
    if n < 7:
        return 0.45
    return min(1.0, max(0.82, n / 26))


def stretch(y, sr, factor, ffmpeg):
    """말을 factor 배로 늘린다 (1.12 면 12% 느리게).

    librosa 의 time_stretch 는 위상 보코더라 음성에서 쇳소리가 난다.
    ffmpeg 의 atempo 는 시간 영역(WSOLA)이라 같은 배수에서도 훨씬 깨끗하다.
    """
    p = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error",
         "-f", "f32le", "-ar", str(sr), "-ac", "1", "-i", "pipe:0",
         "-filter:a", f"atempo={1 / factor:.6f}",
         "-f", "f32le", "-ar", str(sr), "-ac", "1", "pipe:1"],
        input=y.astype("float32").tobytes(),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        sys.exit(p.stderr.decode("utf-8", "replace")[:300])
    return np.frombuffer(p.stdout, dtype=np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--state", default="racing")
    ap.add_argument("--pick", type=int, default=0, help="층마다 몇 번째 조각을 쓸지")
    # 말 자체를 늘려 본다. 침묵만으로는 안 잡히는 "말이 빠르다" 를 판단하려는 것.
    # 0.69 아래로 내리면 자음이 뭉개진다는 게 이 프로젝트의 오래된 결론이라,
    # 배수로 치면 1.45 배가 천장이다.
    ap.add_argument("--slow", type=float, default=1.0, help="말 길이 배수. 1.25 면 25%% 느리게")
    # 느림을 침묵에서 가져오는 쪽. 말을 늘리는 것과 달리 음질 손해가 없다.
    ap.add_argument("--gap", type=float, default=SENTENCE_GAP,
                    help=f"문장 사이 침묵 기준값 (기본 {SENTENCE_GAP}, app.js 설정과 같은 값)")
    args = ap.parse_args()

    import librosa, imageio_ffmpeg
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if args.state not in manifest["states"]:
        sys.exit(f"그런 상태가 없습니다: {args.state}")
    state = manifest["states"][args.state]

    out, rate = [], None
    spoken = 0.0
    print(f"[{args.state}]")
    for li, layer in enumerate(state.get("sequence", DEFAULT_LAYERS)):
        pool = state.get(layer, [])
        if not pool:
            continue
        piece = pool[args.pick % len(pool)]
        parts = split_chunks(piece["text"])
        files = piece.get("files") or []
        if len(files) != len(parts):
            sys.exit(f"{layer}/{piece['id']}: 파일 {len(files)}개 ≠ 문장 {len(parts)}개")

        lg = LAYER_GAP.get(layer, 1.0)
        print(f"  {layer:<8} {piece['id']:<4} 문장 {len(parts):>2} · 침묵배수 {lg}")
        for i, ((text, end), rel) in enumerate(zip(parts, files)):
            y, sr = librosa.load(str(ROOT / rel), sr=None, mono=True)
            # 숫자 세기는 늘리지 않는다. 앱이 1초 주기로 맞춰 재생하는 데다,
            # 한 음절짜리를 늘리면 늘어지는 신음처럼 들린다.
            if args.slow != 1.0 and not is_count(text):
                y = stretch(y, sr, args.slow, ffmpeg)
            rate = rate or sr
            out.append(y)
            spoken += len(y) / sr
            if i < len(parts) - 1:
                if is_count(parts[i + 1][0]):
                    gap = max(0.2, COUNT_CADENCE - len(y) / sr)
                else:
                    gap = args.gap * sentence_scale(text) * lg * (1 if end else 0.45)
                out.append(np.zeros(int(gap * rate), dtype=y.dtype))
        if li < len(state.get("sequence", DEFAULT_LAYERS)) - 1:
            out.append(np.zeros(int(GAP_SECONDS * rate), dtype=np.float32))

    merged = np.concatenate(out)
    OUT.mkdir(parents=True, exist_ok=True)
    tag = "" if args.slow == 1.0 else f"-slow{args.slow:g}"
    path = OUT / f"full-{args.state}{tag}.mp3"
    p = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
         "-f", "f32le", "-ar", str(rate), "-ac", "1", "-i", "pipe:0",
         "-c:a", "libmp3lame", "-b:a", "64k", str(path)],
        input=merged.astype("float32").tobytes(),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        sys.exit(p.stderr.decode("utf-8", "replace")[:400])

    total = len(merged) / rate
    print(f"\n  전체 {total / 60:.1f}분 ({total:.0f}초) · 말 {spoken:.0f}초 · "
          f"침묵 {total - spoken:.0f}초 · {path.stat().st_size // 1024}KB")
    print(f"  {path}")


main()
