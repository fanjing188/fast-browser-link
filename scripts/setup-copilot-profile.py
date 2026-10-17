"""只新建 copilot profile，不复制凭据、不修改任何现有 profile。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess


def setup(root, model, provider='auto', apply=False, command='hermes'):
    root=Path(root).expanduser().absolute()
    target=root/'profiles/copilot'
    if any(part.is_symlink() for part in (target,*target.parents)):
        raise ValueError('refusing symlink profile path')
    config={'model':{'default':model,'provider':provider},'platform_toolsets':{'acp':[]},
            'mcp_servers':{},'plugins':{'enabled':[]},'memory':{'memory_enabled':False,'user_profile_enabled':False,'provider':''},
            'skills':{'auto_load':[]},'auxiliary':{'background_review':{'enabled':False}},
            'agent':{'max_turns':1,
              'tool_use_enforcement':False,'execution_guidance':False,
              'task_completion_guidance':False,'parallel_tool_call_guidance':False}}
    # 中文注释：JSON 是 YAML 子集，不依赖用户安装 PyYAML；空 SOUL 防止默认长人格再次被播种。
    files={'config.yaml':json.dumps(config,ensure_ascii=False,indent=2)+'\n', 'SOUL.md':'',
           'AGENTS.md':'','workspace/AGENTS.md':'','workspace/.hermes.md':''}
    hashes={name:hashlib.sha256(text.encode()).hexdigest() for name,text in files.items()}
    print('Plan: create only '+str(target))
    for name,text in files.items():print('\n--- '+name+' ---\n'+(text or '(empty)'))
    print('Credentials are not copied. Hermes may reuse root authentication; configure it only if unavailable.')
    marker=target/'.copilot-profile.json'
    if target.exists():
        if marker.is_file() and not marker.is_symlink() and json.loads(marker.read_text()).get('files')==hashes:
            if all((target/name).is_file() and not (target/name).is_symlink() and hashlib.sha256((target/name).read_bytes()).hexdigest()==digest for name,digest in hashes.items()):
                print('Existing matching managed profile; no writes.');return
        raise ValueError('copilot already exists or has changed; no existing profile is modified')
    if not apply:
        print('Preview only. Add --apply to create this profile.');return
    subprocess.run([command,'profile','create','copilot','--no-alias','--no-skills'],
                   env={**os.environ,'HERMES_HOME':str(root)},check=True)
    if not target.is_dir() or any(part.is_symlink() for part in (target,*target.parents)):
        raise ValueError('profile creation returned an unsafe target')
    for name,text in files.items():
        path=target/name
        if any(part.is_symlink() for part in (path,*path.parents)):
            raise ValueError('new profile contains symlink target')
        path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'w') as handle:handle.write(text)
    marker.write_text(json.dumps({'files':hashes},indent=2)+'\n');marker.chmod(0o600)
    print('Created copilot. Existing profiles and active_profile were not changed.')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=Path.home()/'.hermes')
    parser.add_argument('--model',required=True,help='available inexpensive fast model identifier')
    parser.add_argument('--provider',default='auto')
    parser.add_argument('--apply',action='store_true')
    args=parser.parse_args()
    setup(args.root,args.model,args.provider,args.apply)
