import hashlib,json,re
from pathlib import Path
import argparse
parser=argparse.ArgumentParser(description='Collect and sanitize locally retained SolidWorks acceptance reports; requires original source reports.')
parser.add_argument('--source-root',required=True)
parser.add_argument('--output-root',default='preinstalled/solidworks')
args=parser.parse_args()
root=Path(args.source_root).resolve();out=Path(args.output_root).resolve()
(out/'evidence').mkdir(parents=True,exist_ok=True)
(out/'recipes').mkdir(parents=True,exist_ok=True)
accepted=set(['run-20261020-041443','extended-20261020-041804','parametric-20261020-042109','verification-20261020-042255','surface-20261020-043624','sheet-20261020-043551','weld-20261020-043431','assembly-20261020-044257','finishing-20261020-045408','isolated-weld-fillet-20261020-060602'])
accepted.update(Path(x['report']).parent.name for x in json.loads((root/'more-acceptance-summary.json').read_text())['accepted'])
accepted.update(Path(x['report']).parent.name for x in json.loads((root/'extended-round2-acceptance-summary.json').read_text())['accepted_cases'])
def clean(v):
    if isinstance(v,dict):return {k:clean(x) for k,x in v.items()}
    if isinstance(v,list):return [clean(x) for x in v]
    if isinstance(v,str):
        v=v.replace(str(root),'<acceptance-root>').replace(str(root).replace('\\','/'),'<acceptance-root>')
        v=re.sub(r'[A-Za-z]:[\\/]Users[\\/][^\\/\s"\']+', '<user-home>',v)
        return v
    return v
index={'schema':1,'date':'2026-10-20','swRevision':'24.5.0','reports':[],'note':'Historical evidence. Passing sample is not full API coverage or a portable production recipe. Failure reports retained. No employee models or credentials included.'}
for p in sorted(root.glob('**/*.json')):
    if any(x in p.parts for x in ['venv','__pycache__','apihelp']):continue
    if p.name not in ['report.json','dxf-verification.json']:continue
    r=json.loads(p.read_text(encoding='utf-8-sig'));checks=r.get('checks',[])
    rel=p.relative_to(root).as_posix();ident=rel.replace('/','__');status='accepted-sample' if p.parent.name in accepted and all(c.get('passed') for c in checks) else 'historical-diagnostic'
    if status=='accepted-sample' and r.get('complete') is False:raise RuntimeError(rel)
    sanitized=clean(r);data=json.dumps(sanitized,ensure_ascii=False,indent=2).encode();(out/'evidence'/ident).write_bytes(data)
    row={'id':p.parent.name,'file':ident,'status':status,'complete':r.get('complete'),'checks':len(checks),'failedChecks':[c.get('check') for c in checks if not c.get('passed')],'sha256':hashlib.sha256(data).hexdigest(),'sourceOriginalSha256':hashlib.sha256(p.read_bytes()).hexdigest()}
    src=p.parent/'case-source.py'
    if status=='accepted-sample' and src.exists():
        dest=p.parent.name+'.py.txt';(out/'recipes'/dest).write_text(clean(src.read_text(encoding='utf-8-sig')),encoding='utf-8');row['recipe']=dest
    index['reports'].append(row)
for src in sorted(root.glob('*.py')):
    if src.name.startswith(('advanced_','more_','smoke_','case_')):
        (out/'recipes'/('reference-'+src.name+'.txt')).write_text(clean(src.read_text(encoding='utf-8-sig')),encoding='utf-8')
index['counts']={'reports':len(index['reports']),'acceptedReports':sum(x['status']=='accepted-sample' for x in index['reports']),'acceptedAssertions':sum(x['checks'] for x in index['reports'] if x['status']=='accepted-sample')}
(out/'evidence/index.json').write_text(json.dumps(index,ensure_ascii=False,indent=2),encoding='utf-8');print(index['counts'])
recipes=[]
for src in sorted((out/'recipes').glob('*.py.txt')):
    linked=[r['id'] for r in index['reports'] if r.get('recipe')==src.name]
    recipes.append({'id':src.name.removesuffix('.py.txt'),'file':src.name,'status':'accepted-sample-source' if linked else 'reference-only','evidence':linked,'sha256':hashlib.sha256(src.read_bytes()).hexdigest()})
(out/'recipes/index.json').write_text(json.dumps({'schema':1,'notice':'Reference source only; never execute historical Run constructors. Adapt algorithms to the owned cad/sw objects.','recipes':recipes},ensure_ascii=False,indent=2),encoding='utf-8')
