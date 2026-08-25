# 나레이션 mp3 생성기 — VoxCPM2 판.
#
#   tools\.venv-voxcpm\Scripts\python.exe tools\tts_voxcpm.py
#   tools\.venv-voxcpm\Scripts\python.exe tools\tts_voxcpm.py --state racing
#   tools\.venv-voxcpm\Scripts\python.exe tools\tts_voxcpm.py --dry-run
#
# tts.py(Google/Edge/ElevenLabs) 와 나란히 두는 별도 생성기다. 합치지 않은 이유:
#   1. venv 가 다르다. VoxCPM 은 torch+CUDA 라 tools\.venv-voxcpm 에 따로 깔았다
#   2. 생성 단위가 다르다. tts.py 는 문장 하나 = 요청 하나인데,
#      VoxCPM 은 조각 전체를 통짜로 뽑고 무음에서 잘라야 한다 (아래 참조)
#
# ── 왜 통짜로 뽑아 자르는가 (2026-08-24) ──────────────────────────
# 문장별로 따로 생성하면 문장마다 발화 속도가 제각각이다. 실측 최대 2.06배 —
# 한 조각 안에서 마지막 문장만 갑자기 빨라지는 게 귀에 그대로 들렸다.
# 한 번의 생성 안에서는 속도가 저절로 균일하다.
# 시드를 바꿔 다시 뽑는 건 해결책이 아니다 — 시드가 목소리 자체를 바꾼다.
#
# ── 확정값 ────────────────────────────────────────────────────────
# 목소리  아래 DESIGN (voice design, 후보 비교 끝에 확정)
# 시드    42 고정. 바꾸면 목소리가 바뀐다
# EQ      걸지 않는다. 저역 부스트가 "늙은 교수" 소리의 원인이었다
# 쉼표    넣지 않는다. 문장 안 쉼은 귓속말을 부른다. 느림은 앱의 침묵에서 가져온다
#
# ── 자르기와 그 한계 ─────────────────────────────────────────────
# 통짜를 문장 수만큼 나눌 때, 무음 간격이 큰 순으로 자르는 방법을 먼저 썼다가
# 버렸다. 모델이 항상 우리가 쪼갠 자리에서 쉬지는 않는다 — 81조각 중 23개가
# 경계째로 밀렸고 2자짜리 "셋," 이 1.05초를 먹었다.
# 지금은 **글자 수 대비 길이가 가장 잘 맞는 묶음**을 고른다 (cut 참조).
#
# 그래도 못 자르는 경우가 남는다. 그때 곧장 문장별 생성으로 내려갔더니
# 속도 편차가 오히려 커졌다 (문장별 1.96배 vs 통짜 1.73배) — 문장별 생성이
# 편차의 주범이기 때문이다. 그래서 **반씩 쪼개 통짜로 다시 뽑는다**(render).
# 단위는 줄이되 통짜는 지킨다. 문장 하나까지 내려가는 건 정말 마지막이다.
#
# ── 속도 보정 ─────────────────────────────────────────────────────
# 자르기가 맞아도 모델이 고르지 않게 말한 조각이 남는다. 쪼개도 안 고쳐진다 —
# 말 자체가 그런 것이라서. 그래서 마지막에 튀는 토막만 시간축으로 당긴다.
# 폭은 좁게 묶는다(STRETCH_MIN). 크게 늘리면 자음이 뭉개지는 게 이 프로젝트의
# 오래된 결론이고, 여기서 하려는 건 전면 감속이 아니라 이웃과 보조를 맞추는 것뿐이다.
# 숫자 세기 토막은 건드리지 않는다 — 길이가 원래 다르고 앱이 1초 주기로 덮어쓴다.
#
# 조용히 넘어가는 선택지는 없다 — 파일과 침묵이 밀리면 앱 전체가 어긋난다
# (CLAUDE.md 가 경고하는 그것).

import argparse, json, pathlib, statistics, subprocess, sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from chunking import chunks as split_chunks, is_count

ROOT = pathlib.Path(__file__).parent.parent
MANIFEST = ROOT / "data" / "narration.json"
OUT_DIR = ROOT / "audio" / "narration"
DEFAULT_LAYERS = ("intro", "body", "outro")

