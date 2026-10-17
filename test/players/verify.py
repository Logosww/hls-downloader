"""Assert measured player contracts and produce a portable, compact evidence record.

Run after all player probes. Intentional incompatibilities are asserted separately
from supported playback. Never substitute queryCapability() for these observations.
"""
import array
import hashlib
import json
import pathlib
import re
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[2] / 'test-results/players'


def load(name):
    path = ROOT / (name + '.json')
    if name != 'manifest':
        assert path.stat().st_mtime >= (ROOT / 'manifest.json').stat().st_mtime, ('Stale player report', name)
    return json.loads(path.read_text())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


manifest = load('manifest')
names = {entry['name'] for entry in manifest['entries']}
assert len(names) == 10
summary = {'engine': manifest['engine'], 'fixtureCreatedAt': manifest['createdAt'],
           'scope': 'M4 local macOS arm64 player acceptance; not M5 or a release qualification',
           'fixtures': [], 'players': {}, 'evidenceHashes': {}}
for entry in manifest['entries']:
    media = ROOT / entry['file']
    # Independent FFmpeg decode verifies every A/V stream, not only the default.
    subprocess.run(['ffmpeg', '-v', 'error', '-xerror', '-i', str(media),
                    '-map', '0:v?', '-map', '0:a?', '-f', 'null', '-'], check=True)
    measured = {'name': entry['name'], 'sha256': digest(media), 'decoded': True}
    if entry['profile'] in ('avc', 'wvtt-plain', 'wvtt-settings'):
        tones = []
        for i, expected in enumerate((880, 1760)):
            pcm = subprocess.check_output([
                'ffmpeg', '-v', 'error', '-i', str(media), '-map', '0:a:' + str(i),
                '-ss', '0.2', '-t', '1', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'])
            samples = array.array('f', pcm)
            assert len(samples) == 48000
            frequency = sum(a <= 0 < b for a, b in zip(samples, samples[1:]))
            assert abs(frequency - expected) <= 2, (entry['name'], i, frequency)
            tones.append(frequency)
        measured['audioHz'] = tones
    summary['fixtures'].append(measured)

for runtime in ('chrome', 'safari'):
    report = load('browser-' + runtime)
    rows = report['results']
    files = [r for r in rows if r['transport'] == 'file']
    assert {r['name'] for r in files} == names
    for r in files:
        assert r.get('ended') and not r.get('error'), r
        if runtime == 'chrome':
            assert r['frames'] > 0 and not r['audio'] and not r['text'], r
        elif r['name'].startswith(('avc', 'wvtt')):
            assert len(r['audio']) == 2 and all(t['selected'] for t in r['audio']), r
            assert {t['language'] for t in r['audio']} == {'en', 'ja'}
            if r['name'].startswith('wvtt'):
                assert len(r['text']) == 2 and all(t['cues'] for t in r['text']), r
                if 'settings' in r['name']:
                    for track in r['text']:
                        assert any(q['position'] == 20 and q['line'] == 10 for q in track['cues'])
                        assert any(q['vertical'] == 'rl' for q in track['cues'])
    mse = [r for r in rows if r['transport'] == 'mse']
    assert len(mse) == 2
    for r in mse:
        if runtime == 'chrome':
            assert r.get('error') == 'Error: SourceBuffer error', r
        else:
            assert r.get('ended') and r['textTracks'] == 0, r
    mixed = next(r for r in rows if r['transport'] == 'shaka-mixed-mdat')
    assert mixed.get('code') == 3000 and mixed.get('error'), mixed
    side = next(r for r in rows if r['transport'] == 'shaka-sidecar')
    assert side.get('ended') and side.get('visible') and side['active'] == ['Hello sidecar'], side
    summary['players'][runtime] = {
        'runtime': report['runtime'], 'at': report['at'], 'fileResults': files,
        'mse': mse, 'shaka': {'version': side['version'], 'mixedMdatError': mixed['code'],
                             'externalVttActive': side['active'], 'externalVttEnded': side['ended']}}

rows = load('avfoundation')
assert len(rows) == 14 and {r['name'] for r in rows} == names
native = []
for r in rows:
    assert r['ended'] and r['frames'] > 0 and not r.get('error'), r
    if r['name'].startswith('wvtt'):
        assert len(r['subtitleOptions']) == 2 and len(r['audioOptions']) == 2
        expected = 'Hello player' if 'plain' in r['name'] else ('Hello' if r['subtitleSelection'] == 0 else 'こんにちは')
        assert expected in [c['text'] for c in r['cues']], r
    native.append({k: r[k] for k in ('name', 'subtitleSelection', 'ended', 'frames')}
                  | {'cueTexts': sorted(set(c['text'] for c in r['cues']))})
summary['players']['avfoundation'] = native

rows = load('iina')
assert len(rows) == 11 and {r['name'] for r in rows} == names | {'external-sidecar'}
iina = []
for r in rows:
    assert r['eof'] and r['screenshot']['error'] == 'success', r
    assert (ROOT / 'screenshots' / ('iina-' + r['name'] + '.png')).is_file()
    for selection in r['audioSelections']:
        assert selection['id'] == selection['selected'] and selection['codec'], r
    subtitles = [t for t in r['tracks'] if t['type'] == 'sub']
    if r['name'].startswith('wvtt'):
        assert not subtitles, r
    if r['name'] == 'external-sidecar':
        assert len(subtitles) == 1 and r['subtitleText'] == 'Hello sidecar', r
    iina.append({'name': r['name'], 'runtime': r['runtime'], 'eof': r['eof'],
                 'audioSelections': r['audioSelections'], 'subtitleTracks': len(subtitles),
                 'subtitleText': r['subtitleText']})
summary['players']['iina'] = iina

rows = load('vlc')
assert len(rows) == 10 and {r['name'] for r in rows} == names
vlc = []
for r in rows:
    decoded = int(re.search(r'video decoded\s*:\s*(\d+)', r['stats'])[1])
    displayed = int(re.search(r'frames displayed\s*:\s*(\d+)', r['stats'])[1])
    assert decoded > 0 and displayed > 0 and r['screenshots'], r
    assert 'state stopped' in r['endStatus'], r
    for filename in r['screenshots']:
        assert (ROOT / 'screenshots' / filename).is_file()
    for selection in r['selections']:
        assert re.search(r'\|\s+' + selection['id'] + r'\s+-[^\r\n]*\*', selection['state']), selection
    subtitle_count = sum(s['kind'] == 'strack' for s in r['selections'])
    if r['name'].startswith('wvtt'):
        assert subtitle_count == 2, r
    vlc.append({'name': r['name'], 'runtime': r['runtime'], 'decoded': decoded,
                'displayed': displayed, 'stoppedAfterPlayback': True,
                'selectedAudioIds': [s['id'] for s in r['selections'] if s['kind'] == 'atrack'],
                'selectedSubtitleIds': [s['id'] for s in r['selections'] if s['kind'] == 'strack'],
                'screenshots': r['screenshots']})
summary['players']['vlc'] = vlc
for filename in ('manifest.json', 'browser-chrome.json', 'browser-safari.json',
                 'avfoundation.json', 'iina.json', 'vlc.json'):
    summary['evidenceHashes'][filename] = digest(ROOT / filename)
(ROOT / 'acceptance.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False) + '\n')
print('PASS: 10 independently decoded files; Chrome/Safari 14 probes each; AVFoundation 14; IINA 11; VLC 10. Expected limitations retained.')
