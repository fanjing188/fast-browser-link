// 中文注释：首次清单独立于看板重绘；全就绪后移除，诊断不自动写配置。
export function renderReadiness(doc,value,{repair,discover,language='zh'}={}){
 let root=doc.getElementById('fbl-readiness');
 if(value?.ready){root?.remove();return;}
 if(!root){root=doc.createElement('section');root.id='fbl-readiness';root.className='confirmation-card';(doc.getElementById('advanced-settings')||doc.querySelector('main'))?.append(root);}
 root.replaceChildren();const en=!language.startsWith('zh');
 const labels={setup:en?'Initialize':'初始化',browser:en?'Browser connection':'浏览器连接',integrity:en?'Installed files differ from release · Run fbl update':'安装文件与发布包不一致 · 运行 fbl update',templates:en?'Templates':'模板',profiles:en?'Hermes profiles':'Hermes 配置',discovery:en?'Discover tools':'发现工具'};
 for(const item of value?.items||[]){const row=doc.createElement('div');row.className='readiness-row';const label=doc.createElement('span');label.textContent=`${item.ok?'✓':'○'} ${labels[item.id]||item.id}`;row.append(label);
  if(!item.ok){const button=doc.createElement('button');button.type='button';button.textContent=item.id==='discovery'?(en?'Discover':'发现'):(item.repairable||['browser','templates'].includes(item.id))?(en?'Repair':'修复'):item.command;button.onclick=async()=>{button.disabled=true;try{if(item.id==='discovery')await discover();else if(item.repairable||['browser','templates'].includes(item.id))await repair();else{const code=doc.createElement('code');code.textContent=item.command;row.append(code);}}finally{button.disabled=false;}};row.append(button);}root.append(row);
 }
}
export function renderChains(doc,root,chains,language='zh'){
 if(!root)return;root.replaceChildren();const en=!language.startsWith('zh');
 const labels={extension:en?'Extension':'扩展',host:en?'Host':'宿主',daemon:en?'Daemon':'后台服务',inference:en?'Inference':'推理',execution:en?'Execution':'执行'};
 for(const [key,ok] of Object.entries(chains)){const span=doc.createElement('span');span.className='status-component';span.dataset.state=ok===true?'connected':ok===null?'connecting':'error';span.textContent=labels[key]||key;root.append(span);}
}
