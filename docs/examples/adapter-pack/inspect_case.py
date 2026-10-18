"""离线适配包示例：只读取随包提供的合成工单，不调用网络。"""
import json
from pathlib import Path
import sys

if '--help' in sys.argv:
    print('Read one bundled synthetic case from stdin JSON {"keyword":"invoice"}; emit records/source/missing.')
else:
    request=json.load(sys.stdin)
    case=json.loads((Path(__file__).parent/'cases.json').read_text()).get(request.get('keyword'))
    print(json.dumps({'records':[case] if case else [],'source':'bundled synthetic support cases','missing':[] if case else ['case not found in the synthetic example']},ensure_ascii=False))
