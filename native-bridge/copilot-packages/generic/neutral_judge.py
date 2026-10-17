"""中性示例：不内置商业阈值，缺本机策略时明确保持无档位。"""
import json
import sys
value=json.load(sys.stdin)
rows=[{**row,'tier':'info','reason':'No local tier policy configured; verify intent and missing evidence.'} for row in value.get('records',[])]
print(json.dumps({'records':rows,'source':'generic neutral policy','missing':['No local tier policy configured']}))