SEED = 42
DESIGN = ("A calm man in his early 30s, soft low voice, "
          "speaking extremely slowly, quiet and soft-spoken, warm and intimate")
CFG, TIMESTEPS = 2.0, 10

TOP_DB = 40          # 무음 판정. 35~45 는 결과가 같았다
PACE_LO, PACE_HI = 0.55, 1.8    # 자르기 검증: 중앙값 대비 이 밖이면 잘못 잘린 것
# 경계로 인정할 최소 쉼. 이보다 짧은 자리는 모델이 쉰 게 아니라 에너지가 잠깐
# 흔들린 것뿐이라, 거기서 자르면 문장이 반토막 난다 (2026-08-25 조사 참조).
MIN_GAP_SEC = 0.15
# 조각 안에 이보다 긴 침묵이 남으면 그 조각은 문장 경계를 넘어간 것이다.
MAX_INNER_SEC = 0.6
# 속도 보정: 조각 안 초/글자를 중앙값의 ±PACE_BAND 안에 묶는다.
# 1.25 면 조각 내 최대 편차가 1.56배 — 승인된 미리듣기(1.53배) 수준이다.
PACE_BAND = 1.25
STRETCH_MIN = 0.75   # 이보다 크게 늘이지 않는다 (자음이 뭉개진다). 못 채우면 남긴다
SPREAD_WARN = 2.06   # 사용자가 "긴박하다"고 거부한 편차. 넘으면 더 쪼갠다
MAX_SPLIT = 3        # 강제 분할 한계. 더 가면 문장별 생성에 가까워져 되레 나빠진다
MP3_KBPS = 64
# 모델이 말하는 속도는 명상에 쓰기엔 빠르다 (초당 6.9음절). 굽기 직전에 늘린다.
# 1.25 배는 "너무 느리다", 1.0 은 "빠르다" 였고 1.12 로 정해졌다 (2026-08-26).
# 늘리기는 반드시 tempo() = ffmpeg atempo 로 한다 — librosa 는 쇳소리가 난다.
SLOW = 1.12


def cut(wav, rate, parts):
    """소리 구간을 문장 개수만큼 묶는다. 묶는 기준은 **글자 수 대비 길이**다.

    간격이 큰 순으로 자르는 방법을 먼저 썼는데 틀렸다. 모델이 항상 우리가
    쪼갠 자리에서 쉬지는 않는다 — "넷을 세며 들이쉽니다. 하나," 를 붙여 읽고
    엉뚱한 데서 쉬면 경계가 통째로 밀린다.

    그래서 간격 크기 대신 **각 조각이 제 글자 수만큼의 길이를 갖는가** 로 고른다.
    소리 구간을 순서대로 N 덩어리로 묶는 모든 경우 중 오차가 가장 작은 것을
    고르면 되고, 구간이 수십 개뿐이라 전부 따져도 금방이다.

    다만 길이만 보면 안 된다 (2026-08-25). 길이 비례만으로 고르면 모델이 안 쉰
    자리에도 경계가 찍히는데, check() 도 같은 길이 비례를 보기 때문에 그 판은
    **구조적으로 검사를 통과한다.** 실제로 배포본의 26% 가 남의 문장 조각을
    물고 있었다. 그래서 경계는 두 조건을 함께 만족해야 한다 —
      1. 그 자리에 실제로 쉼이 있을 것 (MIN_GAP_SEC)
      2. 조각 안에 문장 사이만 한 침묵이 남지 않을 것 (MAX_INNER_SEC)
    둘 다 못 지키면 None 을 돌려주고, render 가 반으로 쪼개 다시 뽑는다.
    """
    import librosa
    spans = librosa.effects.split(wav, top_db=TOP_DB,
                                  frame_length=2048, hop_length=512)
    want = len(parts)
    if len(spans) < want:
        return None
    if want == 1:
        return [(spans[0][0], spans[-1][1])]

    lens = [max(1, len(t)) for t, _ in parts]
    total_dur = spans[-1][1] - spans[0][0]
    exp = [total_dur * n / sum(lens) for n in lens]

    m = len(spans)
    gaps = [spans[k + 1][0] - spans[k][1] for k in range(m - 1)]
    min_gap = max(MIN_GAP_SEC * rate, 0.5 * statistics.median(gaps))
    # stop[a] = a 에서 시작한 조각이 넘을 수 없는 마지막 소리구간.
    # 긴 침묵을 삼키면 그 조각은 이미 다음 문장까지 먹은 것이다.
    stop = [m - 1] * m
    for a in range(m - 2, -1, -1):
        stop[a] = a if gaps[a] >= MAX_INNER_SEC * rate else stop[a + 1]

    INF = float("inf")
    # best[i][a] = 조각 i..N-1 을 소리구간 a..m-1 로 채울 때의 최소 오차
    best = [[INF] * (m + 1) for _ in range(want + 1)]
    pick = [[-1] * (m + 1) for _ in range(want + 1)]
    best[want][m] = 0.0
    for i in range(want - 1, -1, -1):
        for a in range(m - (want - i), -1, -1):
            for b in range(a, m - (want - i - 1)):
                if b > stop[a]:
                    break                      # 조각 안에 문장 사이만 한 침묵이 생겼다
                if b + 1 < m and gaps[b] < min_gap:
                    continue                   # 모델이 안 쉰 자리 — 경계로 못 쓴다
                rest = best[i + 1][b + 1]
                if rest == INF:
                    continue
                cost = abs((spans[b][1] - spans[a][0]) - exp[i]) / exp[i] + rest
                if cost < best[i][a]:
                    best[i][a] = cost
                    pick[i][a] = b
    if best[0][0] == INF:
        return None

    out, a = [], 0
    for i in range(want):
        b = pick[i][a]
        out.append((spans[a][0], spans[b][1]))
        a = b + 1
    return out


