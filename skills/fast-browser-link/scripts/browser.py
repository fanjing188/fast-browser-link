#!/usr/bin/env python3
"""调用安装器登记的本地运行时；不依赖 agent 专属工具配置。"""
from pathlib import Path
import os
import runpy
import sys
root = Path(os.environ.get('FAST_BROWSER_LINK_HOME', Path.home() / '.fast-browser-link'))
entry = root / 'runtime/agent-link/fast_browser_link.py'
if not entry.is_file():
    sys.exit('Fast-browser-link 尚未初始化，请先运行项目 install.sh。')
runpy.run_path(str(entry), run_name='__main__')
