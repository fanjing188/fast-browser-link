// 中文注释：语义与兼容读取共用内容脱敏；所有来源显示邮箱，其他敏感信息继续遮挡。
export function createPageTextRedactor(){
  function quotedValueEnd(text,start,quote){
    for(let i=start+1;i<text.length;i++){
      if(text[i]==='\\'){i++;continue;}
      if(text[i]===quote)return i;
    }
    return -1;
  }
  // A quoted value is structured only when its closing quote is followed by a separator.
  function quoteHasBoundary(text,end){return end===text.length || /[\s|,;)}\]]/.test(text[end]);}
  // Unquoted values are ambiguous; only a balanced quoted value can expose following text.
  function sensitiveMarkers(text){
    const markers=new Set();
    const label=/\b(password|passwd|token|secret|api[-_ ]?key)\s*[:=]/gi;
    for(const match of text.matchAll(label))markers.add(`${match[1]}=[redacted]`);
    if(/\bBearer\s+/i.test(text))markers.add('Bearer [redacted]');
    if(/\[number\]/i.test(text))markers.add('[number]');
    return [...markers].join(' ');
  }
  function redactLabeledValues(text){
    const label=/\b(password|passwd|token|secret|api[-_ ]?key)\s*[:=]\s*/gi;
    let out='',cursor=0,match;
    while((match=label.exec(text))){
      if(match.index<cursor)continue;
      out+=text.slice(cursor,match.index);
      const start=label.lastIndex,quote=text[start];
      if(quote==='"' || quote==="'"){
        const end=quotedValueEnd(text,start,quote);
        out+=`${match[1]}=[redacted]`;
        if(end<0 || !quoteHasBoundary(text,end+1)){
          cursor=text.length;label.lastIndex=cursor;break;
        }
        cursor=end+1;label.lastIndex=cursor;
      }else{
        out+=`${match[1]}=[redacted]`;
        const markers=sensitiveMarkers(text.slice(start));if(markers)out+=` ${markers}`;
        cursor=text.length;label.lastIndex=cursor;break;
      }
    }
    return out+text.slice(cursor);
  }
  function redactBearerValues(text){
    const bearer=/\bBearer\s+/gi;
    let out='',cursor=0,match;
    while((match=bearer.exec(text))){
      if(match.index<cursor)continue;
      out+=text.slice(cursor,match.index);
      const start=bearer.lastIndex,quote=text[start];
      out+='Bearer [redacted]';
      if(quote==='"' || quote==="'"){
        const end=quotedValueEnd(text,start,quote);
        if(end<0 || !quoteHasBoundary(text,end+1)){
          cursor=text.length;bearer.lastIndex=cursor;break;
        }
        cursor=end+1;bearer.lastIndex=cursor;
      }else{
        const markers=sensitiveMarkers(text.slice(start));if(markers)out+=` ${markers}`;
        cursor=text.length;bearer.lastIndex=cursor;break;
      }
    }
    return out+text.slice(cursor);
  }
  // Scrub the same nonprinting C0/C1 ranges before credential parsing.
  function stripNonprintingControls(text){
    let out='',start=0;
    for(let index=0;index<text.length;index++){
      const code=text.charCodeAt(index);
      if(code<=0x08 || (code>=0x0b&&code<=0x0c) || (code>=0x0e&&code<=0x1f) || (code>=0x7f&&code<=0x9f)){
        out+=text.slice(start,index);start=index+1;
      }
    }
    return out+text.slice(start);
  }
  return function redact(text){
    let safe=stripNonprintingControls(String(text));
    safe=safe.replace(/\b(?:\d[ -]?){13,19}\b/g,'[number]');
    return redactBearerValues(redactLabeledValues(safe)).replace(/\s+/g,' ').trim();
  };
}
