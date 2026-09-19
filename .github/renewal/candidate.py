"""Create source Git objects only; branch publication remains an explicit connector action."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import urllib.request

BASE = 'ffe9921273a87d763708a56eaa44202ad9d5fbaf'
REPOSITORY = 'jyqj/relay-harness'
assert os.environ.get('GITHUB_REPOSITORY') == REPOSITORY
assert os.environ.get('GITHUB_REF') == 'refs/heads/work/renewal-build-20260919'
root = Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip())

def git(*args):
    return subprocess.check_output(['git', *args], cwd=root)

def api(path, data=None):
    request = urllib.request.Request('https://api.github.com/repos/' + REPOSITORY + '/' + path,
        data=None if data is None else json.dumps(data).encode(),
        headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'], 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28'})
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.load(response)

changed = git('diff', '--name-only', '-z').decode().split('\0')
created = git('ls-files', '--others', '--exclude-standard', '-z').decode().split('\0')
paths = sorted(set(changed + created) - {''})
entries = []
manifest = []
for path in paths:
    if path.startswith('.github/renewal/') or path in ['.github/workflows/renewal-implementation.yml', '.github/workflows/renewal-workspace.yml'] or '/.renewal-results/' in path:
        continue
    if not (path.startswith('relay-harness/') or path.startswith('.github/workflows/')):
        raise RuntimeError('unexpected candidate path: ' + path)
    if any(part in ['node_modules', '.git', 'lib', 'dist', 'coverage', 'playwright-report', 'test-results'] for part in Path(path).parts):
        raise RuntimeError('generated/runtime residue in candidate: ' + path)
    target = root / path
    if not target.exists() and not target.is_symlink():
        entries.append({'path': path, 'mode': '100644', 'type': 'blob', 'sha': None})
        manifest.append({'path': path, 'deleted': True})
        continue
    if target.is_symlink():
        content = os.readlink(target)
        mode = '120000'
    else:
        content = target.read_text()
        mode = '100755' if target.stat().st_mode & 0o111 else '100644'
    entries.append({'path': path, 'mode': mode, 'type': 'blob', 'content': content})
    manifest.append({'path': path, 'sha256': hashlib.sha256(content.encode()).hexdigest()})
assert entries, 'empty source candidate'
base = api('git/commits/' + BASE)
tree = api('git/trees', {'base_tree': base['tree']['sha'], 'tree': entries})
commit = api('git/commits', {
    'message': 'feat: evolve native context retrieval and workbench contracts',
    'tree': tree['sha'], 'parents': [BASE],
})
record = {'base': BASE, 'candidate': commit['sha'], 'tree': tree['sha'], 'run': os.environ.get('GITHUB_RUN_ID'), 'sourceCommit': os.environ.get('GITHUB_SHA'), 'files': manifest}
output = root / 'relay-harness/.renewal-results/candidate.json'
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(record, indent=2) + '\n')
print('CANDIDATE', commit['sha'], 'TREE', tree['sha'], 'FILES', len(entries), flush=True)
for item in manifest:
    print('CANDIDATE_FILE', json.dumps(item, ensure_ascii=False), flush=True)
