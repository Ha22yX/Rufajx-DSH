"""Build a complete metadata inventory from the user's installed type libraries; no SW process is opened."""
import argparse, hashlib, json
from pathlib import Path
import pythoncom

def plain(v):
    if isinstance(v,(list,tuple)): return [plain(x) for x in v]
    if v is None or isinstance(v,(str,int,float,bool)): return v
    return str(v)
def type_name(ti, t):
    if isinstance(t,(list,tuple)):
        if t and t[0]==pythoncom.VT_USERDEFINED:
            try: return {'vt':t[0],'type':ti.GetRefTypeInfo(t[1]).GetDocumentation(-1)[0]}
            except Exception: pass
        return [type_name(ti,x) for x in t]
    return plain(t)
def build(source,destination):
    destination.mkdir(parents=True,exist_ok=True)
    index={'schema':1,'target':'SolidWorks 2016','status':'metadata-only; not verified execution','libraries':[],'failures':[]}
    for path in sorted(source.glob('*.tlb')):
        try:
            lib=pythoncom.LoadTypeLib(str(path));la=lib.GetLibAttr()
            result={'name':lib.GetDocumentation(-1)[0],'source':path.name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'guid':str(la[0]),'version':[la[3],la[4]],'types':[]}
            for n in range(lib.GetTypeInfoCount()):
                ti=lib.GetTypeInfo(n);a=ti.GetTypeAttr();name=lib.GetDocumentation(n)[0]
                row={'name':name,'guid':str(a.iid),'kind':a.typekind,'members':[],'constants':[]}
                for j in range(a.cFuncs):
                    f=ti.GetFuncDesc(j);names=ti.GetNames(f.memid);doc=ti.GetDocumentation(f.memid)
                    if names[0] in ['QueryInterface','AddRef','Release','GetTypeInfoCount','GetTypeInfo','GetIDsOfNames','Invoke']: continue
                    row['members'].append({'name':names[0],'description':doc[1] or '', 'dispid':f.memid,'invoke':f.invkind,'kind':f.funckind,'flags':f.wFuncFlags,'optional':f.cParamsOpt,'parameters':[{'name':names[k+1] if k+1<len(names) else 'arg'+str(k),'type':type_name(ti,arg[0]),'flags':arg[1],'default':plain(arg[2])} for k,arg in enumerate(f.args)],'returns':type_name(ti,f.rettype)})
                for j in range(a.cVars):
                    v=ti.GetVarDesc(j);row['constants'].append({'name':ti.GetDocumentation(v.memid)[0],'value':plain(v.value),'type':type_name(ti,v.elemdescVar)})
                if row['members'] or row['constants']: result['types'].append(row)
            filename=path.stem+'.json';data=json.dumps(result,ensure_ascii=False,separators=(',',':')).encode();(destination/filename).write_bytes(data)
            index['libraries'].append({'file':filename,'name':result['name'],'source':path.name,'guid':result['guid'],'version':result['version'],'sha256':hashlib.sha256(data).hexdigest(),'types':len(result['types']),'members':sum(len(x['members']) for x in result['types']),'constants':sum(len(x['constants']) for x in result['types'])})
        except Exception as e:index['failures'].append({'source':path.name,'reason':str(e)})
    index['totals']={k:sum(x[k] for x in index['libraries']) for k in ['types','members','constants']}
    (destination/'index.json').write_text(json.dumps(index,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(index,ensure_ascii=False))
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--installation',required=True);p.add_argument('--output',required=True);a=p.parse_args();build(Path(a.installation),Path(a.output))
