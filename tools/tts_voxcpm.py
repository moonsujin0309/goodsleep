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
# 한 번의 생성 안에서는 속도가 저절로 균일하다 (1.5배 안쪽).
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
# 그래도 못 고치는 경우가 남는다. 자르기는 모델이 실제로 쉰 자리에서만
# 가능해서, 아예 안 쉬고 붙여 읽어 버리면 나눌 지점이 없다. 숫자 세기가
# 많은 대본에서 그렇다.
#   → 그때는 **문장별로 따로 뽑는다.** 정렬이 정의상 정확해진다.
#     대신 그 조각 안에서는 속도가 고르지 않다. 목소리가 섞이는 것보다 낫고,
#     숫자 세기 구간은 어차피 앱이 1초 주기로 침묵을 덮어쓴다.
# 조용히 넘어가는 선택지는 없다 — 파일과 침묵이 밀리면 앱 전체가 어긋난다
# (CLAUDE.md 가 경고하는 그것).

import argparse, json, pathlib, statistics, subprocess, sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from chunking import chunks as split_chunks

ROOT = pathlib.Path(__file__).parent.parent
MANIFEST = ROOT / "data" / "narration.json"
OUT_DIR = ROOT / "audio" / "narration"
DEFAULT_LAYERS = ("intro", "body", "outro")

SEED = 42
DESIGN = ("A calm man in his early 30s, soft low voice, "
          "speaking extremely slowly, quiet and soft-spoken, warm and intimate")
CFG, TIMESTEPS = 2.0, 10

TOP_DB = 40          # 무음 판정. 35~45 는 결과가 같았다
PACE_LO, PACE_HI = 0.55, 1.8    # 조각 중앙값 대비 허용 배수
MP3_KBPS = 64


def cut(wav, rate, parts):
    """소리 구간을 문장 개수만큼 묶는다. 묶는 기준은 **글자 수 대비 길이**다.

    간격이 큰 순으로 자르는 방법을 먼저 썼는데 틀렸다. 모델이 항상 우리가
    쪼갠 자리에서 쉬지는 않는다 — "넷을 세며 들이쉽니다. 하나," 를 붙여 읽고
    엉뚱한 데서 쉬면 경계가 통째로 밀린다. 실제로 81조각 중 23개가 그렇게
    어긋났고, 2자짜리 "셋," 이 1.05초를 먹는 식이었다.

    그래서 간격 크기 대신 **각 조각이 제 글자 수만큼의 길이를 갖는가** 로 고른다.
    소리 구간을 순서대로 N 덩어리로 묶는 모든 경우 중 오차가 가장 작은 것을
    고르면 되고, 구간이 수십 개뿐이라 전부 따져도 금방이다.
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
    total_len = sum(lens)
    total_dur = spans[-1][1] - spans[0][0]
    exp = [total_dur * n / total_len for n in lens]

    m = len(spans)
    INF = float("inf")
    # best[i][a] = 조각 i..N-1 을 소리구간 a..m-1 로 채울 때의 최소 오차
    best = [[INF] * (m + 1) for _ in range(want + 1)]
    pick = [[-1] * (m + 1) for _ in range(want + 1)]
    best[want][m] = 0.0
    for i in range(want - 1, -1, -1):
        # 남은 조각 수만큼은 구간을 남겨 둬야 한다
        for a in range(m - (want - i), -1, -1):
            for b in range(a, m - (want - i - 1)):
                rest = best[i + 1][b + 1]
                if rest == INF:
                    continue
                dur = spans[b][1] - spans[a][0]
                cost = abs(dur - exp[i]) / exp[i] + rest
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
    """초/글자가 튀는 조각을 찾는다. 반환: (문제 목록, 편차배수)."""
    paces = [(e - s) / rate / max(1, len(t)) for (s, e), (t, _) in zip(spans, parts)]
    med = statistics.median(paces)
    bad = [(t, p) for (t, _), p in zip(parts, paces)
           if p < med * PACE_LO or p > med * PACE_HI]
    return bad, max(paces) / min(paces)


def to_mp3(ffmpeg, samples, rate, path):
    """float32 PCM 을 파이프로 넘겨 mp3 로 굽는다. 임시 파일을 만들지 않는다."""
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

    # 계획: 조각 하나 = 통짜 생성 한 번 = 파일 여러 개
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
                    plan.append((f"{sid}/{layer}/{piece['id']}",
                                 piece["text"], parts, paths))

    files = sum(len(p[3]) for p in plan)
    print(f"상태 {len(targets)}개 · 새로 만들 조각 {len(plan)}개 (파일 {files}개)")
    if args.dry_run:
        for name, _, parts, _ in plan:
            print(f"  {name:<26} 문장 {len(parts)}")
        return

    import numpy as np, torch, imageio_ffmpeg
    from voxcpm import VoxCPM
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()

    print("모델 로드 중...")
    model = VoxCPM.from_pretrained("openbmb/VoxCPM2", load_denoiser=False)
    rate = model.tts_model.sample_rate
    print(f"로드 완료 · {rate}Hz · seed{SEED}\n")

    done = total = 0
    failed = []
    fellback = []
    for n, (name, text, parts, paths) in enumerate(plan, 1):
        torch.manual_seed(SEED)
        wav = model.generate(text=f"({DESIGN}){text}",
                             cfg_value=CFG, inference_timesteps=TIMESTEPS)
        spans = cut(wav, rate, parts)
        bad = None
        if spans is not None:
            bad, spread = check(spans, parts, rate)
        if spans is None or bad:
            # 통짜에서 경계를 못 찾았다. 문장별로 다시 뽑으면 정렬은 정확해진다.
            why = "조각 부족" if spans is None else f"초/글자 튐 {len(bad)}개"
            size = 0
            for (t, _), path in zip(parts, paths):
                torch.manual_seed(SEED)
                w = model.generate(text=f"({DESIGN}){t}",
                                   cfg_value=CFG, inference_timesteps=TIMESTEPS)
                size += to_mp3(ffmpeg, w, rate, path)
            done += 1
            total += size
            fellback.append((name, why))
            print(f"  [{n}/{len(plan)}] {name:<26} 문장 {len(parts):>2} · "
                  f"문장별 생성으로 대체 ({why}) · {size // 1024}KB")
            continue
        size = sum(to_mp3(ffmpeg, wav[s:e], rate, p)
                   for (s, e), p in zip(spans, paths))
        done += 1
        total += size
        print(f"  [{n}/{len(plan)}] {name:<26} 문장 {len(parts):>2} · "
              f"{len(wav) / rate:5.1f}초 · 편차 {spread:.2f}배 · {size // 1024}KB")

    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                        encoding="utf-8")
    print(f"\n조각 {done}/{len(plan)} · {total / 1024 / 1024:.1f}MB")
    print(f"매니페스트 갱신: {MANIFEST.relative_to(ROOT)}")
    if fellback:
        print()
        print(f"통짜 자르기가 안 돼 문장별로 뽑은 조각 {len(fellback)}개 "
              f"(소리는 정상, 그 안에서 속도만 덜 고름):")
        for name, why in fellback:
            print(f"  {name}: {why}")
    if failed:
        print(f"\n실패 {len(failed)}개 — 이 조각들은 옛 파일이 그대로 남아 있습니다:",
              file=sys.stderr)
        for name, why in failed:
            print(f"  {name}: {why}", file=sys.stderr)
        sys.exit(1)


main()
