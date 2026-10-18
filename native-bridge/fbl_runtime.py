"""统一运行时定位、只读诊断及受管修复；不探测付费数据源。"""
from dataclasses import dataclass
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
from copilot_setup import setup as templates_setup,pending_templates
from fbl_profiles import profile_plan,repair

HOST='com.fast.browser_link'
ORIGIN='chrome-extension://hhnljehnkmhhgjjjmnlhilfpcjhobloc/'
AGENTS={'hermes':'.hermes/skills','codex':'.codex/skills','claude':'.claude/skills','cursor':'.cursor/skills','copilot':'.copilot/skills','gemini':'.gemini/skills','generic':'.agents/skills'}
HERE=Path(__file__).resolve().parent


def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec)
    previous=sys.dont_write_bytecode;sys.dont_write_bytecode=True
    try:spec.loader.exec_module(module)
    finally:sys.dont_write_bytecode=previous
    return module


def read(path,default=None):
    if not Path(path).exists():return {} if default is None else default
    value=json.loads(Path(path).read_text())
    if not isinstance(value,type({} if default is None else default)):raise ValueError('invalid JSON document shape')
    return value


def private_write(path,text):
    import tempfile
    path=safe(path);path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    temporary=None
    try:
        fd,temporary=tempfile.mkstemp(prefix='.'+path.name+'-',dir=path.parent)
        with os.fdopen(fd,'w',encoding='utf-8') as handle:
            handle.write(text);handle.flush();os.fsync(handle.fileno())
        safe(path);os.replace(temporary,path)
    finally:
        if temporary and os.path.exists(temporary):os.unlink(temporary)


def safe(path):
    path=Path(path).absolute()
    if any(part.is_symlink() for part in (path,*path.parents)):raise ValueError('target path contains symlink')
    return path


@dataclass
class Context:
    user:Path
    hermes:Path
    runtime:Path
    source:Path=None

    @classmethod
    def locate(cls,user=None,hermes=None,runtime=None,source=None):
        def normalize(value):
            path=Path(value).expanduser().absolute()
            if any(part.is_symlink() and str(part) not in {'/tmp','/var'} for part in (path,*path.parents)):raise ValueError('installation root contains symlink')
            return path.resolve()
        user=normalize(user or Path.home());hermes=normalize(hermes or os.environ.get('HERMES_HOME') or user/'.hermes')
        if hermes.parent.name=='profiles':hermes=hermes.parent.parent
        roots=[user/'.fast-browser-link',hermes]
        if runtime is None:
            for manifest in manifests(user):
                try:value=read(manifest)
                except (OSError,ValueError):continue
                launcher=Path(value.get('path','/missing'))
                for root in roots:
                    if launcher.is_relative_to(root):runtime=root;break
                if runtime:break
        runtime=normalize(runtime or os.environ.get('FAST_BROWSER_LINK_HOME') or (roots[0] if (roots[0]/'installation.json').exists() or not (hermes/'plugins/fast-browser-link').exists() else hermes))
        source=Path(source).expanduser().resolve() if source else None
        return cls(user,hermes,runtime,source)

    @property
    def data(self):return self.runtime/'plugin-data/fast-browser-link-native'
    @property
    def copilot(self):return self.data/'copilot'
    @property
    def support(self):
        candidates=[self.source/'scripts' if self.source else HERE.parent/'scripts',HERE/'fbl-support',*([self.source/'fast-browser-link/maintenance',self.source/'adapter/fast-browser-link/maintenance'] if self.source else []),self.hermes/'plugins/fast-browser-link/maintenance']
        return next((path for path in candidates if (path/'install-cli.py').is_file()),None)


def manifests(user):
    return [Path(user)/'Library/Application Support'/browser/'NativeMessagingHosts'/(HOST+'.json') for browser in ('Google/Chrome','Microsoft Edge')]


def agent_roots(ctx,profiles=()):
    rows=[{'agent':name,'path':str(ctx.hermes/'skills' if name=='hermes' else ctx.user/path),'detected':(ctx.hermes if name=='hermes' else (ctx.user/path).parent).is_dir() or bool(shutil.which({'claude':'claude','hermes':'hermes'}.get(name,name)))} for name,path in AGENTS.items()]
    import re
    for profile in dict.fromkeys(('fast-copilot',*profiles)):
        if not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}',profile):raise ValueError('invalid agent profile')
        path=ctx.hermes/'profiles'/profile
        if path.is_dir() and not path.is_symlink():rows.append({'agent':'hermes','path':str(path/'skills'),'detected':True})
    return rows


