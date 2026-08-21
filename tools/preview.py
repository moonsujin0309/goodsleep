# 한 세션을 실제 들리는 대로 한 파일로 합친다.
#
#   tools\.venv\Scripts\python.exe tools\preview.py --state racing
#
# 앱은 대본을 토막 단위로 재생하고 사이에 침묵을 넣는다. 조각 파일만 따로 들으면
# 그 리듬이 전혀 느껴지지 않는다 — 이 스크립트는 앱과 똑같은 규칙으로 침묵을 넣어
# 실제 세션을 그대로 재현한다. 검수 전용이고 앱은 이 파일을 쓰지 않는다.

import argparse, json, pathlib, random, subprocess, sys
import imageio_ffmpeg
from chunking import chunks as split_chunks, is_count

ROOT = pathlib.Path(__file__).parent.parent
MANIFEST = ROOT / "data" / "narration.json"
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

# audio.js 의 LAYER_GAP 과 같아야 한다
LAYER_GAP = {
    "settle": 1.0, "breath": 1.2, "release": 1.45, "drift": 1.75, "fade": 2.1,
    "intro": 1.0, "body": 1.2, "outro": 1.45,
}
SENTENCE_GAP = 3.6   # app.js settings.sentenceGap 기본값
PIECE_GAP = 6.0      # app.js settings.gapSeconds 기본값


_durs = {}

def file_dur(path):
    """mp3 길이(초). ffprobe 가 없어서 ffmpeg -i 의 stderr 를 읽는다."""
    if path not in _durs:
        r = subprocess.run([FFMPEG, "-i", str(path)], capture_output=True).stderr.decode("utf-8", "replace")
        d = 0.0
        for line in r.splitlines():
            if "Duration:" in line:
                hh, mm, ss = line.split("Duration: ")[1][:11].split(":")
                d = int(hh) * 3600 + int(mm) * 60 + float(ss)
        _durs[path] = d
    return _durs[path]


def sentence_gap(text, layer, is_end=True):
    """audio.js 의 sentenceScale · LAYER_GAP 과 같은 규칙."""
    n = len(text)
    scale = 0.45 if n < 7 else min(1.0, max(0.82, n / 26))
    kind = 1.0 if is_end else 0.45      # 문장 안의 쉼표는 짧게
    return SENTENCE_GAP * scale * LAYER_GAP.get(layer, 1.0) * kind


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--state", default="racing")
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    if args.seed is not None:
        random.seed(args.seed)

    state = json.loads(MANIFEST.read_text(encoding="utf-8"))["states"][args.state]
    layers = state.get("sequence", ["intro", "body", "outro"])

    parts, total = [], 0.0
    for li, layer in enumerate(layers):
        pool = state.get(layer, [])
        if not pool:
            continue
        piece = random.choice(pool)
        files = piece.get("files") or []
        marks = split_chunks(piece["text"])
        print(f"  {layer:<8} {piece['id']:<4} 토막 {len(files)}개")
        for i, f in enumerate(files):
            path = ROOT / f
            if not path.exists():
                sys.exit(f"파일이 없습니다: {f}\n먼저 tools/tts.py 를 실행하세요.")
            parts.append(("file", path))
            if i < len(files) - 1:
                text, is_end = marks[i] if i < len(marks) else ("x" * 24, True)
                nxt = marks[i + 1][0] if i + 1 < len(marks) else ""
                # 숫자 세기는 정확히 1초 주기 — 방금 파일 길이를 빼고 쉰다 (audio.js 와 동일)
                g = max(0.2, 1.0 - file_dur(path)) if is_count(nxt) else sentence_gap(text, layer, is_end)
                parts.append(("gap", g))
                total += g
        if li < len(layers) - 1:
            parts.append(("gap", PIECE_GAP))
            total += PIECE_GAP

    out = pathlib.Path(args.out or (ROOT / "audio" / "_samples" / f"미리듣기-{args.state}.mp3"))
    out.parent.mkdir(parents=True, exist_ok=True)

    # concat 필터로 이어 붙인다. 침묵은 anullsrc 로 즉석 생성한다.
    inputs, filters, idx = [], [], 0
    for kind, val in parts:
        if kind == "file":
            inputs += ["-i", str(val)]
        else:
            inputs += ["-f", "lavfi", "-t", f"{val:.2f}", "-i", "anullsrc=r=24000:cl=mono"]
        filters.append(f"[{idx}:a]")
        idx += 1

    cmd = [FFMPEG, "-y", *inputs,
           "-filter_complex", "".join(filters) + f"concat=n={idx}:v=0:a=1[out]",
           "-map", "[out]", "-b:a", "48k", "-ar", "24000", "-ac", "1", str(out)]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        sys.exit(r.stderr.decode("utf-8", "replace")[-1500:])

    probe = subprocess.run([FFMPEG, "-i", str(out)], capture_output=True).stderr.decode("utf-8", "replace")
    dur = next((l.split("Duration: ")[1][:11] for l in probe.splitlines() if "Duration:" in l), "?")
    print(f"\n{out.name}  {out.stat().st_size/1024:.0f}KB  길이 {dur}  (침묵 {total:.0f}초 포함)")


main()
