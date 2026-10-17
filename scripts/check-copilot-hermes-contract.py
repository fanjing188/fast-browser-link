"""只读运行 Hermes 参数解析/过滤函数，并检查到 agent 的参数接线；不启动模型。"""
import argparse
import ast
import importlib.util
import json
from pathlib import Path
from typing import Any,Optional
import types


def function(source,name,namespace):
    tree=ast.parse(source.read_text())
    node=next(node for node in ast.walk(tree) if isinstance(node,ast.FunctionDef) and node.name==name)
    exec(compile(ast.Module(body=[node],type_ignores=[]),str(source),'exec'),namespace)
    return namespace[name]


def check(root):
    root=Path(root)
    spec=importlib.util.spec_from_file_location('checked_hermes_parser',root/'hermes_cli/_parser.py')
    parser_module=importlib.util.module_from_spec(spec);spec.loader.exec_module(parser_module)
    parser_module._cfg_path=lambda:'config.yaml'
    parser,_,_=parser_module.build_top_level_parser()
    args=parser.parse_args(['chat','--oneshot','-Q','--format','stream-json','--source','copilot','--query-file','query.txt',
                           '-t','fast-browser-link,web,terminal,file','-m','fixture-fast','--max-turns','30'])
    assert args.max_turns==30 and args.model=='fixture-fast' and args.oneshot_exit
    namespace={'Any':Any,'TURN_LIMIT_UNLIMITED':2**63-1,'_UNLIMITED_SPELLINGS':set()}
    limit=function(root/'hermes_cli/config.py','resolve_turn_limit',namespace)(args.max_turns)
    assert limit==30
    namespace={'Optional':Optional}
    selected=function(root/'hermes_cli/mcp_startup.py','set_mcp_server_filter',namespace)(args.toolsets)
    assert selected==['fast-browser-link','web','terminal','file']
    configured={'irrelevant-server','cloud-service','search-service'}
    assert not configured.intersection(selected)
    setup=ast.parse((root/'hermes_cli/cli_agent_setup_mixin.py').read_text())
    pairs={node.arg:ast.unparse(node.value) for node in ast.walk(setup) if isinstance(node,ast.keyword) and node.arg in {'max_iterations','enabled_toolsets'}}
    assert pairs['max_iterations']=='self.max_turns' and pairs['enabled_toolsets']=='self.enabled_toolsets'
    loop=(root/'agent/conversation_loop.py').read_text()
    assert 's.api_call_count < agent.max_iterations' in loop
    return {'parser':{'model':args.model,'max_turns':limit,'toolsets':args.toolsets,'source':args.source},
            'synthetic_unrelated_mcp_filter_matches':0,'agent_wiring':pairs,
            'limit_semantics':'30 ordinary iterations; Hermes may make a final summary/grace request',
            'scope':'real parser and extracted source functions executed; wiring statically checked; no provider call'}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hermes-source',type=Path,required=True)
    args=parser.parse_args();print(json.dumps(check(args.hermes_source),ensure_ascii=False,indent=2))
