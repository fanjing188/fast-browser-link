"""虚构本机能力；只输出合成数据，不联网，不读真实池。"""
import json
from pathlib import Path
import sys
import time
value=json.load(sys.stdin);cap=sys.argv[1]
if len(sys.argv)>2:
 with Path(sys.argv[2]).open('a') as handle:handle.write(json.dumps({'capability':cap,'input':value})+'\n')
words=value.get('keywords') or ([value['keyword']] if value.get('keyword') else [row['keyword'] for row in value.get('records',[]) if row.get('keyword')]);domains=value.get('domains') or ([value['domain']] if value.get('domain') else [])
rows=[]
if cap=='serp.top':
 rows=[{'keyword':word,'rank':index,'domain':f'site{index}.example.test','url':f'https://site{index}.example.test/tool','title':'Synthetic tool','page_type':'tool','is_home':0} for word in words for index in range(1,value.get('n',10)+1)]
elif cap=='domain.authority':rows=[{'domain':domain,'traffic':int(''.join(char for char in domain if char.isdigit()) or 1)*100,'authority':5,'reg_date':'2026-01-01','weak':True} for domain in domains]
elif cap=='domain.keywords':rows=[{'keyword':word,'domain':domains[0],'url':'https://'+domains[0]+'/tool','vol':555,'kd':8} for word in ['shared tool',domains[0]+' tool']]
elif cap=='domain.top_pages':rows=[{'domain':domain,'url':'https://'+domain+'/tool','traffic':100} for domain in domains]
elif cap in ('keyword.expand','keyword.questions'):rows=[{'keyword':'shared tool'},{'keyword':'another tool'}]
elif cap=='keyword.metrics':rows=[{'keyword':word,'vol':123,'kd':4,'cpc':2,'trend12':[10]*12} for word in words]
elif cap=='keyword.filter':rows=value.get('records',[])
elif cap=='keyword.judge':rows=[{**row,'tier':'fixture-tier' if row.get('vol') is not None and row.get('kd') is not None and row.get('serp_json') else 'missing','reason':'Synthetic local judgment'} for row in value.get('records',[])]
elif cap=='pool.lookup':rows=[{**row,'host':'fixture-host','host_duplicate':0} for row in value.get('records',[])]
elif cap=='site.page_family':rows=[{'url':'https://site.example.test/tools/sibling','domain':'site.example.test'}]
elif cap=='trends.series':
 print(json.dumps({'series':[{'keyword':word,'region':'US','period':'12m','points':[{'date':'2026-02','value':80},{'date':'2026-03','value':40}]} for word in words],'source':'synthetic series'}));raise SystemExit(0)
elif cap=='pool.save':
 print(json.dumps({'written':len(value.get('records',[])),'accepted_keywords':words,'skipped':[],'source':'synthetic pool'}));raise SystemExit(0)
print(json.dumps({'records':rows,'source':'synthetic '+cap}))
