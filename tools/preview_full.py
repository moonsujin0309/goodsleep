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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--state", default="racing")
    ap.add_argument("--pick", type=int, default=0, help="층마다 몇 번째 조각을 쓸지")
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
            rate = rate or sr
            out.append(y)
            spoken += len(y) / sr
            if i < len(parts) - 1:
                if is_count(parts[i + 1][0]):
                    gap = max(0.2, COUNT_CADENCE - len(y) / sr)
                else:
                    gap = SENTENCE_GAP * sentence_scale(text) * lg * (1 if end else 0.45)
                out.append(np.zeros(int(gap * rate), dtype=y.dtype))
        if li < len(state.get("sequence", DEFAULT_LAYERS)) - 1:
            out.append(np.zeros(int(GAP_SECONDS * rate), dtype=np.float32))

    merged = np.concatenate(out)
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"full-{args.state}.mp3"
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
