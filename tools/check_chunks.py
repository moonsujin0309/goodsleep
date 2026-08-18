# 쪼갠 결과를 눈으로 확인한다. 잘못 끊기면 오히려 어색해지므로 생성 전에 본다.
#   tools\.venv\Scripts\python.exe tools\check_chunks.py [상태]

import json, pathlib, sys
from chunking import chunks

state_id = sys.argv[1] if len(sys.argv) > 1 else "racing"
m = json.loads((pathlib.Path(__file__).parent.parent / "data" / "narration.json")
               .read_text(encoding="utf-8"))
st = m["states"][state_id]

for layer in st["sequence"]:
    piece = st[layer][0]
    print(f"--- {layer} {piece['id']} ---")
    for text, end in chunks(piece["text"]):
        print(("  |" if end else "  ·") + " " + text)
    print()

total = sum(len(chunks(p["text"])) for l in st["sequence"] for p in st[l])
longest = max((c for l in st["sequence"] for p in st[l] for c, _ in chunks(p["text"])), key=len)
print(f"전체 토막 {total}개 · 가장 긴 토막 {len(longest)}자: {longest}")
