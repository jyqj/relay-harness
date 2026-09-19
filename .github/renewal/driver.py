"""Execute fixed-baseline source transformations and subsequent reviewed stages."""
from pathlib import Path
import json
import subprocess

root = Path(__file__).resolve().parent
source = (root / 'apply.py').read_text()
old = "edit(engine, '  ContextPurpose,\\n  ContextRetrievalPlan,', '  ContextRetrievalPlan,')"
new = "path = ROOT / engine\ntext = path.read_text()\npath.write_text(text.replace('  ContextPurpose,\\n  ContextRetrievalPlan,', '  ContextRetrievalPlan,', 1))"
assert source.count(old) == 1, 'fixed-baseline transformation drift'
source = source.replace(old, new)

def read_config(path):
    script = "import ts from 'typescript'; import fs from 'node:fs'; const p=process.argv[1]; const r=ts.parseConfigFileTextToJson(p,fs.readFileSync(p,'utf8')); if(r.error) throw Error(ts.flattenDiagnosticMessageText(r.error.messageText,'\\n')); console.log(JSON.stringify(r.config));"
    return json.loads(subprocess.check_output(['node', '--input-type=module', '-e', script, str(path)], text=True))

for before, after in [
    ("json.loads((ROOT / configfile).read_text())", "read_config(ROOT / configfile)"),
    ("json.loads((base / 'tsconfig.json').read_text())", "read_config(base / 'tsconfig.json')"),
    ("config = json.loads(path.read_text())", "config = read_config(path)"),
]:
    assert source.count(before) == 1, before
    source = source.replace(before, after)
namespace = {'__name__': '__renewal__', 'read_config': read_config}
exec(compile(source, str(root / 'apply.py'), 'exec'), namespace)
for stage in sorted((root / 'stages').glob('*.py')):
    print('APPLY_STAGE', stage.name, flush=True)
    exec(compile(stage.read_text(), str(stage), 'exec'), namespace)
print('ALL_REVIEWED_STAGES_APPLIED', flush=True)
