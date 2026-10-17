"""支持并发独立会话的 ACP 执行替身；不联网、不执行真实工具。"""
import json
from fake_result import judgment
import os
from pathlib import Path
import sys
import threading
import time
import uuid
lock=threading.RLock();sessions={};permissions={}

def log(value):
    with lock:
        with Path('exec-acp-requests.jsonl').open('a') as handle:handle.write(json.dumps(value)+'\n')

def send(value):
    with lock:print(json.dumps(value),flush=True)

def chunk(session,text):send({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':session,'update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':text}}}})

def reply(request,result):send({'jsonrpc':'2.0','id':request['id'],'result':result})

log({'pid':os.getpid()})
def prompt(request):
    params=request['params'];session=params['sessionId'];state=sessions[session];text=params['prompt'][0]['text']
    if text in {'/tools','/reset'}:
        chunk(session,('Available tools (1): terminal' if '--has-tools' in sys.argv else 'No tools available.') if text=='/tools' else 'Conversation history cleared.')
        reply(request,{'stopReason':'end_turn'});return
    brief=json.loads(text);mode=brief['params'].get('keyword','')
    if mode=='crash' and ('--crash-always' in sys.argv or not Path('crashed-once').exists()):
        Path('crashed-once').touch();os._exit(4)
    if mode=='permission':
        key=uuid.uuid4().hex;event=threading.Event();permissions[key]=event
        send({'jsonrpc':'2.0','id':key,'method':'session/request_permission','params':{'sessionId':session,'toolCall':{'kind':'execute','rawInput':{'command':'rm -rf /private/secret'}},'options':[{'optionId':'allow_once','kind':'allow_once'}]}})
        event.wait(3)
    if mode=='hold':
        while not state['cancel'].is_set() and not Path('release').exists():time.sleep(.01)
    value=judgment(brief)
    chunk(session,json.dumps(value));reply(request,{'stopReason':'cancelled' if state['cancel'].is_set() else 'end_turn','usage':{'inputTokens':110,'cachedReadTokens':80,'outputTokens':5,'totalTokens':115}})

for line in sys.stdin:
    request=json.loads(line);log(request);method=request.get('method');params=request.get('params',{})
    if not method:
        if request.get('id') in permissions:permissions[request['id']].set()
        continue
    if method=='initialize':reply(request,{'protocolVersion':1,'agentCapabilities':{}})
    elif method=='session/new':
        session=uuid.uuid4().hex;sessions[session]={'cancel':threading.Event()}
        reply(request,{'sessionId':session,'models':{'currentModelId':'openai-codex:gpt-5.6-luna','availableModels':[{'modelId':'openai-codex:gpt-5.6-luna','name':'Luna'}]}})
    elif method=='session/set_model':reply(request,{})
    elif method=='session/cancel':sessions[params['sessionId']]['cancel'].set()
    elif method=='session/prompt':threading.Thread(target=prompt,args=(request,),daemon=True).start()
    else:send({'jsonrpc':'2.0','id':request['id'],'error':{'code':-32601}})
