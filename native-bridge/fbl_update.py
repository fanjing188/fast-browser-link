"""跨布局更新事务：先核实、维护锁、同盘交换、验证失败回滚。"""
from contextlib import ExitStack
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import time
import sys
from fbl_runtime import Context,HOST,ORIGIN,AGENTS,load,read,safe,manifests
from copilot import private_write
from copilot_setup import setup as setup_templates
from fbl_profiles import repair


def verify_source(source):
    source=Path(source).resolve();expected=read(source/'SHA256SUMS.json')
    if not expected:raise ValueError('verified prebuilt release required; source builds are a separate developer step')
    actual={}
    for path in source.rglob('*'):
        if path.is_symlink():raise ValueError('release contains a symlink')
        if path.is_file() and path!=source/'SHA256SUMS.json':actual[path.relative_to(source).as_posix()]=hashlib.sha256(path.read_bytes()).hexdigest()
    if actual!=expected:raise ValueError('release file set or digest mismatch')
    adapter=source/'fast-browser-link'
    if not adapter.is_dir():adapter=source/'adapter/fast-browser-link'
    native=source/'native-bridge' if (source/'native-bridge').is_dir() else adapter/'native_bridge'
    extension=source/'extension' if (source/'extension').is_dir() else source/'native-extension'
    if not extension.is_dir():extension=source/'adapter/native-extension'
    skill=source/'skills/fast-browser-link'
    if not skill.is_dir():skill=adapter/'core-skills/fast-browser-link'
    if not (native/'install.py').is_file() or not (extension/'BUILD-DEPS.json').is_file() or not (skill/'SKILL.md').is_file():raise ValueError('release runtime/extension/skill closure missing')
    return {'source':source,'native':native,'extension':extension,'adapter':adapter,'skill':skill}


def layouts(ctx):
    roots=[]
    standalone=ctx.user/'.fast-browser-link'
    if (standalone/'installation.json').is_file():roots.append(standalone)
    plugins=[ctx.hermes/'plugins/fast-browser-link',*[path for path in (ctx.hermes/'profiles').glob('*/plugins/fast-browser-link')]]
    installed=[]
    for path in plugins:
        if path.is_symlink():
            if path==plugins[0] or path.resolve()!=plugins[0].resolve():raise ValueError('unknown profile plugin link')
        elif (path/'plugin.yaml').is_file():installed.append(safe(path))
    if (ctx.hermes/'plugins/fast-browser-link/plugin.yaml').is_file() or (ctx.hermes/'plugin-data/fast-browser-link-native/host-bin').is_dir():roots.append(ctx.hermes)
    if ctx.runtime not in roots and (ctx.data/'host-bin').is_dir():roots.append(ctx.runtime)
    return list(dict.fromkeys(roots)),installed


def skill_targets(ctx):
    names=('fast-browser-link','fast-browser-troubleshoot','fast-browser-batch-scrape')
    targets=[ctx.user/path/name for path in AGENTS.values() for name in names]+[ctx.hermes/'skills'/name for name in names]
    for name in names:targets.extend((ctx.hermes/'profiles').glob('*/skills/'+name))
    if any(path.is_symlink() for path in targets):raise ValueError('agent skill link ownership requires review')
    return list(dict.fromkeys(safe(path) for path in targets if path.is_dir()))


def tree_digest(path):
    return hashlib.sha256(json.dumps({str(file.relative_to(path)):hashlib.sha256(file.read_bytes()).hexdigest() for file in sorted(Path(path).rglob('*')) if file.is_file() and file.name not in {'.fbl-skill.json','.fbl-pack.json'} and '__pycache__' not in file.parts},sort_keys=True).encode()).hexdigest()


def legacy_cli(ctx):
    if not ctx.support:raise ValueError('maintenance support missing; use a complete current release')
    cli=load('fbl_maintenance',ctx.support/'install-cli.py');cli.EXECUTOR=load('fbl_verifier',ctx.support/'install-executor.py');return cli


