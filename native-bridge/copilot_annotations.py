"""页面标注只读取已取得的本机证据；不通过划词查询隐式启动外部命令。"""
import json
from pathlib import Path
import threading
import time
import unicodedata
from urllib.parse import urlsplit


def object_key(kind, value):
    if kind not in {'keyword', 'domain', 'url', 'table'} or not isinstance(value, str) or not value.strip() or len(value) > 4000:
        raise ValueError('invalid page object')
    value = unicodedata.normalize('NFKC', value).strip()
    if kind in {'domain', 'url'}:
        parsed = urlsplit(value if '://' in value else 'https://' + value)
        if parsed.scheme not in {'http', 'https'} or not parsed.hostname or '.' not in parsed.hostname or parsed.username or parsed.password:
            raise ValueError('invalid object URL')
        value = parsed.hostname.casefold() if kind == 'domain' else parsed._replace(fragment='').geturl()
    else:
        value = ' '.join(value.casefold().split())
    return kind + ':' + value


class AnnotationMemory:
    def __init__(self, directory, write):
        self.path = Path(directory) / 'page-memory.json'
        self.write = write
        self.lock = threading.RLock()
        self.records = {}
        if self.path.exists():
            if self.path.is_symlink():
                raise ValueError('annotation memory symlink')
            value = json.loads(self.path.read_text())
            if not isinstance(value,dict) or value.get('version') != 1 or not isinstance(value.get('records'), dict):
                raise ValueError('invalid annotation memory')
            self.records = value['records']

    def ingest(self, records, *, pool=(), checked=True, analyzed=False, at=None):
        allowed = {'keyword', 'domain', 'url', 'vol', 'kd', 'tier', 'authority', 'authority_kind', 'weak', 'small_site', 'source', 'metric_quality'}
        pool = {object_key('keyword', word) for word in pool}
        with self.lock:
            for record in records:
                for kind in ('keyword', 'domain', 'url'):
                    if not record.get(kind):
                        continue
                    try:
                        key = object_key(kind, record[kind])
                    except ValueError:
                        continue
                    clean = {field: value for field, value in record.items() if field in allowed and (field not in {'keyword','domain','url'} or field==kind)}
                    old = self.records.get(key, {})
                    timestamp=(at.get(key) if isinstance(at,dict) else at) if at is not None else time.time()
                    if checked and timestamp and old.get('checked_at') and timestamp<old['checked_at']:continue
                    self.records[key] = {**old, **clean, 'checked_at': ((at.get(key) if isinstance(at,dict) else at) if at is not None else time.time()) if checked else old.get('checked_at'), 'pool': key in pool or old.get('pool', False), 'analyzed': kind == 'domain' and analyzed or old.get('analyzed', False)}
            for key in pool:
                self.records.setdefault(key, {})['pool'] = True
            self.records = dict(list(self.records.items())[-10000:])
            self.write(self.path, json.dumps({'version': 1, 'records': self.records}, ensure_ascii=False))

    def result(self, row, pool=()):
        from copilot_results import words
        result=row.get('result',{})
        records=list(result.get('records',words(result)))
        records+=result.get('serp',[])+result.get('results',[])
        for item in result.get('checks',[]):records+=item.get('serp',[])
        records+=result.get('top_pages',[])
        if row.get('action')=='seo.domain_rating' and result.get('domain'):
            records.append({'domain':result['domain'],'authority':result.get('rating'),'source':result.get('source','')})
        analyzed=row.get('action')=='seo.competitor_keywords' or row.get('params',{}).get('flow')=='basket-competitors'
        if analyzed and result.get('domain'):records.append({'domain':result['domain']})
        self.ingest(records,pool=pool,analyzed=analyzed,at=row.get('finished_at'))

    def lookup(self, objects):
        if not isinstance(objects, list) or len(objects) > 300 or len(json.dumps(objects,ensure_ascii=False).encode())>100000:
            raise ValueError('annotation object limit')
        result = {}
        with self.lock:
            for obj in objects:
                if not isinstance(obj, dict) or set(obj) != {'type', 'value'}:
                    raise ValueError('invalid annotation object')
                key = object_key(obj['type'], obj['value'])
                record = self.records.get(key)
                if record:
                    result[key] = {field:value for field,value in record.items() if field in {'vol','kd','tier','authority','authority_kind','weak','small_site','source','metric_quality','checked_at','pool','analyzed'}}
        return result


def local_lookup(app, instance, objects):
    from copilot_results import words as result_words
    existing=app.annotation_memory.lookup(objects)
    from copilot_risk import automatic_binding
    candidates=[binding for binding in app.registry.candidates('pool.lookup') if binding['type']=='command' and automatic_binding(binding) and app.registry.structural(binding,{})=='available']
    words=[obj['value'] for obj in objects if obj['type']=='keyword' and not existing.get(object_key('keyword',obj['value']),{}).get('pool')]
    signature='|'.join(words)
    last=getattr(app,'annotation_pool_at',{})
    if words and candidates and time.monotonic()-last.get(signature,-1000)>60:
        import hashlib
        last[signature]=time.monotonic();app.annotation_pool_at=dict(list(last.items())[-300:])
        try:
            output=app.registry.execute('pool.lookup',{'keywords':words},app.directory/'tasks'/('annotation-pool-'+hashlib.sha256(signature.encode()).hexdigest()[:20]),threading.Event(),{'automatic':True,'local_only':True,'approved_bindings':[candidates[0]['id']]})
            found=[record for record in output.get('records',[]) if record.get('keyword') and object_key('keyword',record['keyword']) in {object_key('keyword',word) for word in words}]
            if found:app.annotation_memory.ingest(found,pool=[record['keyword'] for record in found],checked=False)
        except (OSError,ValueError,RuntimeError):pass
    records=[];dates={}
    for obj in objects:
        key=object_key(obj['type'],obj['value'])
        if obj['type']!='keyword' or key in existing:continue
        cached=app._cached({'action':'seo.keyword_check','params':{'keyword':obj['value']}})
        if cached:
            try:at=json.loads(app._cache_path({'action':'seo.keyword_check','params':{'keyword':obj['value']}}).read_text()).get('at')
            except (OSError,ValueError):at=None
            records.extend(result_words(cached));dates[key]=at
    if records:app.annotation_memory.ingest(records,at=dates)
    return app.annotation_memory.lookup(objects)
