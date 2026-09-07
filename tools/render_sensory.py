"""Render six sensory replacements without altering live narration until verified.

Run with .venv-voxcpm/Scripts/python.exe tools/render_sensory.py.
--apply is explicit: renders first, checks every file and spread, then atomically
updates only the named replacements in the latest manifest. Existing IDs/files
are never overwritten. Generated files remain candidates until listening QA.
"""
import argparse
import json
import os
import subprocess
from pathlib import Path
import tts_voxcpm as tts
from chunking import chunks

ROOT = Path(__file__).resolve().parents[1]
DRAFT = Path(__file__).with_name('racing-sensory-20260907.json')
REPORT = Path(__file__).with_name('racing-sensory-20260907-report.json')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--apply-existing', action='store_true',
                        help='Verify and apply candidates from the existing render report; never regenerates')
    args = parser.parse_args()
    draft = json.loads(DRAFT.read_text(encoding='utf-8'))
    plan = [(layer, p, chunks(p['text']))
            for layer, pieces in draft['replacements'].items() for p in pieces]
    print(f'{len(plan)} pieces / {sum(len(c) for _, _, c in plan)} chunks', flush=True)
    if args.dry_run:
        return
    if args.apply_existing:
        import numpy as np
        import imageio_ffmpeg
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        results = json.loads(REPORT.read_text(encoding='utf-8'))
        assert len(results) == len(plan) and all(r['passed'] for r in results)
        for (layer, piece, parts), result in zip(plan, results):
            assert result['id'] == piece['id'] and result['layer'] == layer
            assert result['chunks'] == len(parts) == len(result['files'])
            durations = []
            for i, filename in enumerate(result['files']):
                assert filename == f"audio/narration/{draft['state']}/{piece['id']}-{i}.mp3"
                decoded = subprocess.run([ffmpeg, '-v', 'error', '-i', str(ROOT / filename),
                                          '-f', 'f32le', '-ar', '48000', '-ac', '1', 'pipe:1'],
                                         capture_output=True, check=True)
                samples = np.frombuffer(decoded.stdout, dtype='float32')
                assert len(samples) > 4800 and np.isfinite(samples).all()
                assert .001 < np.sqrt(np.mean(samples ** 2)) < .3
                assert np.max(np.abs(samples)) < 1
                durations.append(len(samples) / 48000)
            assert abs(sum(durations) - result['seconds']) < .2
        apply_manifest(plan, results, draft['state'])
        print('54 MP3 decoded; levels, durations, paths and chunk counts verified. Applied atomically.')
        return
    assert tts.ANCHOR_WAV.is_file(), 'Required selected male voice anchor missing'
    import torch
    import numpy as np
    import imageio_ffmpeg
    from voxcpm import VoxCPM
    assert torch.cuda.is_available(), 'Local CUDA is required for this rendering run'
    # No model download or paid service: use the already cached local model only.
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    model = VoxCPM.from_pretrained('openbmb/VoxCPM2', load_denoiser=False)
    rate = model.tts_model.sample_rate
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    results = []
    output = ROOT / 'audio/narration' / draft['state']
    for layer, piece, parts in plan:
        paths = [output / f"{piece['id']}-{i}.mp3" for i in range(len(parts))]
        if any(p.exists() for p in paths):
            raise RuntimeError(f"Candidate files already exist: {piece['id']}; inspect before retry")
        wavs, blocks = tts.render(model, torch, parts, rate)
        wavs, fixed = tts.equalize(wavs, parts, rate)
        pace = tts.spread(wavs, parts, rate)
        for depth in range(2, tts.MAX_SPLIT + 1):
            if pace <= tts.SPREAD_WARN:
                break
            alternative, count = tts.render_split(model, torch, parts, rate, depth)
            alternative, adjustment = tts.equalize(alternative, parts, rate)
            candidate_pace = tts.spread(alternative, parts, rate)
            if candidate_pace < pace:
                wavs, blocks, fixed, pace = alternative, count, adjustment, candidate_pace
        wavs, gain = tts.level(wavs, parts, rate)
        assert len(wavs) == len(parts)
        for w in wavs:
            assert len(w) > rate * .1 and np.isfinite(w).all()
            assert np.abs(w).max() <= tts.PEAK_CEIL + 1e-5
        for w, path in zip(wavs, paths):
            tts.to_mp3(ffmpeg, w, rate, path)
            assert path.stat().st_size > 500
        result = dict(layer=layer, id=piece['id'], replaces=piece['replaces'],
                      chunks=len(parts), seconds=round(sum(len(w) / rate for w in wavs), 2),
                      spread=round(pace, 3), blocks=blocks, gain=round(gain, 3),
                      passed=pace <= tts.SPREAD_WARN,
                      files=[p.relative_to(ROOT).as_posix() for p in paths])
        results.append(result)
        REPORT.write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(result, ensure_ascii=False), flush=True)
    assert all(r['passed'] for r in results), 'Pace verification failed; live manifest untouched'
    if args.apply:
        apply_manifest(plan, results, draft['state'])
        print('All six replacements applied atomically', flush=True)
    else:
        print('Candidate audio ready. Live manifest untouched; listening QA required.', flush=True)


def apply_manifest(plan, results, state):
    manifest = ROOT / 'data/narration.json'
    data = json.loads(manifest.read_text(encoding='utf-8'))
    for (layer, piece, _), result in zip(plan, results):
        pool = data['states'][state][layer]
        indices = [i for i, old in enumerate(pool) if old['id'] == piece['replaces']]
        assert len(indices) == 1
        pool[indices[0]] = dict(id=piece['id'], text=piece['text'], files=result['files'])
    temporary = manifest.with_suffix('.sensory.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    os.replace(temporary, manifest)


if __name__ == '__main__':
    main()
