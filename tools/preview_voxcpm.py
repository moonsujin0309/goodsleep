# VoxCPM 목소리로 "실제 앱에서 들리는 대로" 미리듣기를 만든다.
#
#   tools\.venv-voxcpm\Scripts\python.exe tools\preview_voxcpm.py
#
# 앱은 chunking 으로 쪼갠 조각을 하나씩 재생하고 그 사이에 침묵을 직접 넣는다.
# 침묵 공식은 audio.js `_speak` 와 같아야 한다:
#   sentenceGap × sentenceScale(문장) × LAYER_GAP[층] × kind
#
# ── 확정된 것 (2026-08-24) ────────────────────────────────────────
# 목소리   w2-soft (아래 DESIGN). 시드 42. 바꾸면 목소리가 바뀐다
# 여백     sentenceGap 3.2 → 4.2
#
# ── 왜 한 덩어리로 뽑아 자르는가 ──────────────────────────────────
# 사용자: "마지막에 갑자기 긴박해지네? 앞쪽 템포가 좋았어."
#   문장별로 따로 생성하면 조각마다 속도가 제각각이다. 실측:
#     0.235 / 0.133 / 0.204 / 0.128 / 0.114 초/글자  ← 최대 2배 차이
#   시드를 바꿔 다시 뽑는 건 안 된다 (시드가 목소리를 바꾼다, 검증됨).
#   쉼표로 뒤늦게 맞추는 것도 임시방편이고 귓속말을 다시 부른다.
#
#   원인은 "따로 생성" 자체다. 한 번의 생성 안에서는 속도가 저절로 균일하다 —
#   사용자가 좋다고 한 r2-b 가 바로 5문장을 한 번에 뽑은 것이었다.
#   그래서 **한 덩어리로 뽑고 무음에서 잘라** 조각 파일로 나눈다.
#   앱은 지금처럼 조각을 받아 사이에 침묵을 넣으면 된다. 재생 쪽은 안 바뀐다.
#
# ── 자르는 규칙 ───────────────────────────────────────────────────
# 무음 길이로 임계값을 정하면 안 된다. 실측(top_db=40)을 보면
#   문장 경계  1.19 · 0.94 · 1.19 · 0.87 초
#   문장 안 쉼 0.65 · 0.32 · 0.03 초
# 로 섞여 있어서 어떤 고정값을 잡아도 대본마다 어긋난다.
# 대신 **필요한 조각 수를 알고 있으니** 간격 큰 순으로 필요한 개수만 고른다.
# 개수가 반드시 맞고, 고른 것 중 최소와 버린 것 중 최대의 차이(여유)를
# 같이 재서 아슬아슬하면 경고한다 — 그게 잘못 잘렸는지 보는 신호다.
# ──────────────────────────────────────────────────────────────────

import pathlib, sys
import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from chunking import chunks as split_chunks

OUT = pathlib.Path(__file__).parent.parent / "audio" / "_samples" / "voxcpm"
SEED = 42

TEXT = ("이제 몸을 훑어 가겠습니다. 발가락에서 시작합니다. "
        "발바닥이 넓어집니다. 종아리가 풀립니다. 손가락이 하나씩 펴집니다.")

DESIGN = ("A calm man in his early 30s, soft low voice, "
          "speaking extremely slowly, quiet and soft-spoken, warm and intimate")

SENTENCE_GAP = 4.2
LAYER_GAP = {"settle": 1.0, "breath": 1.2, "release": 1.45,
             "drift": 1.75, "fade": 2.1}
LAYER = "release"

TOP_DB = 40          # 무음 판정. 35~45 는 결과가 같았다
SAFE_MARGIN = 0.15   # 경계와 비경계 간격 차이가 이보다 작으면 의심스럽다


def sentence_scale(text):
    """audio.js sentenceScale 과 같은 규칙."""
    n = len(text)
    if n < 7:
        return 0.45
    return min(1.0, max(0.82, n / 26))


def cut(wav, rate, want):
    """무음 간격이 큰 순으로 want-1 곳을 골라 자른다.

    반환: (조각 구간 리스트, 여유초). 소리 조각이 want 개보다 적으면 None.
    """
    import librosa
    spans = librosa.effects.split(wav, top_db=TOP_DB,
                                  frame_length=2048, hop_length=512)
    if len(spans) < want:
        return None, None
    gaps = sorted(((spans[i + 1][0] - spans[i][1], i)
                   for i in range(len(spans) - 1)), reverse=True)
    cuts = sorted(i for _, i in gaps[:want - 1])
    # 고른 것 중 가장 좁은 간격 vs 버린 것 중 가장 넓은 간격
    margin = ((gaps[want - 2][0] - gaps[want - 1][0]) / rate
              if len(gaps) >= want else float("inf"))

    pieces, start = [], 0
    for i in cuts:
        pieces.append((spans[start][0], spans[i][1]))
        start = i + 1
    pieces.append((spans[start][0], spans[-1][1]))
    return pieces, margin


def main():
    try:
        from voxcpm import VoxCPM
        import soundfile as sf
        import torch
    except ImportError as e:
        sys.exit(f"설치가 안 끝났습니다: {e}")

    parts = split_chunks(TEXT)
    OUT.mkdir(parents=True, exist_ok=True)

    print("모델 로드 중...")
    model = VoxCPM.from_pretrained("openbmb/VoxCPM2", load_denoiser=False)
    rate = model.tts_model.sample_rate

    torch.manual_seed(SEED)
    wav = model.generate(text=f"({DESIGN}){TEXT}",
                         cfg_value=2.0, inference_timesteps=10)
    print(f"로드 완료 · {rate}Hz · 통짜 {len(wav) / rate:.1f}초 생성\n")

    spans, margin = cut(wav, rate, len(parts))
    if spans is None:
        sys.exit(f"소리 조각이 {len(parts)}개보다 적습니다. 대본을 확인하세요.")

    print("── 잘린 조각 ──")
    pieces, paces = [], []
    for (s, e), (text, end) in zip(spans, parts):
        piece = wav[s:e]
        dur = len(piece) / rate
        pieces.append(piece); paces.append(dur / len(text))
        print(f"  {dur:4.1f}초 · {dur / len(text):.3f}초/글자  {text}")

    spread = max(paces) / min(paces)
    print(f"\n  편차 {min(paces):.3f}~{max(paces):.3f} ({spread:.2f}배)"
          f" · 자르기 여유 {margin:.2f}초"
          + ("  ⚠ 아슬아슬함" if margin < SAFE_MARGIN else ""))
    print("  (따로 생성했을 때는 2.06배였다)\n")

    lg = LAYER_GAP[LAYER]
    out, spoken = [], 0.0
    for i, ((text, end), piece) in enumerate(zip(parts, pieces)):
        out.append(piece); spoken += len(piece) / rate
        if i < len(parts) - 1:
            gap = SENTENCE_GAP * sentence_scale(text) * lg * (1 if end else 0.45)
            out.append(np.zeros(int(gap * rate), dtype=piece.dtype))
    merged = np.concatenate(out)
    sf.write(OUT / "cut-w2-soft.wav", merged, rate)
    print(f"  cut-w2-soft  전체 {len(merged) / rate:5.1f}초 · "
          f"말 {spoken:4.1f}초 · 침묵 {len(merged) / rate - spoken:5.1f}초")
    print(f"\n{OUT}")


main()
