"""从显式提供的声明生成本机包；默认预览，不改协作或Hermes配置。"""
import argparse
import json
from pathlib import Path
import re
import sys
base=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(next((path for path in (base/'native-bridge',base/'native_bridge',base) if (path/'copilot.py').is_file()),base/'native-bridge')))
from copilot import private_write
from copilot_packages import read_package,Packages


def experience(sources,limit=800):
    if not sources:return ''
    parts=[];budget=max(1,(limit-40)//len(sources))
    for source in sources:
        lines=[line.strip() for line in Path(source).read_text().splitlines() if line.strip() and not line.startswith(('#','>','---'))]
        content=' '.join(lines);content=re.sub(r'\[([^]]+)\]\([^)]+\)',r'\1',content)
        excerpt=content[:budget];boundary=max(excerpt.rfind('。'),excerpt.rfind('；'))
        if boundary>budget//2:excerpt=excerpt[:boundary+1]
        parts.append(excerpt)
    return ('本机资料摘录；以完整原文及本机判断器为准。\n'+'\n'.join(parts))[:limit]


def setup(source,destination,apply=False,copy_assets=False,experience_sources=()):
    source=Path(source).expanduser().absolute()
    if source.name!='package.json':raise ValueError('source must be named package.json')
    root,value=read_package(source.parent);Packages([str(root)])
    target=Path(destination).expanduser()/'package.json';files={'package.json':json.dumps(value,ensure_ascii=False,indent=2)+'\n'}
    if copy_assets:
        for name in value.get('files',[]):
            path=(root/name).resolve()
            if not path.is_relative_to(root) or not path.is_file() or path.is_symlink() or path.stat().st_size>131072:raise ValueError('unsafe declared asset')
            files[name]=path.read_text()
    if experience_sources:
        files['experience.md']=experience(experience_sources);value['experience_file']='experience.md';files['package.json']=json.dumps(value,ensure_ascii=False,indent=2)+'\n'
    for name in files:
        path=target.parent/name
        if Path(name).is_absolute() or '..' in Path(name).parts or path.exists() or any(part.is_symlink() for part in (path,*path.parents)):raise ValueError('existing or unsafe package target; no writes')
    if apply:
        # 中文注释：全部目标先预检，声明最后落盘，未完成的文件不会被自动发现为包。
        for name,text in files.items():
            if name!='package.json':private_write(target.parent/name,text)
        private_write(target,files['package.json'])
    return target


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',required=True,type=Path)
    parser.add_argument('--destination',required=True,type=Path)
    parser.add_argument('--apply',action='store_true')
    parser.add_argument('--copy-assets',action='store_true')
    parser.add_argument('--experience-source',action='append',type=Path,default=[])
    args=parser.parse_args();print(setup(args.source,args.destination,args.apply,args.copy_assets,args.experience_source))
