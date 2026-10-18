"""可信设置页的固定目录操作；目录选择不占用请求线程或协作锁。"""
from pathlib import Path
import subprocess
import sys
import threading
import uuid


CHOOSE_SCRIPT = '''try
return POSIX path of (choose folder with prompt "选择默认导出目录")
on error number -128
return ""
end try'''
METHODS = {'directory_defaults', 'directory_choose_start', 'directory_choose_status',
           'directory_choose_cancel', 'directory_open_logs'}


def export_directory(value):
    if not isinstance(value, str) or not value or len(value) > 4096 or any(ord(c) < 32 for c in value):
        raise ValueError('invalid export directory')
    path = Path(value).expanduser()
    if not path.is_absolute() or any(part.is_symlink() for part in (path, *path.parents)):
        raise ValueError('unsafe export directory')
    if path.exists() and not path.is_dir():
        raise ValueError('export path is not a directory')
    return str(path)


class Directories:
    def __init__(self, directory):
        self.logs = Path(directory).absolute() / 'logs'
        self.lock = threading.Lock()
        self.jobs = {}
        self.closed = False

    @staticmethod
    def _view(job):
        return {key: job[key] for key in ('id', 'status', 'path', 'error') if key in job}

    def request(self, instance, method, params):
        if not isinstance(params, dict) or method not in METHODS:
            raise ValueError('invalid directory request')
        expected = {'id'} if method in {'directory_choose_status', 'directory_choose_cancel'} else set()
        if set(params) != expected:
            raise ValueError('invalid directory parameters')
        with self.lock:
            if self.closed:
                raise ValueError('directory service closed')
            if method == 'directory_defaults':
                return {'export_dir': str(Path.home() / 'Downloads' / 'fast-browser-link'), 'logs_dir': str(self.logs)}
            if method == 'directory_open_logs':
                if any(part.is_symlink() for part in (self.logs, *self.logs.parents)):
                    raise ValueError('unsafe logs directory')
                self.logs.mkdir(parents=True, exist_ok=True, mode=0o700)
                subprocess.run(['/usr/bin/open' if sys.platform == 'darwin' else 'xdg-open', str(self.logs)],
                               check=True, timeout=5, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return {'opened': True}
            if method == 'directory_choose_start':
                current = next((job for job in self.jobs.values() if job['owner'] == instance and job['status'] == 'pending'), None)
                if current:
                    return self._view(current)
                # 中文注释：只保留有界最近记录，活跃选择最多 16 个，防止重复请求堆积线程。
                if sum(job['status'] == 'pending' for job in self.jobs.values()) >= 16:
                    raise ValueError('directory chooser busy')
                while len(self.jobs) >= 32:
                    oldest = next(key for key, job in self.jobs.items() if job['status'] != 'pending')
                    del self.jobs[oldest]
                job = {'id': uuid.uuid4().hex, 'owner': instance, 'status': 'pending', 'process': None}
                self.jobs[job['id']] = job
                job['thread'] = threading.Thread(target=self._choose, args=(job,), daemon=True)
                job['thread'].start()
                return self._view(job)
            identity = params['id']
            job = self.jobs.get(identity) if isinstance(identity, str) else None
            if not job or job['owner'] != instance:
                raise ValueError('directory selection unavailable')
            if method == 'directory_choose_cancel' and job['status'] == 'pending':
                job['status'] = 'cancelled'
                if job['process']:
                    self._kill(job['process'])
            return self._view(job)

    @staticmethod
    def _kill(process):
        try:
            process.kill()
        except ProcessLookupError:
            pass

    def _reap(self, process):
        try:
            if process.returncode is None:
                self._kill(process)
            process.wait(timeout=5)
        finally:
            for stream in (process.stdout, process.stderr):
                if stream is not None:
                    stream.close()

    def _choose(self, job):
        process = None
        try:
            with self.lock:
                if self.closed or job['status'] != 'pending':
                    return
                if sys.platform != 'darwin':
                    job.update(status='error', error='unsupported_platform')
                    return
                process = subprocess.Popen(['/usr/bin/osascript', '-e', CHOOSE_SCRIPT],
                                           stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
                job['process'] = process
            output, _ = process.communicate(timeout=120)
            if process.returncode:
                result = {'status': 'error', 'error': 'picker_failed'}
            elif not output.rstrip('\r\n'):
                result = {'status': 'cancelled'}
            else:
                path = export_directory(output.rstrip('\r\n'))
                if not Path(path).is_dir():
                    raise ValueError('selected directory missing')
                result = {'status': 'selected', 'path': path}
        except subprocess.TimeoutExpired:
            result = {'status': 'timeout', 'error': 'picker_timeout'}
        except (OSError, ValueError):
            result = {'status': 'error', 'error': 'picker_failed'}
        finally:
            if process is not None:
                try:
                    self._reap(process)
                except (OSError, subprocess.SubprocessError):
                    result = {'status': 'error', 'error': 'picker_failed'}
        with self.lock:
            job['process'] = None
            if job['status'] == 'pending':
                job.update(result)

    def close(self):
        with self.lock:
            self.closed = True
            threads = []
            for job in self.jobs.values():
                if job['status'] == 'pending':
                    job['status'] = 'cancelled'
                    if job['process']:
                        self._kill(job['process'])
                threads.append(job['thread'])
        for thread in threads:
            thread.join(timeout=.5)