def task_status(ctx, cli):
    roots, _ = layouts(ctx)
    groups = {'active': [], 'after_daemon_stop': [], 'needs_verification': []}
    eligible = {}
    epoch = None; epoch_checked = False
    for root in roots:
        try:
            jobs=cli.load_basket_jobs(root)
            for identity, job in jobs.items():
                group='active' if isinstance(job,dict) and job.get('state') in {'queued','running'} else 'needs_verification'
                groups[group].append({'id': identity, 'title': job.get('title','Copilot basket') if isinstance(job,dict) else 'Copilot basket', 'runtime':str(root)})
        except (OSError, ValueError, TypeError, cli.InstallError):
            groups['needs_verification'].append({'title': 'Copilot basket activity cannot be verified', 'runtime': str(root)})
        try:
            records = cli.load_task_records(root)
        except (OSError, ValueError, TypeError, cli.InstallError):
            groups['needs_verification'].append({'title': '任务记录无法安全读取（权限、格式或未合并日志）', 'runtime': str(root)})
            continue
        for task in records['tasks']:
            reason = cli.task_block_reason(task)
            if reason is None:
                continue
            row = {key: task.get(key) for key in ('id', 'title', 'state', 'cleanupState', 'createdAt', 'updatedAt')} if isinstance(task, dict) else {'title': 'Invalid task record'}
            row['runtime'] = str(root)
            if reason == 'active':
                group = 'active'
            elif reason == 'history':
                group = 'after_daemon_stop'
            else:
                group = 'needs_verification'
                if not epoch_checked:
                    epoch = cli.browser_epoch(dict(os.environ)); epoch_checked = True
                row['safe_to_settle'] = cli.old_browser_task(task, epoch)
                if row['safe_to_settle']:
                    eligible.setdefault(root, []).append(task['id'])
            groups[group].append(row)
    return groups, eligible


def task_summary(groups):
    return {key: {'count': len(rows), 'examples': rows[:5]} for key, rows in groups.items()}


def task_message(groups):
    lines = ['active or unsettled tasks / 升级任务检查：']
    for key, title in (('active', '真正进行中'), ('after_daemon_stop', '停 daemon 后可通过'), ('needs_verification', '需要核实')):
        rows = groups[key]; lines.append(f'{title}：{len(rows)}')
        for row in rows[:5]:
            title = ' '.join(str(row.get('title') or '(无标题)').split())[:100]
            stamp=row.get('updatedAt')
            try: stamp=datetime.fromtimestamp(stamp).astimezone().isoformat(timespec='seconds')
            except (TypeError, ValueError, OverflowError, OSError): stamp='unknown'
            identity=' '.join(str(row.get('id', 'unknown')).split())[:100]
            lines.append(f"  - {title} [{identity}] 时间 {stamp}" + (' 可安全结清（需确认）' if row.get('safe_to_settle') else ''))
    lines.append('下一步：先结束进行中的任务；fbl update --dry-run --source <包> 复查。旧纪元任务确认后运行 fbl update --source <包> --pause-hermes（--yes 自动确认）。其他未知任务核实后用 npm run tasks:ack -- <taskId> --stop-daemon。')
    return '\n'.join(lines)


def idle(ctx, cli, wait=0, *, allow_settle=False):
    import math
    if not isinstance(wait, (int, float)) or not math.isfinite(wait) or wait < 0:
        raise ValueError('wait must be finite and nonnegative')
    deadline = time.monotonic() + wait; previous = None
    while True:
        groups, eligible = task_status(ctx, cli)
        review = [row for row in groups['needs_verification'] if not (allow_settle and row.get('safe_to_settle'))]
        if not groups['active'] and not review:
            return groups, eligible
        message = task_message(groups)
        if message != previous and wait:
            print(message, file=sys.stderr); previous = message
        if time.monotonic() >= deadline:
            raise ValueError(message)
        time.sleep(min(.5, max(0, deadline-time.monotonic())))


def preview(ctx, summary=None, cli=None):
    groups, eligible = task_status(ctx, cli or legacy_cli(ctx))
    return {**(summary or plan(ctx)), 'status': 'dry_run', 'task_check': task_summary(groups),
            'safe_to_settle': sum(map(len, eligible.values())),
            'ready_after_confirmation': not groups['active'] and all(row.get('safe_to_settle') for row in groups['needs_verification']),
            'next_steps': task_message(groups)}


