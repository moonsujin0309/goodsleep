# 합성된 목소리를 수면용으로 후처리한다.
#
# 왜 필요한가:
#   Google Chirp3-HD 는 pitch 파라미터를 받지 않는다 (넣으면 400).
#   ElevenLabs 도 pitch 조절이 없다. 모델이 주는 기본 톤 그대로 나온다.
#
# 피치 시프트는 쓰지 않는다. 두 방식 다 인공음이 생겼다:
#   asetrate + atempo — 스펙트럼이 통째로 내려가 포먼트까지 낮아진다 → "코맹맹이"
#   rubberband formant=preserved — 포먼트는 지켜지지만 위상이 뭉개진다 → "더 이상해짐"
# 음높이를 건드리는 순간 인공음이 따라온다. 그래서 EQ 만 쓴다.
#
# EQ 로 같은 목적을 이룬다. 음높이는 그대로 두고 인상만 바꾼다:
#   2~4kHz 감쇠  — 말의 날 선 느낌(프레즌스)이 여기 있다. 깎으면 "공격적"이 사라진다
#   150~250Hz 증폭 — 무게가 붙어 낮게 들린다. 실제 피치는 그대로다
#   6kHz 위 감쇠  — 치찰음이 눕는다. "멀리서 또박또박"이 "가까이서 조용히"가 된다
# 셋 다 위상을 크게 건드리지 않아 인공음이 생기지 않는다.

import subprocess
import imageio_ffmpeg

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()


def chain(bite_db=-5.0, bite_hz=3000, body_db=3.0, body_hz=180,
          rasp_db=0.0, rasp_hz=2000, clarity_db=0.0, clarity_hz=3800,
          air_db=-3.0, air_hz=6500, compress=False, gain_db=-1.0):
    """
    body_hz 는 120~150 이 안전하다. 150~250 을 올리면 무게보다 먹먹함이 먼저 온다
    (그게 "노인" 소리의 정체였다).
    rasp 는 거친 질감을 살리는 쪽 — 깎으면 매끈해지고 올리면 텍스처가 산다.
    compress 는 작은 소리(숨·입소리)를 끌어올려 "가까이서 말하는" 느낌을 만든다.

    clarity 는 자음 명료도(3~6kHz)를 올린다. 말 속도를 많이 낮추면 자음 조음이
    뭉개져 "혀 꼬인" 소리가 나는데, 저역 증폭이 그걸 마스킹해 더 심해진다.
    저역을 올렸다면 여기도 같이 올려야 균형이 맞는다.
    """
    parts = []
    if bite_db:
        parts.append(f"equalizer=f={bite_hz}:t=q:w=1.2:g={bite_db}")
    if clarity_db:
        parts.append(f"equalizer=f={clarity_hz}:t=q:w=1.6:g={clarity_db}")
    if rasp_db:
        parts.append(f"equalizer=f={rasp_hz}:t=q:w=1.4:g={rasp_db}")
    if body_db:
        parts.append(f"bass=g={body_db}:f={body_hz}:w=0.7")
    if air_db:
        parts.append(f"treble=g={air_db}:f={air_hz}")
    if compress:
        parts.append("acompressor=threshold=-22dB:ratio=3:attack=8:release=220:makeup=2")
    if gain_db:
        parts.append(f"volume={gain_db}dB")
    return ",".join(parts)


def process(src, dst, **kw):
    af = chain(**kw)
    cmd = [FFMPEG, "-y", "-i", str(src)]
    if af:
        cmd += ["-af", af]
    cmd += ["-b:a", "48k", "-ar", "24000", "-ac", "1", str(dst)]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.decode("utf-8", "replace")[-800:])
    return dst
