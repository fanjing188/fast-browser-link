"""本机扩展包加载；声明只能扩展数据与任务，不授予浏览器权限。"""
import copy
import json
from pathlib import Path
from copilot_results import UNIFIED
import re
from urllib.parse import urlsplit


def read_package(directory):
    root=Path(directory).expanduser().resolve()
    path=root/'package.json'
    if path.is_symlink() or path.stat().st_size>131072:raise ValueError('unsafe extension package')
    value=json.loads(path.read_text())
    if not isinstance(value,dict) or set(value)-{'id','version','fetchers','pool','rules','tools','templates','prompts','workflows','capabilities','flows','experience','experience_file','schemas','files','name','description','release'} or not isinstance(value.get('id'),str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,63}',value['id']) or type(value.get('version')) is not int or value['version']!=1:raise ValueError('invalid extension package')
    for field,limit in (('name',120),('description',500)):
        if field in value and (not isinstance(value[field],str) or not value[field].strip() or len(value[field])>limit):raise ValueError('invalid package metadata')
    if 'release' in value and (not isinstance(value['release'],str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+',value['release'])):raise ValueError('invalid package release')
    for name in ('fetchers','pool','rules','templates','prompts','workflows','capabilities','flows','schemas'):
        if not isinstance(value.get(name,{}),dict):raise ValueError('invalid package section')
    return root,value


class Packages:
    def __init__(self,directories=(),include_builtin=True):
        self.bindings={};self.flows={};self.experience='';self.experiences=[];self.schemas={};self.workflows={};self.fetchers={};self.pool={};self.rules={'description':{'en':'Judge intent and evidence. Missing metrics are unknown, never zero. No fixed volume or difficulty gate.','zh':'按意图与证据判断；缺指标为未知，不按零处理；没有固定量或难度门槛。'}};self.tools=[];self.templates={};self.prompts={};seen=set()
        builtin=Path(__file__).parent/'copilot-packages/generic'
        for directory in ([builtin] if include_builtin else [])+list(directories):
            root,value=read_package(directory)
            if value['id'] in seen:raise ValueError('duplicate extension package')
            seen.add(value['id'])
            for name,command in value.get('fetchers',{}).items():
                if not re.fullmatch(r'[a-z][a-z0-9_]{0,63}',name) or not isinstance(command,list) or not command or any(not isinstance(arg,str) or not arg for arg in command):raise ValueError('invalid extension fetcher')
                self.fetchers[name]=[str(root/arg[2:]) if arg.startswith('./') else arg for arg in command]
            pool=value.get('pool',{})
            if not isinstance(pool,dict) or set(pool)-{'command','lookup_command'}:raise ValueError('invalid extension pool')
            for name,command in pool.items():
                if not isinstance(command,list) or not command or any(not isinstance(arg,str) or not arg for arg in command):raise ValueError('invalid pool command')
                self.pool[name]=[str(root/arg[2:]) if arg.startswith('./') else arg for arg in command]
            if not isinstance(value.get('rules',{}),dict):raise ValueError('invalid extension rules')
            self.rules.update(value.get('rules',{}))
            tools=value.get('tools',[])
            if not isinstance(tools,list) or len(tools)>30:raise ValueError('invalid extension tools')
            for tool in tools:
                if not isinstance(tool,dict) or set(tool)-{'id','hosts','name','links','pages','probe','cost','batch_limit','serial_group','disable_on'} or not isinstance(tool.get('id'),str) or not isinstance(tool.get('hosts'),list) or any(not isinstance(host,str) for host in tool['hosts']):raise ValueError('invalid tool profile')
                for page in tool.get('pages',[]):
                    if not isinstance(page,dict) or not isinstance(page.get('id'),str) or not isinstance(page.get('paths'),list) or any(not isinstance(pattern,str) or len(pattern)>400 for pattern in page['paths']):raise ValueError('invalid tool page')
                    if not isinstance(page.get('table_selectors',[]),list) or any(not isinstance(item,str) or len(item)>400 for item in page.get('table_selectors',[])):raise ValueError('invalid table selector')
                    for field,aliases in page.get('columns',{}).items():
                        if field not in UNIFIED['properties'] or not isinstance(aliases,list) or not aliases or any(not isinstance(alias,str) for alias in aliases):raise ValueError('invalid column mapping')
                    for pattern in page['paths']:re.compile(pattern)
                for value_ in tool.get('links',{}).values():
                    if not isinstance(value_,str) or urlsplit(value_).scheme not in {'http','https'} or urlsplit(value_).hostname not in tool['hosts'] or urlsplit(value_).username or urlsplit(value_).password:raise ValueError('invalid tool link')
                if any(set(existing['hosts'])&set(tool['hosts']) for existing in self.tools):raise ValueError('duplicate tool host')
                if any(existing['id']==tool['id'] for existing in self.tools):raise ValueError('duplicate tool id')
                self.tools.append(copy.deepcopy(tool))
            for action,relative in value.get('templates',{}).items():
                if not re.fullmatch(r'(?:seo|general|browser|local)\.[a-z_]+',action) or not isinstance(relative,str):raise ValueError('invalid package template')
                file=(root/relative).resolve()
                if not file.is_relative_to(root) or not file.is_file() or file.stat().st_size>131072:raise ValueError('unsafe package template')
                self.templates[action]=json.loads(file.read_text())
            for action,prompts in value.get('prompts',{}).items():
                if not isinstance(prompts,dict) or set(prompts)-{'en','zh'} or any(not isinstance(text,str) or len(text)>12000 for text in prompts.values()):raise ValueError('invalid package prompts')
                self.prompts[action]=dict(prompts)
            for action,flow in value.get('workflows',{}).items():
                if action!='seo.ranking_sites' or not isinstance(flow,dict) or set(flow)!={'seed_fetcher','site_fetcher','max_sites'} or type(flow['max_sites']) is not int or not 1<=flow['max_sites']<=3 or not all(isinstance(flow[name],str) for name in ('seed_fetcher','site_fetcher')):raise ValueError('invalid workflow')
                self.workflows[action]=dict(flow)

            from copilot_capabilities import CAPABILITIES
            schemas=value.get('schemas',{})
            for capability,schema in schemas.items():
                if not re.fullmatch(r'[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*',capability) or set(schema)!={'input','output'}:raise ValueError('invalid capability schema')
                from copilot import check_schema
                check_schema(schema['input']);check_schema(schema['output'])
                self.schemas[capability]=copy.deepcopy(schema)
            for capability,bindings in value.get('capabilities',{}).items():
                if capability not in CAPABILITIES and capability not in self.schemas or not isinstance(bindings,list):raise ValueError('unknown capability')
                for binding in bindings:
                    validate_binding(binding)
                    if capability in {'keyword.judge','keyword.filter','pool.lookup','pool.save'} and binding['type']!='command':raise ValueError('capability must be local command')
                    if any(existing['id']==binding['id'] for entries in self.bindings.values() for existing in entries):raise ValueError('duplicate binding id')
                    clean=copy.deepcopy(binding);clean['_root']=str(root);clean['_package']=value['id']
                    for name in ('argv','plan_argv'):
                        if name in clean:clean[name]=[str(root/arg[2:]) if arg.startswith('./') else arg for arg in clean[name]]
                    self.bindings.setdefault(capability,[]).append(clean)
            for identity,flow in value.get('flows',{}).items():
                if not re.fullmatch(r'[a-z][a-z0-9_.-]{0,63}',identity) or not isinstance(flow,dict) or not flow.get('name') or not isinstance(flow.get('steps'),list) or not 1<=len(flow['steps'])<=30:raise ValueError('invalid workflow plan')
                seen_steps=set();models=0
                for step in flow['steps']:
                    if not isinstance(step,dict) or not re.fullmatch(r'[a-z][a-z0-9_]{0,40}',step.get('id','')) or step['id'] in seen_steps:raise ValueError('invalid step id')
                    seen_steps.add(step['id']);models+=bool(step.get('model'))
                    if step.get('capability') and step['capability'] not in CAPABILITIES and step['capability'] not in self.schemas:raise ValueError('unknown step capability')
                if models>1:raise ValueError('workflow has more than one model turn')
                from copilot_risk import declared
                declared(flow)
                for step in flow['steps']:declared(step)
                self.flows[identity]=copy.deepcopy(flow)
            experience=value.get('experience','')
            if value.get('experience_file'):
                file=(root/value['experience_file']).resolve()
                if not file.is_relative_to(root):raise ValueError('unsafe experience path')
                experience=file.read_text()
            if not isinstance(experience,str) or len(experience)>800:raise ValueError('experience exceeds 800 characters')
            if experience:
                self.experience=experience
                self.experiences.append({'pack':value['id'],'text':experience,'tools':copy.deepcopy(tools)})

        for tool in self.tools:
            groups={binding.get('serial_group','') for bindings in self.bindings.values() for binding in bindings if binding['type']=='browser' and binding.get('tool')==tool['id']}
            if len(groups)>1:raise ValueError('one tool must share one serial group')

    def experience_for(self,url):
        parsed=urlsplit(url)
        def active(row):
            return not row['tools'] or any(parsed.hostname in tool['hosts'] and any(re.search(pattern,parsed.path) for page in tool.get('pages',[]) for pattern in page['paths']) for tool in row['tools'])
        return '\n'.join(row['text'] for row in self.experiences if active(row))[:4000]

    def configure(self,config):
        config['fetch_commands']={**config['fetch_commands'],**self.fetchers}
        if 'command' in self.pool:config['pool_command']=self.pool['command']
        if 'lookup_command' in self.pool:config['pool_lookup_command']=self.pool['lookup_command']


def validate_binding(binding):
    from copilot_risk import declared
    if isinstance(binding,dict):declared(binding)
    if not isinstance(binding,dict) or not re.fullmatch(r'[a-z][a-z0-9_.-]{0,80}',binding.get('id','')) or binding.get('type') not in {'browser','command','hermes','mcp'}:raise ValueError('invalid capability binding')
    if type(binding.get('batch_limit',100)) is not int or not 1<=binding.get('batch_limit',100)<=1000:raise ValueError('invalid batch limit')
    if type(binding.get('priority',100)) is not int or type(binding.get('timeout',120)) is not int or not 1<=binding.get('timeout',120)<=600:raise ValueError('invalid binding bounds')
    if binding['type']=='mcp' and (not all(isinstance(binding.get(key),str) and binding[key] for key in ('config_path','server','tool_name')) or not Path(binding['config_path']).is_absolute()):raise ValueError('invalid MCP binding')
    if binding['type']=='command' and (not isinstance(binding.get('argv'),list) or not binding['argv'] or any(not isinstance(arg,str) or not arg for arg in binding['argv'])):raise ValueError('invalid command argv')
    if 'plan_argv' in binding and (binding.get('type')!='browser' or not isinstance(binding['plan_argv'],list) or not binding['plan_argv'] or any(not isinstance(arg,str) or not arg for arg in binding['plan_argv'])):raise ValueError('invalid query planner argv')
    if 'query_submit' in binding:
        query=binding['query_submit']
        if binding['type']!='browser' or not isinstance(query,dict) or set(query)!={'root','names'} or not isinstance(query['root'],str) or not 1<=len(query['root'])<=400 or not isinstance(query['names'],list) or not 1<=len(query['names'])<=4 or any(not isinstance(name,str) or name not in {'Analyze','Analyse','Search','Apply filters','分析','查询','搜索','应用筛选'} for name in query['names']):raise ValueError('invalid report query control')
    if 'output' in binding and (not isinstance(binding['output'],dict) or binding['output'].get('format','json') not in {'json','csv'} or binding['output'].get('from','stdout') not in {'stdout','file'}):raise ValueError('invalid command output format')
    if binding['type']=='browser' and not all(isinstance(binding.get(key),str) and binding[key] for key in ('tool','page','link')):raise ValueError('invalid browser binding')
    if binding['type']=='browser' and type(binding.get('verified',False)) is not bool:raise ValueError('invalid route verification')
    if binding.get('serial_group') and (not isinstance(binding['serial_group'],str) or len(binding['serial_group'])>120):raise ValueError('invalid serial group')
    for reason,patterns in binding.get('stop_text',{}).items():
        if not isinstance(reason,str) or not isinstance(patterns,list):raise ValueError('invalid stop condition')
        for pattern in patterns:
            if not isinstance(pattern,str) or len(pattern)>400:raise ValueError('invalid stop pattern')
            re.compile(pattern)
