"""Execute fixed-baseline source transformations and subsequent reviewed stages."""
from pathlib import Path

root = Path(__file__).resolve().parent
source = (root / 'apply.py').read_text()
old = "edit(engine, '  ContextPurpose,\\n  ContextRetrievalPlan,', '  ContextRetrievalPlan,')"
new = "path = ROOT / engine\ntext = path.read_text()\npath.write_text(text.replace('  ContextPurpose,\\n  ContextRetrievalPlan,', '  ContextRetrievalPlan,', 1))"
assert source.count(old) == 1, 'fixed-baseline transformation drift'
source = source.replace(old, new)
namespace = {'__name__': '__renewal__'}
exec(compile(source, str(root / 'apply.py'), 'exec'), namespace)
for stage in sorted((root / 'stages').glob('*.py')):
    print('APPLY_STAGE', stage.name, flush=True)
    exec(compile(stage.read_text(), str(stage), 'exec'), namespace)
print('ALL_REVIEWED_STAGES_APPLIED', flush=True)