def check(spans, parts, rate):
    """잘못 잘린 토막을 찾는다 — 글자 수에 비해 터무니없이 길거나 짧은 것."""
    paces = [(e - s) / rate / max(1, len(t)) for (s, e), (t, _) in zip(spans, parts)]
    med = statistics.median(paces)
    return [t for (t, _), p in zip(parts, paces)
            if p < med * PACE_LO or p > med * PACE_HI]


def split_point(parts):
    """가운데에 가장 가까운 문장 끝. 문장 중간에서 자르면 억양이 끊긴다."""
    mid = len(parts) // 2
    ends = [i + 1 for i, (_, end) in enumerate(parts[:-1]) if end]
    return min(ends, key=lambda i: abs(i - mid)) if ends else mid


def render(model, torch, parts, rate):
    """parts 를 소리로 만든다. 반환: (parts 와 1:1 인 파형 목록, 생성 덩어리 수).

    통짜를 먼저 시도하고, 못 자르면 반으로 쪼개 각각 다시 통짜로 뽑는다.
    덩어리 수가 1 이면 조각 전체가 한 번에 나온 것 = 속도가 가장 고르다.
    """
    if len(parts) == 1:
        torch.manual_seed(SEED)
        return [model.generate(text=f"({DESIGN}){parts[0][0]}",
                               cfg_value=CFG, inference_timesteps=TIMESTEPS)], 1

    torch.manual_seed(SEED)
    joined = " ".join(t for t, _ in parts)
    wav = model.generate(text=f"({DESIGN}){joined}",
                         cfg_value=CFG, inference_timesteps=TIMESTEPS)
    spans = cut(wav, rate, parts)
    if spans is not None and not check(spans, parts, rate):
        return [wav[s:e] for s, e in spans], 1

    i = split_point(parts)
    left, ln = render(model, torch, parts[:i], rate)
    right, rn = render(model, torch, parts[i:], rate)
    return left + right, ln + rn


