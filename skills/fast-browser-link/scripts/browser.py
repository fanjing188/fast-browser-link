#!/usr/bin/env python3
"""调用安装器登记的本地运行时；不依赖 agent 专属工具配置。"""
from pathlib import Path
import os
import runpy
import sys
root = Path(os.environ.get('FAST_BROWSER_LINK_HOME', Path.home() / '.fast-browser-link'))
candidates=[root/'runtime/agent-link/fast_browser_link.py',root/'plugins/fast-browser-link/agent_link/fast_browser_link.py']
if not os.environ.get('FAST_BROWSER_LINK_HOME'):
    candidates.append(Path(os.environ.get('HERMES_HOME',Path.home()/'.hermes'))/'plugins/fast-browser-link/agent_link/fast_browser_link.py')
entry=next((path for path in candidates if path.is_file()),None)
if entry is None:sys.exit('Fast-browser-link 尚未初始化：在下载包运行 python3 -B -m fbl setup，再运行 fbl doctor。')
if 'plugins' in entry.parts:os.environ.setdefault('FAST_BROWSER_LINK_HOME',str(entry.parents[3]))
runpy.run_path(str(entry),run_name='__main__')
