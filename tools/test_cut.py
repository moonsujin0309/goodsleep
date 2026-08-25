# tts_voxcpm.cut() 자르기 규칙 검사.
#
#   tools\.venv-voxcpm\Scripts\python.exe tools\test_cut.py
#
# 이 버그(2026-08-25)는 "조용히 통과하는 검사" 때문에 났다 —
# 자르기가 길이 비례만 보고 경계를 찍었고, 검증도 같은 길이 비례를 봐서
# 잘못 잘린 판이 구조적으로 통과했다. 그래서 여기서는 길이 비례가
# **틀린 답을 가리키도록** 파형을 만들어 놓고, 그래도 쉼 위에서 자르는지 본다.

import pathlib, sys
import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from tts_voxcpm import cut

RATE = 16000
rng = np.random.default_rng(0)


def wave(plan):
    """plan: [('말', 초), ('쉼', 초), ...] 를 파형으로."""
    out = []
    for kind, sec in plan:
        n = int(sec * RATE)
        out.append(rng.normal(0, 0.3, n).astype("float32") if kind == "말"
                   else np.zeros(n, dtype="float32"))
    return np.concatenate(out)


def gap_at(wav, spans, i):
    """i 번 조각이 끝난 자리의 쉼 길이(초). 마지막 조각이면 None."""
    return None if i >= len(spans) - 1 else (spans[i + 1][0] - spans[i][1]) / RATE


# 1. 길이 비례는 짧은 흔들림을, 쉼은 긴 침묵을 가리킨다 → 쉼을 따라야 한다.
#    (0.05초 쪽에서 자르면 오차 0.39, 0.5초 쪽은 1.54 — 길이만 보면 반드시 진다)
w = wave([("말", 1.2), ("쉼", 0.05), ("말", 1.2), ("쉼", 0.5), ("말", 0.1)])
parts = [("여섯자짜리하나", True), ("여섯자짜리둘", True)]
sel = cut(w, RATE, parts)
assert sel is not None, "자를 수 있어야 한다"
# librosa 가 프레임 단위로 소리 끝을 조금 넉넉히 잡아 0.5초가 0.38초로 재진다.
# 후보는 0.05초와 0.5초 둘뿐이라 0.3 을 넘으면 긴 쪽을 고른 것이다.
assert gap_at(w, sel, 0) > 0.3, f"긴 쉼에서 잘라야 한다 (실제 {gap_at(w, sel, 0):.2f}초)"

# 2. 쓸 만한 쉼이 아예 없으면 억지로 자르지 말고 물러난다 (render 가 다시 뽑는다).
w = wave([("말", 1.0), ("쉼", 0.05), ("말", 1.0)])
assert cut(w, RATE, parts) is None, "쉼이 없으면 None 이어야 한다"

# 3. 어떻게 묶어도 조각 안에 문장 사이만 한 침묵이 남으면 역시 물러난다.
w = wave([("말", 0.5), ("쉼", 0.9), ("말", 0.5), ("쉼", 0.9), ("말", 0.5)])
assert cut(w, RATE, parts) is None, "조각 안에 긴 침묵이 남으면 None 이어야 한다"

# 4. 문장 하나짜리는 자를 게 없으니 통째로 돌려준다.
w = wave([("쉼", 0.2), ("말", 1.0), ("쉼", 0.2)])
sel = cut(w, RATE, [("한조각", True)])
assert len(sel) == 1 and sel[0][1] - sel[0][0] > 0.9 * RATE, "통짜 한 조각"

print("cut() 검사 4개 통과")