def render_split(model, torch, parts, rate, depth):
    """depth 단계만큼 강제로 반씩 쪼갠 뒤 각 덩어리를 render 한다.

    통짜가 잘 잘려도 그 안에서 속도가 앞뒤로 흐르는 조각이 있다 — 몸 훑기처럼
    비슷한 문장이 길게 이어지면 모델이 뒤로 갈수록 빨라진다 (0.229 → 0.106).
    보정 폭 안에서는 못 따라잡으니 흐름 자체를 잘라 줄인다.
    실측: 16문장 조각이 2단계에서 2.17 → 1.63배, 3단계에서 2.38 → 1.75배로 내려갔다.
    """
    if depth <= 0 or len(parts) <= 2:
        return render(model, torch, parts, rate)
    i = split_point(parts)
    left, ln = render_split(model, torch, parts[:i], rate, depth - 1)
    right, rn = render_split(model, torch, parts[i:], rate, depth - 1)
    return left + right, ln + rn


def voiced(w, rate):
    """침묵을 뺀 실제 발화 시간.

    속도는 반드시 이걸로 재야 한다 (2026-08-25). 파일 길이로 재면 남의 문장
    사이 침묵이 섞여 들어온 토막이 오히려 '길이가 맞는' 것으로 보이고,
    equalize 가 그걸 줄여서 흔적까지 지운다 — 배포본에서 실제로 그랬다.
    """
    import librosa
    sp = librosa.effects.split(w, top_db=TOP_DB, frame_length=2048, hop_length=512)
    return (sum(int(b - a) for a, b in sp) or len(w)) / rate


def spread(wavs, parts, rate):
    """숫자 세기 토막을 뺀 조각 내 속도 편차 (최대/최소)."""
    ps = [voiced(w, rate) / len(t) for w, (t, _) in zip(wavs, parts) if not is_count(t)]
    return max(ps) / min(ps) if len(ps) >= 2 else 1.0


def tempo(samples, rate, factor, ffmpeg):
    """시간축만 바꾼다. factor > 1 이면 빨라진다.

    librosa 의 time_stretch 는 위상 보코더라 사람 목소리에서 쇳소리가 난다
    (2026-08-25 에 사용자가 잡아냈다). ffmpeg atempo 는 시간 영역 WSOLA 라
    같은 배수에서도 훨씬 깨끗하다. ffmpeg 는 어차피 굽는 데 쓰고 있다.
    """
    p = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error",
         "-f", "f32le", "-ar", str(rate), "-ac", "1", "-i", "pipe:0",
         "-filter:a", f"atempo={max(0.5, min(2.0, factor)):.6f}",
         "-f", "f32le", "-ar", str(rate), "-ac", "1", "pipe:1"],
        input=samples.astype("float32").tobytes(),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.decode("utf-8", "replace")[:300])
    import numpy as np
    return np.frombuffer(p.stdout, dtype="float32")


def equalize(wavs, parts, rate):
    """튀는 토막만 시간축으로 당겨 이웃과 보조를 맞춘다. 반환: (파형, 고친 수)."""
    import imageio_ffmpeg
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    idx = [i for i, (t, _) in enumerate(parts) if not is_count(t)]
    if len(idx) < 3:
        return wavs, 0
    pace = {i: voiced(wavs[i], rate) / len(parts[i][0]) for i in idx}
    med = statistics.median(pace.values())
    lo, hi = med / PACE_BAND, med * PACE_BAND
    fixed = 0
    for i in idx:
        want = lo if pace[i] < lo else hi if pace[i] > hi else None
        if want is None:
            continue
        # r < 1 이면 늘이고(느려지고), r > 1 이면 줄인다
        r = max(STRETCH_MIN, min(1 / STRETCH_MIN, pace[i] / want))
        if abs(r - 1) < 0.02:
            continue
        wavs[i] = tempo(wavs[i], rate, r, ffmpeg)
        fixed += 1
    return wavs, fixed


