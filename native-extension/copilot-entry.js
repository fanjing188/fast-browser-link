// 中文注释：动态注册的入口保持普通脚本；实现模块在隔离世界中加载。
void import(chrome.runtime.getURL('copilot-collector.mjs')+'?i='+crypto.randomUUID()).then(module=>module.start()).catch(()=>{});
