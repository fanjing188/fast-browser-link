"""可信侧栏的初始化和诊断入口；发现与确认分开，关闭协作后重载。"""
from pathlib import Path
from fbl_runtime import Context,doctor,read
from fbl_discovery import changes,confirm


def context(copilot):
    return Context.locate(user=copilot.config.get('fbl_user_home'),hermes=copilot.config.get('hermes_home'),runtime=copilot.directory.parents[2])


def readiness(ctx,diagnostic):
    checks=diagnostic['checks'];state=read(ctx.copilot/'fbl-state.json')
    items=[{'id':'setup','ok':state.get('setup_complete') is True,'command':'fbl setup'},
           {'id':'browser','ok':all(any(row['component']==name and row['ok'] and row.get('code')!='unregistered' for row in checks) for name in ('runtime','daemon','extension','runtime_integrity','version')) and any(row['ok'] for row in checks if row['component'].startswith('host_')),'command':'fbl doctor --fix'},
           {'id':'templates','ok':any(row['component']=='templates' and row['ok'] for row in checks),'command':'fbl doctor --fix'},
           {'id':'profiles','repairable':any(row['component'] in {'copilot','copilot-exec'} and row.get('code')=='drift' for row in checks),'ok':all(any(row['component']==name and row['ok'] for row in checks) for name in ('copilot','copilot-exec')),'command':'fbl setup'},
           {'id':'discovery','ok':state.get('discovery_reviewed') is True and not changes(ctx),'command':'fbl packs discover'}]
    return {'ready':all(row['ok'] for row in items),'items':items,'chains':checks}


def request(copilot,method,params):
    ctx=context(copilot)
    if method in {'fbl_readiness','fbl_fix'} and not params:
        return readiness(ctx,doctor(ctx,fix=method=='fbl_fix'))
    if method=='fbl_layout' and set(params)=={'url','tables'}:
        if not isinstance(params['url'],str) or not isinstance(params['tables'],list):raise ValueError('invalid layout notice')
        import json
        if len(json.dumps(params).encode())>8192:raise ValueError('layout notice too large')
        from fbl_discovery import report_layout,candidate
        from copilot import private_write
        row=report_layout(params['url'],{'tables':params['tables']})
        if not row:return {'found':False}
        known={tool['id'] for tool in copilot.packages.tools}
        if row['tool']['id'] in known:return {'found':False}
        path=ctx.copilot/'discovery-pages.json';pending=read(path,[])
        pending=list({item['id']:item for item in [*pending,candidate(row)]}.values())[-20:]
        private_write(path,json.dumps(pending,ensure_ascii=False))
        return {'found':True}
    if method=='fbl_discover' and not set(params)-{'urls','scan_tabs'}:
        urls=params.get('urls',[])
        if not isinstance(urls,list) or any(not isinstance(url,str) for url in urls) or type(params.get('scan_tabs',False)) is not bool:raise ValueError('invalid discovery options')
        from fbl_cli import discover
        return discover(ctx,urls,params.get('scan_tabs',False))
    if method=='fbl_confirm' and not set(params)-{'ids','edits'}:
        result=confirm(ctx,params.get('ids',[]),params.get('edits',{}))
        from copilot import private_write
        import json
        state=read(ctx.copilot/'fbl-state.json');state['discovery_reviewed']=True
        private_write(ctx.copilot/'fbl-state.json',json.dumps(state))
        return result
    raise ValueError('invalid fbl request')