def to_mp3(ffmpeg, samples, rate, path):
    """float32 PCM 을 파이프로 넘겨 mp3 로 굽는다. 임시 파일을 만들지 않는다."""
    if SLOW != 1.0:
        samples = tempo(samples, rate, 1 / SLOW, ffmpeg)
    p = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
         "-f", "f32le", "-ar", str(rate), "-ac", "1", "-i", "pipe:0",
         "-c:a", "libmp3lame", "-b:a", f"{MP3_KBPS}k", str(path)],
        input=samples.astype("float32").tobytes(),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.decode("utf-8", "replace")[:300])
    return path.stat().st_size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--state", help="한 상태만")
    ap.add_argument("--force", action="store_true", help="이미 있어도 다시 만든다")
    ap.add_argument("--dry-run", action="store_true", help="생성 없이 계획만 본다")
    args = ap.parse_args()

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    states = manifest["states"]
    targets = [args.state] if args.state else list(states)
    for s in targets:
        if s not in states:
            sys.exit(f"그런 상태가 없습니다: {s}\n있는 것: {', '.join(states)}")

    plan = []
    for sid in targets:
        (OUT_DIR / sid).mkdir(parents=True, exist_ok=True)
        state = states[sid]
        for layer in state.get("sequence", DEFAULT_LAYERS):
            for piece in state.get(layer, []):
                parts = split_chunks(piece.get("text", ""))
                if not parts:
                    continue
                paths = [OUT_DIR / sid / f"{piece['id']}-{i}.mp3"
                         for i in range(len(parts))]
                piece["files"] = [f"audio/narration/{sid}/{p.name}" for p in paths]
                if args.force or not all(p.exists() for p in paths):
                    plan.append((f"{sid}/{layer}/{piece['id']}", parts, paths))

    print(f"상태 {len(targets)}개 · 새로 만들 조각 {len(plan)}개 "
          f"(파일 {sum(len(p[2]) for p in plan)}개)")
    if args.dry_run:
        for name, parts, _ in plan:
            print(f"  {name:<26} 문장 {len(parts)}")
        return

    import torch, imageio_ffmpeg
    from voxcpm import VoxCPM
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()

    print("모델 로드 중...")
    model = VoxCPM.from_pretrained("openbmb/VoxCPM2", load_denoiser=False)
    rate = model.tts_model.sample_rate
    print(f"로드 완료 · {rate}Hz · seed{SEED}")
    print()

    total = 0
    wide, splits = [], []
    for n, (name, parts, paths) in enumerate(plan, 1):
        wavs, blocks = render(model, torch, parts, rate)
        before = spread(wavs, parts, rate)
        wavs, fixed = equalize(wavs, parts, rate)
        after = spread(wavs, parts, rate)
        # 아직 고르지 않으면 더 잘게 쪼개 본다. 나아질 때만 바꾼다.
        depth = 1
        while after > SPREAD_WARN and depth < MAX_SPLIT and len(parts) > 3:
            depth += 1
            w2, b2 = render_split(model, torch, parts, rate, depth)
            w2, f2 = equalize(w2, parts, rate)
            a2 = spread(w2, parts, rate)
            if a2 < after:
                wavs, blocks, fixed, after = w2, b2, f2, a2
        total += sum(to_mp3(ffmpeg, w, rate, p) for w, p in zip(wavs, paths))
        if blocks > 1:
            splits.append((name, blocks))
        if after > SPREAD_WARN:
            wide.append((name, after))
        print(f"  [{n}/{len(plan)}] {name:<26} 문장 {len(parts):>2} · "
              f"덩어리 {blocks} · 편차 {before:.2f}→{after:.2f}배 · 보정 {fixed}개")

    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                        encoding="utf-8")
    print()
    print(f"조각 {len(plan)}개 · {total / 1024 / 1024:.1f}MB")
    print(f"매니페스트 갱신: {MANIFEST.relative_to(ROOT)}")
    if splits:
        print(f"통짜로 못 뽑아 쪼갠 조각 {len(splits)}개 "
              f"(덩어리 수가 클수록 속도가 덜 고르다):")
        for name, b in sorted(splits, key=lambda x: -x[1])[:8]:
            print(f"  {name}: {b}덩어리")
    if wide:
        print(f"편차 {SPREAD_WARN}배를 여전히 넘는 조각 {len(wide)}개:", file=sys.stderr)
        for name, sp in sorted(wide, key=lambda x: -x[1]):
            print(f"  {name}: {sp:.2f}배", file=sys.stderr)
        sys.exit(1)
    print(f"편차 {SPREAD_WARN}배 초과: 없음")


if __name__ == "__main__":      # tools/test_cut.py 가 cut() 만 가져다 쓴다
    main()
