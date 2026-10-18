"""统一用量口径：输入不含缓存读，三类token仅用于信息统计。"""


def counts(input_tokens=0,cache_read_tokens=0,output_tokens=0):
    return {'input':max(0,int(input_tokens)),'cache_read':max(0,int(cache_read_tokens)),'output':max(0,int(output_tokens))}


def from_metrics(metrics):
    if isinstance(metrics.get('usage'),dict):
        value=metrics['usage']
        return counts(value.get('input',0),value.get('cache_read',0),value.get('output',0))
    return counts(metrics.get('tokens',0))


def add(target,usage):
    for key in ('input','cache_read','output'):target[key]=target.get(key,0)+usage[key]


def stream_metrics(event,result_bytes=0,seconds=0):
    raw=event.get('tokens',{})
    detailed=isinstance(raw,dict) and all(type(raw.get(key)) is int for key in ('input','cache_read','output'))
    if detailed:
        usage=counts(raw['input'],raw['cache_read'],raw['output'])
    else:
        total=raw.get('total') if isinstance(raw,dict) else None
        usage=counts(total if type(total) is int else (result_bytes+3)//4)
    return {'usage':usage,'tokens':sum(usage.values()),'estimated':not detailed,
            'source':'hermes.stream-json.usage' if detailed else 'estimated_execution_usage_split',
            'seconds':seconds,'input_bytes':0,'estimated_input_tokens':0}
