// 中文注释：语义文本仅规范空白；密码输入值由控件读取层排除。
export function createPageTextRedactor(){
 return text=>String(text).replace(/\s+/g,' ').trim();
}
