// 합성 사운드를 파일로 렌더한다 — 검수용. 앱은 이 파일을 쓰지 않는다.
//
//   node tools/render_beds.mjs
//
// synth.js 는 순수 모듈이라 브라우저 없이 그대로 돌릴 수 있다.
// RMS·피크를 같이 찍는다 — 층을 새로 섞으면 밸런스가 틀어졌는지 여기서 먼저 본다.

import { renderBed, wavBytes, LENGTHS } from '../synth.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'audio', '_samples');
mkdirSync(outDir, { recursive: true });

console.log(`${'kind'.padEnd(10)} ${'길이'.padStart(4)} ${'RMS'.padStart(7)} ${'피크'.padStart(6)} ${'크기'.padStart(8)} 시간`);
for (const kind of Object.keys(LENGTHS)) {
  const t0 = Date.now();
  const bed = renderBed(kind);
  let sum = 0, peak = 0;
  for (const ch of [bed.left, bed.right]) {
    for (let i = 0; i < ch.length; i++) {
      sum += ch[i] * ch[i];
      peak = Math.max(peak, Math.abs(ch[i]));
    }
  }
  const rms = Math.sqrt(sum / (bed.left.length * 2));
  const bytes = wavBytes(bed);
  const file = path.join(outDir, `사운드-${kind}.wav`);
  writeFileSync(file, Buffer.from(bytes));
  console.log(`${kind.padEnd(10)} ${String(LENGTHS[kind]).padStart(3)}s ${rms.toFixed(4).padStart(7)} ${peak.toFixed(3).padStart(6)} ${(bytes.byteLength / 1048576).toFixed(1).padStart(6)}MB ${Date.now() - t0}ms`);
}
