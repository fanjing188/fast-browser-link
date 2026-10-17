"""纯离线取数替身，不联网、不读凭据。"""
import json
import sys
params=json.load(sys.stdin)
value={'results':[{'url':'https://example.test/tool','title':'Synthetic tool'}],'source':'fixture SERP'} if sys.argv[1]=='serp_top10' else {'keywords':[{'keyword':word,'vol':42,'kd':7} for word in params.get('keywords',[params.get('keyword','sample keyword')])],'source':'fixture metrics'}
print(json.dumps(value))