def available_models(ctx,command=None):
    from copilot_acp import ACP
    config={'inference_profile':'default','hermes_home':str(ctx.hermes),'timeout_seconds':15}
    if command:config['acp_command']=command
    runtime=ACP(config,ctx.copilot)
    ctx.copilot.mkdir(parents=True,exist_ok=True,mode=0o700)
    try:runtime.start(catalog_only=True);return (runtime.model_state or {})
    finally:runtime.close()


def choose_model(catalog):
    rows=catalog.get('availableModels',[])
    if not rows:raise ValueError('Hermes returned no available models; configure Hermes authentication/model first')
    import re
    fast=next((row for row in rows if row.get('speed')=='fast' or re.search(r'(?i)fast|mini|small|lite|flash',str(row.get('name',''))+' '+row.get('modelId',''))),None)
    selected=(fast or next((row for row in rows if row.get('modelId')==catalog.get('currentModelId')),rows[0]))['modelId']
    if ':' in selected:provider,model=selected.split(':',1)
    else:model,provider=selected,'auto'
    return model,provider


def daemon_version(ctx):
    import socket
    try:
        token=ctx.data/'token'
        if token.is_symlink() or token.stat().st_mode&0o077:return None
        with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as connection:
            connection.settimeout(2);connection.connect(str(ctx.data/'bridge.sock'))
            connection.sendall((json.dumps({'role':'client','token':token.read_text().strip()})+'\n'+json.dumps({'id':'fbl-version','method':'fbl.version','params':{}})+'\n').encode())
            with connection.makefile('rb') as reader:reply=json.loads(reader.readline(65537))
        return reply.get('result',{}).get('version') if reply.get('id')=='fbl-version' else None
    except (OSError,ValueError,TypeError):return None


