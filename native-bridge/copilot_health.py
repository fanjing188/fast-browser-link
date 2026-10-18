"""本机结构检查：不启动进程、不探测模型、不读取凭据。"""
from pathlib import Path
import shutil

def health(config, state, runtime):
    home=Path(config.get('hermes_home') or Path.home()/'.hermes').expanduser()
    profile=config.get('exec_profile','copilot-exec')
    profile_exists=isinstance(profile,str) and '/' not in profile and profile not in {'.','..'} and (home/'profiles'/profile/'config.yaml').is_file()
    command=config.get('hermes_command','hermes')
    executable=isinstance(command,str) and bool(shutil.which(command))
    ready=bool(state.get('ready') and runtime and not getattr(runtime,'closed',False))
    metrics=state.get('input_metrics',[])
    last_success=state.get('last_call_succeeded',True if metrics else None)
    process=getattr(runtime,'process',None)
    diagnostic=state.get('diagnostic') or state.get('execution_diagnostic') or getattr(runtime,'failure',None) or (process is not None and process.poll() is not None)
    reason=''
    if diagnostic or last_success is False:
        status='error';reason='最近调用或会话失败 / Last call or session failed';last_success=False
    elif not profile_exists or not executable:
        status='disconnected';reason='执行 profile 或程序不可用 / Execution profile or executable unavailable'
    elif ready:status='connected'
    elif state.get('enabled'):status='connecting'
    else:status='disconnected'
    return {'state':status,'reason':reason,'acp_ready':ready,'execution_profile_exists':bool(profile_exists),'execution_startable':bool(profile_exists and executable),'execution_check':'structural_only','last_call_succeeded':last_success}