def extension_targets(ctx):
    values=[]
    standalone=ctx.user/'.fast-browser-link/extension'
    if standalone.is_dir():values.append(standalone)
    for path in (ctx.hermes/'fast-browser-link-releases').glob('*'):
        if (path/'manifest.json').is_file():values.append(path)
    return [safe(path) for path in values]


def plan(ctx,source=None):
    roots,plugins=layouts(ctx)
    if not roots:raise ValueError('no installed runtime; run fbl setup')
    payload=verify_source(source) if source else None
    targets=[*[root/'plugin-data/fast-browser-link-native/host-bin' for root in roots],*plugins,*extension_targets(ctx),*skill_targets(ctx)]
    return {'runtimes':list(map(str,roots)),'targets':list(map(str,targets)),'download_required':source is None,'reload_extension':True,'source_verified':bool(payload)}


def _copy(source,target):
    if source.is_symlink() or source.is_dir() and any(path.is_symlink() for path in source.rglob('*')):raise ValueError('staging source contains symlink')
    if source.is_dir():shutil.copytree(source,target,ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
    else:target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,target)


def update(ctx,source,*,dry_run=False,wait=0,pause_hermes=False,health=None,yes=False,confirm=None):
    payload=verify_source(source);summary=plan(ctx,source);cli=legacy_cli(ctx)
    if dry_run:
        return preview(ctx, summary, cli)
    groups, approved = idle(ctx, cli, wait, allow_settle=True)
    if approved:
        print(task_message(groups), file=sys.stderr)
        if not yes and (confirm is None or not confirm(f'确认备份并结清上述 {sum(map(len, approved.values()))} 个旧浏览器纪元任务（保留原始操作结果）？[y/N] ')):
            raise ValueError('旧纪元任务尚未确认；未停止 daemon、未修改任务。使用交互终端确认或 --yes。')
    roots,plugins=layouts(ctx);env={**os.environ,'PYTHONDONTWRITEBYTECODE':'1'}
    for root in roots:
        for path in manifests(ctx.user):
            value=read(path)
            if value and value.get('allowed_origins')!=[ORIGIN]:raise ValueError('host origin differs; update cannot expand it')
        safe(root/'plugin-data/fast-browser-link-native')
    transaction=safe(ctx.runtime/'fbl-backups'/datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
    transaction.mkdir(parents=True,mode=0o700)
    swapped=[];markers=[];paused=False;was_running={};notes=[];rolled_back=False
    from doctor import probe
    health=health or probe
    try:
        with ExitStack() as stack:
            for root in roots:
                data=root/'plugin-data/fast-browser-link-native';data.mkdir(parents=True,exist_ok=True,mode=0o700)
                stack.enter_context(cli.install_lock(data))
                idle(ctx, cli, allow_settle=True)
                was_running[root]=bool(cli.verified_daemon_pid(root,env))
                markers.append((root,cli.enter_maintenance(root,'fbl update',os.getpid())))
                if not cli.cloud_never_configured(root,ctx.user):
                    cli.assert_cloud_fenced(root);cli.wait_cloud_released(root)
            if pause_hermes and shutil.which('hermes') and not (ctx.hermes/'ESTOP').exists():
                result=cli.command(['hermes','pause','--reason','fbl update'],{**env,'HERMES_HOME':str(ctx.hermes)})
                if result.returncode:raise ValueError('Hermes scheduling could not be paused')
                paused=True
            acknowledgements = []
            for root in roots:
                idle(ctx, cli, allow_settle=True)
                cli.stop_daemon(root, env)
                def settle(descriptor, root=root):
                    current_groups, candidates = task_status(ctx, cli)
                    if current_groups['active'] or any(not row.get('safe_to_settle') for row in current_groups['needs_verification']):
                        raise ValueError(task_message(current_groups))
                    ids = candidates.get(root, [])
                    if not set(ids).issubset(approved.get(root, [])):
                        raise ValueError('旧纪元任务集合已变化；重新预览并确认。')
                    if ids:
                        epoch = cli.browser_epoch(env)
                        if epoch is None: raise ValueError('browser epoch can no longer be verified')
                        acknowledgements.append(cli.acknowledge_tasks(root, ids, '用户确认升级前结清旧浏览器纪元任务', env, descriptor, epoch=epoch))
                stack.enter_context(cli.idle_bridge(root, env, settle=settle))
            prepared=[]
            for index,root in enumerate(roots):
                staging=transaction/('runtime-'+str(index));user=transaction/('user-'+str(index));user.mkdir()
                installer=load('fbl_native_stage_'+str(index),payload['native']/'install.py')
                installer.stage(user,[ORIGIN],runtime_home=staging)
                host=staging/'plugin-data/fast-browser-link-native/host-bin'
                final=root/'plugin-data/fast-browser-link-native/host-bin'
                launcher=host/HOST;launcher.write_text(launcher.read_text().replace(str(staging),str(root)))
                prepared.append((host,final))
                cp=staging/'plugin-data/fast-browser-link-native/copilot';shutil.rmtree(cp)
                cp.mkdir();existing=root/'plugin-data/fast-browser-link-native/copilot'
                for relative in ('templates','managed-templates.json','config.json'):
                    path=existing/relative
                    if path.exists():_copy(safe(path),cp/relative)
                setup_templates(cp,payload['native']/'copilot-templates')
                prepared.extend((cp/relative,existing/relative) for relative in ('templates','managed-templates.json','config.json'))
            for root in roots:
                agent_link=root/'runtime/agent-link'
                if agent_link.is_dir():
                    source=payload['source']/'agent-link'
                    if not source.is_dir():source=payload['adapter']/'agent_link'
                    stage=transaction/('agent-link-'+str(len(prepared)));_copy(source,stage);prepared.append((stage,safe(agent_link)))
            for path in plugins:
                if not payload['adapter'].is_dir():raise ValueError('release has no adapter payload for an installed adapter')
                stage=transaction/('program-'+str(len(prepared)));_copy(payload['adapter'],stage);prepared.append((stage,path))
            for path in extension_targets(ctx):
                stage=transaction/('extension-'+str(len(prepared)));_copy(payload['extension'],stage);prepared.append((stage,path))
            for root in roots:
                for target in (root/'plugin-data/fast-browser-link-native/copilot/packs').glob('*'):
                    if target.name not in {'general','seo'} or not target.is_dir():continue
                    if read(target/'.fbl-pack.json').get('sha256')!=tree_digest(target):raise ValueError('managed pack modified; preserved')
                    stage=transaction/('pack-'+str(len(prepared)));_copy(payload['native']/'fbl-assets/packs'/target.name,stage)
                    private_write(stage/'.fbl-pack.json',json.dumps({'version':1,'sha256':tree_digest(stage)}));prepared.append((stage,target))
            history=read(payload['native']/'fbl-assets/skill-history.json',{})
            for path in skill_targets(ctx):
                record=read(path/'.fbl-skill.json');current=tree_digest(path)
                if current!=record.get('sha256') and current not in history.get(path.name,[]):raise ValueError('skill modified or ownership unknown; preserved: '+str(path))
                source=payload['skill'] if path.name=='fast-browser-link' else payload['adapter']/'skills'/path.name
                if not source.is_dir():raise ValueError('installed skill missing from release')
                stage=transaction/('skill-'+str(len(prepared)));_copy(source,stage)
                private_write(stage/'.fbl-skill.json',json.dumps({'version':1,'sha256':tree_digest(stage)}));prepared.append((stage,path))
            # 中文注释：只迁移带标记的专用配置；根和其他 profile 不进入写集合。
            for profile in ('copilot','copilot-exec'):
                target=ctx.hermes/'profiles'/profile
                if not (target/'.copilot-profile.json').is_file():continue
                staged_home=transaction/('profile-'+profile);stage=staged_home/'profiles'/profile
                from fbl_profiles import read_config
                private_write(stage/'config.yaml',json.dumps(read_config(target/'config.yaml',ctx.hermes)))
                _copy(safe(target/'.copilot-profile.json'),stage/'.copilot-profile.json')
                repair(staged_home,profile,private_write)
                prepared.extend((stage/name,target/name) for name in ('config.yaml','.copilot-profile.json'))
            for manifest in manifests(ctx.user):
                if not manifest.exists():continue
                stage=transaction/('manifest-'+str(len(prepared)))
                value=read(manifest);value['path']=str(ctx.data/'host-bin'/HOST);private_write(stage,json.dumps(value,indent=2));prepared.append((stage,safe(manifest)))
            for stage,target in prepared:
                safe(target);target.parent.mkdir(parents=True,exist_ok=True)
                if stage.stat().st_dev!=target.parent.stat().st_dev:raise ValueError('atomic update requires same filesystem')
            private_write(transaction/'plan.json',json.dumps(summary,indent=2))
            for index,(stage,target) in enumerate(prepared):
                previous=transaction/('old-'+str(index));exists=target.exists()
                if exists:os.replace(target,previous)
                try:os.replace(stage,target)
                except BaseException:
                    if exists:os.replace(previous,target)
                    raise
                swapped.append((target,previous if exists else None))
            # 中文注释：校验阶段仍持启动锁；通过子进程导入闭包，不调用模型或浏览器动作。
            for root in roots:
                native=root/'plugin-data/fast-browser-link-native/host-bin'
                result=cli.command([sys.executable,'-I','-c','import sys;sys.path.insert(0,sys.argv[1]);import daemon,fbl_cli',str(native)],env)
                if result.returncode:raise ValueError('staged runtime import validation failed')
            for root,token in markers:cli.leave_maintenance(root,token)
            markers.clear()
        for root in roots:
            if was_running[root]:
                from client import BridgeClient
                client=BridgeClient(root,timeout=10)
                try:client.call('health')
                finally:client.close()
            if was_running[root] and not health(root).get('ok'):raise ValueError('restarted daemon validation failed')
        return {**summary,'status':'updated','backup':str(transaction),'notes':notes,'acknowledged_tasks':acknowledgements}
    except BaseException as error:
        for root in roots:
            try:
                if not any(item[0]==root for item in markers):markers.append((root,cli.enter_maintenance(root,'fbl rollback',os.getpid())))
                idle(ctx, cli, allow_settle=True)
                cli.stop_daemon(root,env)
            except (OSError,ValueError,cli.InstallError):
                if swapped:raise ValueError('rollback requires manual process verification; backup retained at '+str(transaction))
        for target,previous in reversed(swapped):
            failed=transaction/('failed-'+str(len(notes)));notes.append(str(target))
            if target.exists():os.replace(target,failed)
            if previous is not None:os.replace(previous,target)
        rolled_back=True
        if isinstance(error, cli.InstallError):
            error=ValueError(str(error)+'\n'+error.fix)
            error.backup=str(transaction);error.rolled_back=True;error.notes=notes
            raise error
        error.backup=str(transaction);error.rolled_back=True;error.notes=notes
        raise
    finally:
        for root,token in markers:
            try:cli.leave_maintenance(root,token)
            except (OSError,ValueError,cli.InstallError):notes.append('maintenance marker cleanup unconfirmed; run fbl doctor')
        if rolled_back:
            for root,running in was_running.items():
                if running:
                    from client import BridgeClient
                    client=BridgeClient(root,timeout=10)
                    try:client.call('health',{})
                    except (OSError,RuntimeError):notes.append('restored daemon could not be started; run fbl doctor')
                    finally:client.close()
        if paused:
            try:resumed=cli.command(['hermes','resume'],{**env,'HERMES_HOME':str(ctx.hermes)}).returncode==0
            except OSError:resumed=False
            if not resumed:
                notes.append('Hermes scheduling resume failed; run hermes resume')
                if sys.exception() is None:
                    error=ValueError(notes[-1]);error.backup=str(transaction);error.notes=notes;raise error


def fetch_update(ctx,**kwargs):
    support=ctx.support
    candidates=[support/'update.py' if support else Path('/missing'),ctx.hermes/'plugins/fast-browser-link/maintenance/update.py']
    updater=next((path for path in candidates if path.is_file()),None)
    if not updater:raise ValueError('release downloader missing; pass --source a verified release')
    module=load('fbl_release_download',updater);cli=legacy_cli(ctx);release=module.latest_release()
    if not release:return {'status':'no_stable_release'}
    with tempfile.TemporaryDirectory(prefix='fbl-update-') as temp:
        source=module.extract_archive(module.fetch(release['url'],module.MAX_ARCHIVE),release,Path(temp),cli.EXECUTOR)
        return update(ctx,source,**kwargs)
