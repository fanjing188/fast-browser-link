"""离线示例取数器：不伪造评分，实际接口由本机扩展实现。"""
import json
import sys
params=json.load(sys.stdin)
print(json.dumps({'source':'example-seo-tool; offline example; no measured rating','rating':None}))
