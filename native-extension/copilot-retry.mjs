// 中文注释：重试归后台持有，面板重绘/重开不会重置次数；只重建推理会话，不重放任务。
export class SessionRetry {
  constructor(start, { schedule = setTimeout, cancel = clearTimeout } = {}) {
    this.start = start;
    this.schedule = schedule;
    this.cancel = cancel;
    this.attempts = 0;
    this.timer = null;
    this.generation = 0;
    this.recovery = false;
  }
  reset() {
    this.generation++;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.attempts = 0;
    this.recovery = false;
  }
  failed(recovery = false) {
    this.recovery ||= recovery;
    if (this.timer !== null || this.attempts >= 3) return;
    const delay = [5000, 15000, 60000][this.attempts++],
      generation = this.generation;
    this.timer = this.schedule(async () => {
      this.timer = null;
      if (generation !== this.generation) return;
      try {
        await this.start();
      } catch {
        if (generation === this.generation) this.failed();
      }
    }, delay);
  }
}
