# 대본을 재생 단위로 쪼갠다. audio.js 의 splitChunks 와 같은 규칙이어야 한다 —
# 생성기와 재생기가 다르게 쪼개면 파일과 침묵이 어긋난다.
#
# 왜 잘게 쪼개는가:
#   말 속도에는 바닥이 있다. 0.69 아래로 내리면 자음 조음이 뭉개져 혀 꼬인 소리가 난다.
#   그래서 느림은 전부 쉼에서 가져와야 한다.
#   쉼표뿐 아니라 연결어미(~면 ~고 ~는데)에서도 끊는다. 한국어에서 그 자리가
#   원래 숨을 쉬는 자리라, 끊어도 어색하지 않고 오히려 자연스럽다.

import re

SENTENCE = re.compile(r"(?<=[.!?。])\s+")
CLAUSE = re.compile(r"(?<=,)\s+")
# 연결어미 뒤 — 여기가 한국어의 자연스러운 호흡 자리다.
# '서'는 뺀다 ('에서', '으로서' 같은 조사에서 잘못 끊긴다).
# Python 은 가변 길이 lookbehind 를 못 쓰므로(JS 는 된다) 직접 잘라낸다.
CONNECTIVE = re.compile(r"(면|고|며|는데|지만|다가|거나|니까)(\s+)")
HANGUL = re.compile(r"[가-힣]")
# '~다고', '~라고' 는 연결어미가 아니라 인용이다. 여기서 끊으면
# "몸은 안전하다고 / 판단합니다" 처럼 서술어가 반토막 난다.
QUOTATIVE = ("다", "라")


def _split_connective(s):
    out, last = [], 0
    for m in CONNECTIVE.finditer(s):
        head = m.start(1)
        if head == 0 or not HANGUL.match(s[head - 1]):
            continue
        if m.group(1) == "고" and s[head - 1] in QUOTATIVE:
            continue
        out.append(s[last:m.end(1)].strip())
        last = m.end()
    out.append(s[last:].strip())
    return [p for p in out if p]

CLAUSE_MIN = 8      # 이보다 짧은 토막은 앞에 붙인다
CLAUSE_SPLIT = 22   # 이보다 긴 문장은 쉼표에서 나눈다
# 연결어미 쪼개기는 시도했다가 버렸다. 문법적으로는 맞는 호흡 자리인데
# 실제로 들으면 툭툭 끊긴다 — 쉼표만 쪼갠 쪽이 확실히 나았다.
# 0 이면 끈다. 다시 시험하려면 20 쯤을 넣으면 된다.
CONNECT_SPLIT = 0


def sentences(text):
    return [s for s in (x.strip() for x in SENTENCE.split(text or "")) if s]


def _merge_short(parts):
    out = []
    for p in parts:
        if out and len(p) < CLAUSE_MIN:
            out[-1] += " " + p
        else:
            out.append(p)
    return out


def chunks(text):
    """[(토막, 문장끝인가)] 를 돌려준다."""
    out = []
    for s in sentences(text):
        if len(s) <= CLAUSE_SPLIT:
            out.append((s, True))
            continue

        parts = _merge_short([p for p in (x.strip() for x in CLAUSE.split(s)) if p])

        # 쉼표로 못 나눴거나 여전히 긴 토막은 연결어미에서 한 번 더 나눈다
        finer = []
        for p in parts:
            if CONNECT_SPLIT and len(p) > CONNECT_SPLIT:
                finer.extend(_merge_short(_split_connective(p)))
            else:
                finer.append(p)

        for i, p in enumerate(finer):
            out.append((p, i == len(finer) - 1))
    return out
