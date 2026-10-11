// 中文注释：只采集密码输入框的当前值，供输出脱敏；不限制输入动作。
export function passwordValues(){
 const values=new Set(),roots=[document],seen=new Set();
 while(roots.length){
  const root=roots.pop();if(seen.has(root))continue;seen.add(root);
  for(const node of root.querySelectorAll('*')){
   if(node.localName==='input'&&node.type==='password'){if(node.value)values.add(node.value);if(node.getAttribute('value'))values.add(node.getAttribute('value'));}
   const shadow=node.shadowRoot||globalThis.__hermesClosedShadowRoots?.get(node);
   if(shadow)roots.push(shadow);
   if(node.localName==='iframe'){try{if(node.contentDocument)roots.push(node.contentDocument);}catch{}}
  }
 }
 return [...values];
}
export function omitPasswordValues(value,values){
 if(typeof value==='string'){
  for(const password of [...values].filter(Boolean).sort((a,b)=>b.length-a.length))value=value.split(password).join('[password]');
  return value;
 }
 if(Array.isArray(value))return value.map(item=>omitPasswordValues(item,values));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,omitPasswordValues(item,values)]));
 return value;
}