def doctor(ctx,fix=False,probe=None,deep=False,start=False):
    from doctor import probe as live_probe
    checks=[];actions=[];invalid=set()
    def checked(path,default=None):
        try:return read(path,default)
        except (OSError,ValueError,TypeError):invalid.add(str(path));return {} if default is None else default

    def add(component,ok,code,command='',**extra):checks.append({'component':component,'ok':bool(ok),'code':code,'command':command,**extra})
    runtime_files=ctx.data/'host-bin';stamp=checked(runtime_files/'runtime-version.json');expected=stamp.get('version')
    hashes=stamp.get('files',{})
    integrity=bool(hashes) and all(Path(name).name==name and not (runtime_files/name).is_symlink() and (runtime_files/name).is_file() and hashlib.sha256((runtime_files/name).read_bytes()).hexdigest()==value for name,value in hashes.items())
    add('runtime',runtime_files.is_dir(),'installed' if runtime_files.is_dir() else 'missing','fbl setup')
    for manifest in manifests(ctx.user):
        value=checked(manifest);valid=value.get('name')==HOST and value.get('type')=='stdio' and value.get('allowed_origins')==[ORIGIN] and Path(value.get('path','/missing')).is_file() and os.access(value.get('path','/missing'),os.X_OK)
        if fix and str(manifest) not in invalid and not valid and (runtime_files/HOST).is_file() and (not value or value.get('name')==HOST and value.get('allowed_origins')==[ORIGIN]):
            private_write(manifest,json.dumps({'name':HOST,'description':'Fast-browser-link','type':'stdio','path':str(runtime_files/HOST),'allowed_origins':[ORIGIN]},indent=2));valid=True;actions.append('manifest')
        add('host_'+('edge' if 'Edge' in str(manifest) else 'chrome'),valid,'registered' if valid else 'manifest_invalid','fbl doctor --fix')
    live=(probe or live_probe)(ctx.runtime)
    if fix and start and integrity and not live.get('ok') and live.get('code')=='host_unavailable' and (runtime_files/HOST).is_file():
        from fbl_update import legacy_cli
        cli=legacy_cli(ctx);cli.assert_tasks_idle(ctx.runtime)
        cli.verified_daemon_pid(ctx.runtime,dict(os.environ))
        from client import BridgeClient
        client=BridgeClient(ctx.runtime)
        try:client.call('health',{});actions.append('daemon_started')
        finally:client.close()
        live=(probe or live_probe)(ctx.runtime)
    add('daemon',live.get('ok'),live.get('code','connected'),'fbl doctor --fix')
    browsers=[row for row in live.get('browsers',[]) if row.get('connected')]
    add('extension',bool(browsers),'connected' if browsers else 'disconnected','Open browser extension and connect')
    loaded=live.get('daemonVersion') if probe else daemon_version(ctx) if live.get('ok') else None
    registration_command='fbl update --source <包>'
    unregistered=runtime_files.is_dir() and not expected and not hashes and str(runtime_files/'runtime-version.json') not in invalid
    if unregistered:
        for component in ('daemon_version', 'version', 'runtime_integrity'):
            add(component, True, 'unregistered', registration_command, severity='info',verified=False,
                message='手动安装版本未登记；运行 fbl update --source <包> 登记。当前版本与完整性尚未验证。')
    else:
        add('daemon_version',bool(expected) and loaded==expected,'matched' if expected and loaded==expected else 'unconfirmed','fbl update --dry-run')
        add('version',bool(expected) and bool(browsers) and all(row.get('version')==expected for row in browsers),'matched' if expected and browsers and all(row.get('version')==expected for row in browsers) else 'unconfirmed','fbl update --dry-run')
        add('runtime_integrity',integrity,'verified' if integrity else 'mismatch','fbl update --dry-run')
    add('runtime_root',all(Path(checked(path).get('path','/missing')).is_relative_to(ctx.runtime) for path in manifests(ctx.user) if path.exists()),'consistent','fbl doctor')
    from fbl_update import extension_targets
    packages=extension_targets(ctx)
    add('extension_path',bool(packages),'present' if packages else 'missing','fbl update --dry-run')
    command=shutil.which('hermes');add('hermes',bool(command),'available' if command else 'optional_missing','Install Hermes only for collaboration')
    model_references=checked(ctx.copilot/'config.json')
    profile='fast-copilot'
    try:
        plan=profile_plan(ctx.hermes,profile)
        details=plan.get('details',[]);policy=plan.get('fix_policy','')
        reference=model_references.get('inference_model')
        selected=plan.get('config',{}).get('model',{})
        selected=selected.get('default') if isinstance(selected,dict) else selected
        if reference and selected and reference!=selected:
            details.insert(0,f'协作配置记录模型 → 当前 profile 模型：{reference} → {selected}（可能由 Hermes 迁移；--fix 保留当前模型）')
        if fix and plan['state']=='drift':plan=repair(ctx.hermes,profile,private_write);actions.append(profile)
        add(profile,plan['state']=='ready',plan['state'],'fbl setup' if plan['state']=='unmanaged' else 'fbl doctor --fix',changes=plan.get('changes',[]),details=details,fix_policy=policy)
    except (OSError,ValueError):add(profile,False,'missing_or_unreadable','fbl setup')
    config=checked(ctx.copilot/'config.json');extensions=config.get('extension_dirs',[])
    add('packages',all(Path(path).is_dir() for path in extensions),'present' if all(Path(path).is_dir() for path in extensions) else 'missing_path','fbl packs list')
    model_state=checked(ctx.copilot/'available-models.json');model_code='cached_unverified' if model_state.get('available') else 'not_probed';models_ok=False
    if deep and command:
        try:
            catalog=available_models(ctx);models_ok=bool(catalog.get('availableModels'));model_code='metadata_available' if models_ok else 'no_available_models'
        except (OSError,RuntimeError,ValueError):model_code='metadata_unavailable'
    add('models',models_ok,model_code,'fbl setup')
    if fix and (runtime_files/'copilot-templates').is_dir():templates_setup(ctx.copilot,runtime_files/'copilot-templates');actions.append('templates')
    pending=pending_templates(ctx.copilot)
    manifest=checked(ctx.copilot/'managed-templates.json')
    expected={path.name:hashlib.sha256(path.read_bytes()).hexdigest() for path in (runtime_files/'copilot-templates').rglob('*.json') if path.name!='managed-history.json'}
    stale=[name for name,value in expected.items() if manifest.get('templates',{}).get(name,{}).get('sha256')!=value]
    add('templates',bool(manifest) and not pending and not stale,'merge_required' if pending else 'outdated' if stale else 'managed' if manifest else 'unmanaged','fbl doctor --fix',pending=pending)
    log_dir=ctx.copilot/'logs';writable=any(path.exists() and os.access(path,os.W_OK) for path in [log_dir,*log_dir.parents][:4])
    add('logs',writable,'writable' if writable else 'not_writable','Check directory ownership; no automatic permission escalation')
    from fbl_discovery import changes
    from fbl_browser import BrowserDiscovery
    changed=changes(ctx,deep=deep,browser_probe=BrowserDiscovery(ctx).page if deep and browsers else None)
    add('discovery',not changed,'reconfirm_required' if changed else 'unchanged','fbl packs discover',changed=changed)
    add('cloud',True,'configured' if (ctx.runtime/'plugin-data/fast-browser-link-cloud').exists() else 'not_configured','Cloud is optional')
    if invalid:add('configuration',False,'invalid_json','Review malformed files; preserved')
    return {'ok':all(row['ok'] for row in checks if row['component'] in {'runtime','daemon','extension','runtime_root'}),'checks':checks,'actions':actions,'runtime':str(ctx.runtime),'hermes_optional':True}


def browser_state(ctx,fix=False):
    # 中文注释：浏览器修复不停止服务、不安装程序、不执行脚本或MCP，也不改变模型。
    result=doctor(ctx,fix=fix)
    return result
