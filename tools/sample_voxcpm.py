# VoxCPM2 로 명상용 남성 목소리를 찾는다 (voice design).
#
#   tools\.venv-voxcpm\Scripts\python.exe tools\sample_voxcpm.py
#
# Google Chirp3-HD 는 정해진 30개 중에서 고르는 방식이라 남성 16개를 다 써도
# "차분한 명상 톤" 이 없었다. VoxCPM 은 목소리를 말로 묘사해서 만든다 —
# 고르는 게 아니라 주문하는 쪽이라 후보 개수에 갇히지 않는다.
#
# 묘사는 영어로 쓴다. 본문만 한글이면 된다 (모델이 그렇게 학습돼 있다).
#
# ── 1차 (2026-08-24) · 방향 잡기 ──────────────────────────────────
# 묘사 6종을 흩뿌렸다. 사용자 판정:
#   01-hushed  "제일 나음, 조금 더 느려야"   04-guide   "완전 별로"
#   02-bedtime "괜찮은데 좀 빠름"            05-tender  "힘이 있어서 제외"
#   03-close   "괜찮은데 힘이 없음"          06-night   "조급해서 제외"
# 읽는 법: 힘의 세기는 01 이 맞다. 더 빼면 03, 더 넣으면 05 가 된다.
#
# ── 2차 · 속도를 어디서 벌 것인가 ─────────────────────────────────
# 속도 구절만 바꿔봤다 (시드 42 고정): 11.4~16.0초. 폭이 4.6초뿐이고,
# "at half his normal speed" 처럼 세게 밀면 속도가 아니라 톤으로 간다.
# 시드만 바꿔봤다 (묘사 고정): 7.8 / 13.6 / 17.8초. 폭이 10초로 더 크다.
#   → 그런데 사용자 판정이 "s7 너무 싫다 · s123 이상하다" 였다.
#     시드는 속도만이 아니라 목소리 자체를 바꾼다. 속도 조절 수단이 아니다.
#   → **시드는 42 로 못 박는다.** 채택 묘사는 2차 b (15.0초).
#
# ── 3차 (지금) · 쉼표로 마저 번다 ─────────────────────────────────
# 사용자: "r2-b 가 괜찮은듯. 중간중간 쉼표 들어가면 괜찮을거같아."
# 이 앱은 원래 문장 사이 침묵을 앱이 넣는다 (CLAUDE.md 참조). 그러니 조각
# **안쪽**의 쉼만 텍스트로 만들면 된다. 묘사·시드를 고정하고 구두점만 움직인다.
# ──────────────────────────────────────────────────────────────────

import pathlib, sys

OUT = pathlib.Path(__file__).parent.parent / "audio" / "_samples" / "voxcpm"
PREFIX = "r3"      # 앞 회차 파일을 지우지 않는다. 이 접두사만 새로 쓴다
SEED = 42          # 2차에서 확정. 바꾸면 목소리가 바뀐다

# 2차 b 묘사. 글자도 바꾸지 않는다.
DESIGN = ("A calm man in his early 30s, soft low voice, speaking extremely "
          "slowly, with long pauses between phrases, almost whispering, "
          "warm and intimate")

BASE = ("이제 몸을 훑어 가겠습니다. 발가락에서 시작합니다. "
        "발바닥이 넓어집니다. 종아리가 풀립니다. 손가락이 하나씩 펴집니다.")

# 낱말은 하나도 더하거나 빼지 않는다 — 구두점만 넣는다.
# 대본을 바꾸면 나레이션 정의 문서와 어긋나고, 그건 별도 결정이다.
TEXTS = [
    ("0-base", BASE),   # r2-b 재현 확인용. 15.0초가 다시 나와야 한다
    ("1-comma",
     "이제, 몸을 훑어 가겠습니다. 발가락에서, 시작합니다. "
     "발바닥이, 넓어집니다. 종아리가, 풀립니다. 손가락이 하나씩, 펴집니다."),
    ("2-comma-more",
     "이제, 몸을, 훑어, 가겠습니다. 발가락에서, 시작합니다. "
     "발바닥이, 넓어집니다. 종아리가, 풀립니다. 손가락이, 하나씩, 펴집니다."),
    ("3-ellipsis",
     "이제… 몸을 훑어 가겠습니다… 발가락에서 시작합니다… "
     "발바닥이 넓어집니다… 종아리가 풀립니다… 손가락이 하나씩 펴집니다…"),
    ("4-mixed",
     "이제, 몸을 훑어 가겠습니다… 발가락에서, 시작합니다… "
     "발바닥이, 넓어집니다… 종아리가, 풀립니다… 손가락이 하나씩, 펴집니다…"),
    # 실전 확인: 배포 파이프라인은 문장 하나가 조각 하나다. 긴 덩어리에서
    # 잘 되는 게 단문에서도 되는지는 따로 봐야 한다.
    ("5-short-plain", "발바닥이 넓어집니다."),
    ("6-short-comma", "발바닥이, 넓어집니다."),
]


def main():
    try:
        from voxcpm import VoxCPM
        import soundfile as sf
        import torch
    except ImportError as e:
        sys.exit(f"설치가 안 끝났습니다: {e}")

    OUT.mkdir(parents=True, exist_ok=True)
    for p in OUT.glob(f"{PREFIX}-*.wav"):
        p.unlink()

    print("모델 로드 중...")
    model = VoxCPM.from_pretrained("openbmb/VoxCPM2", load_denoiser=False)
    rate = model.tts_model.sample_rate
    print(f"로드 완료 · {rate}Hz · {len(TEXTS)}개 · seed{SEED} 고정"
          f"  (기준: r2-b 15.0초)\n")

    for name, text in TEXTS:
        torch.manual_seed(SEED)   # 2.0.3 에는 seed 인자가 없다. 전역으로 고정한다.
        wav = model.generate(text=f"({DESIGN}){text}",
                             cfg_value=2.0, inference_timesteps=10)
        sf.write(OUT / f"{PREFIX}-{name}.wav", wav, rate)
        print(f"  {name:<10} {len(wav) / rate:5.1f}초")

    print(f"\n{OUT}")


main()
