# 이미 만들어진 나레이션 mp3 를 tts_voxcpm.SLOW 배로 다시 굽는다. 한 번만 쓰는 도구다.
#
#   tools\.venv-voxcpm\Scripts\python.exe tools\reslow.py
#   tools\.venv-voxcpm\Scripts\python.exe tools\reslow.py --dry-run
#
# 왜 있나: 감속을 정한 시점에 mp3 788개가 이미 있었다. 모델부터 다시 돌리면 두 시간인데
# 늘리는 것 자체는 ffmpeg 로 몇 분이면 된다. 새로 뽑는 파일은 tts_voxcpm 이 알아서
# 늘려 굽는다 (SLOW) — 이 스크립트는 그 이전에 만들어진 것들을 따라잡히게 하는 용도다.
#
# 두 번 돌리면 두 번 늘어난다. 그래서 굽기 전에 지금 속도를 재서, 이미 느려져 있으면
# 멈춘다. 실수로 한 번 더 돌려 음질을 깎는 일은 되돌릴 수 없다.

import argparse, json, pathlib, statistics, subprocess, sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from chunking import chunks as split_chunks
from tts_voxcpm import NORM_RMS, SLOW, TOP_DB, normalize, tempo

ROOT = pathlib.Path(__file__).parent.parent
MANIFEST = ROOT / "data" / "narration.json"
MP3_KBPS = 64
FAST_PACE = 0.152     # 늘리기 전 실측 중앙값 (초/음절)
SR = 16000


def pace(path, ffmpeg):
    """침묵을 뺀 초/음절. 파일이 이미 느려졌는지 판별하는 잣대."""
    import numpy as np, librosa
    r = subprocess.run(
        [ffmpeg, "-v", "error", "-i", str(path),
         "-f", "f32le", "-ac", "1", "-ar", str(SR), "pipe:1"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    y = np.frombuffer(r.stdout, dtype="float32").copy()
    if len(y) < SR // 10:
        return None
    sp = librosa.effects.split(y, top_db=TOP_DB, frame_length=2048, hop_length=512)
    return sum(int(b - a) for a, b in sp) / SR


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    # 음량 맞추기는 늘리기와 달리 여러 번 돌려도 같은 값으로 수렴한다 (목표를 향해
    # 맞추는 것이라 누적되지 않는다). 그래서 속도 안전장치를 건너뛴다.
    ap.add_argument("--normalize", action="store_true",
                    help="속도는 두고 발화 음량만 NORM_RMS 로 맞춘다")
    args = ap.parse_args()

    import numpy as np, imageio_ffmpeg
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    jobs = []
    for sid, state in manifest["states"].items():
        for layer in state.get("sequence", ("intro", "body", "outro")):
            for piece in state.get(layer, []):
                parts = split_chunks(piece.get("text", ""))
                for (text, _), rel in zip(parts, piece.get("files", [])):
                    p = ROOT / rel
                    if p.exists():
                        jobs.append((p, sum(1 for c in text if "가" <= c <= "힣")))

    if args.normalize:
        print(f"파일 {len(jobs)}개 · 발화 RMS 를 {NORM_RMS} 로 맞춥니다 (속도는 그대로)")
    else:
        # 이미 늘려져 있는지 본다. 표본 40개면 중앙값은 충분히 안정적이다.
        sample = [(p, h) for p, h in jobs[::max(1, len(jobs) // 40)] if h >= 4][:40]
        paces = [v / h for p, h in sample if (v := pace(p, ffmpeg))]
        now = statistics.median(paces)
        print(f"파일 {len(jobs)}개 · 지금 속도 {now:.3f}초/음절 "
              f"(늘리기 전 {FAST_PACE:.3f}, 목표 {FAST_PACE * SLOW:.3f})")
        if now > FAST_PACE * (1 + (SLOW - 1) / 2):
            sys.exit("이미 늘려져 있습니다. 한 번 더 늘리면 음질만 깎입니다 — 아무것도 안 했습니다.")
    if args.dry_run:
        print(f"다시 구울 파일 {len(jobs)}개")
        return

    import librosa
    for n, (p, _) in enumerate(jobs, 1):
        # sr=None 으로 원본 표본율을 그대로 받는다. 잘못 넘기면 음높이가 바뀐다.
        y, sr = librosa.load(str(p), sr=None, mono=True)
        if not args.normalize:
            y = tempo(y, sr, 1 / SLOW, ffmpeg)
        y = normalize(y, sr)
        w = subprocess.run(
            [ffmpeg, "-v", "error", "-y", "-f", "f32le", "-ar", str(sr), "-ac", "1",
             "-i", "pipe:0", "-c:a", "libmp3lame", "-b:a", f"{MP3_KBPS}k", str(p)],
            input=y.astype("float32").tobytes(),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if w.returncode != 0:
            sys.exit(w.stderr.decode("utf-8", "replace")[:300])
        if n % 100 == 0:
            print(f"  {n}/{len(jobs)}")
    print(f"{len(jobs)}개 다시 구웠습니다.")


if __name__ == "__main__":
    main()
