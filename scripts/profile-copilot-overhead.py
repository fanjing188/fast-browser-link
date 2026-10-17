"""只读统计 profile 的上下文文件和 MCP schema 缓存；不是线上请求 token 账单。"""
import argparse
import json
from pathlib import Path


def analyze(profile,cwd=None):
    profile=Path(profile).expanduser()
    result={'method':'UTF-8 bytes/4 estimates; disk inventory, not exact transmitted tokens','files':{}}
    for name in ('SOUL.md','memories/MEMORY.md','memories/USER.md'):
        path=profile/name
        if path.is_file():
            raw=path.read_bytes();result['files'][name]={'bytes':len(raw),'estimated_tokens':(len(raw)+3)//4}
    if cwd:
        for name in ('AGENTS.md','AGENTS.override.md','.hermes.md','HERMES.md'):
            path=Path(cwd)/name
            if path.is_file():
                raw=path.read_bytes();result['files']['cwd/'+name]={'bytes':len(raw),'estimated_tokens':(len(raw)+3)//4}
    cache=profile/'cache/mcp_schema_cache.json'
    if cache.is_file():
        entries=json.loads(cache.read_text());tools=[]
        for entry in entries.values():
            if isinstance(entry,dict):tools.extend(entry.get('tools',[]))
        raw=json.dumps(tools,ensure_ascii=False).encode()
        result['mcp_cache']={'servers':len(entries),'tools':len(tools),'bytes':len(raw),'estimated_tokens':(len(raw)+3)//4,
                             'limitation':'cache may include tools deferred or absent from a model request; do not sum as live overhead'}
    result['skills_markdown_files']=len(list((profile/'skills').rglob('SKILL.md')))
    result['unknown']=['exact built-in system prompt tokens','effective tool schema subset','rendered skill index tokens','provider tokenization']
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile-dir',type=Path,required=True)
    parser.add_argument('--cwd',type=Path)
    args=parser.parse_args();print(json.dumps(analyze(args.profile_dir,args.cwd),ensure_ascii=False,indent=2))
