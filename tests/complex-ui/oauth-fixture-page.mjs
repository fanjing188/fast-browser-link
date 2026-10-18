// 中文注释：本地 OAuth 页面共享给完整链路和离线 DOM 回归；没有真实账号、密码或外部请求。
const attribute = (value) =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
export function oauthSourcePage({ origin, loginOrigin, manualOrigin, flow }) {
  const link = (site, pathname) =>
    `${site}${pathname}?flow=${encodeURIComponent(flow)}&source=${encodeURIComponent(origin)}`;
  const button = (name, site, features) =>
    `<button onclick="${attribute(`window.open(${JSON.stringify(link(site, '/oauth-provider'))},${JSON.stringify(features ? 'oauth-' + flow + '-' + name : '_blank')}${features ? ',' + JSON.stringify(features) : ''})`)}">${name}</button>`;
  return `<!doctype html><html lang="zh"><title>只开窗登录验收</title><style>button{display:block;margin:24px;padding:16px}</style><main>
 ${button('只开授权小窗', loginOrigin, 'popup,width=430,height=560')}
 ${button('只开同窗授权标签', loginOrigin, '')}
 ${button('只开非白名单小窗', manualOrigin, 'popup,width=430,height=560')}
 </main><script>
 window.oauthClickCount=0;
 document.addEventListener('click',event=>{if(event.target.localName==='button')window.oauthClickCount++;});
 addEventListener('message',event=>{
  if(${JSON.stringify([loginOrigin, manualOrigin])}.includes(event.origin)&&event.data?.type==='fixture-oauth-complete'&&event.data.flow===${JSON.stringify(flow)})location.href=${JSON.stringify(origin + '/oauth-done?flow=' + encodeURIComponent(flow))};
 });
 </script></html>`;
}
export function oauthProviderPage({
  frameOrigin = 'http://127.0.0.1:9000',
  accountRole = null,
} = {}) {
  const tag = accountRole ? 'div' : 'button',
    role = accountRole ? ` role="${accountRole}" tabindex="0"` : '';
  return `<!doctype html><html lang="zh"><title>本地模拟身份提供方</title><main id="accounts"><ul>${OAUTH_FIXTURE_ACCOUNTS.map((email) => `<li><${tag}${role} class="account" data-email="${email}">${email}</${tag}></li>`).join('')}</ul><button id="complete">完成本地授权</button></main><iframe title="账号页附属框架" src="${attribute(frameOrigin + '/oauth-frame')}" style="position:fixed;right:0;bottom:0;width:2px;height:2px;border:0"></iframe><script>
 const flow=new URLSearchParams(location.search).get('flow'),source=new URLSearchParams(location.search).get('source');
 window.fixtureAccountClicks=0;window.fixtureChosenAccount=null;window.fixtureFrameLoaded=false;
 const frame=document.querySelector('iframe');
 addEventListener('message',event=>{
  if(event.source===frame.contentWindow&&event.origin===${JSON.stringify(frameOrigin)}&&event.data==='fixture-frame-ready')window.fixtureFrameLoaded=true;
 });
 const complete=()=>fetch('/oauth-complete?flow='+encodeURIComponent(flow)+(window.fixtureChosenAccount?'&account='+encodeURIComponent(window.fixtureChosenAccount):'')).then(response=>{
  if(!response.ok)throw Error('fixture authorization failed');
  opener.postMessage({type:'fixture-oauth-complete',flow},source);window.close();
 });
 document.querySelector('#complete').onclick=complete;
 for(const button of document.querySelectorAll('.account'))button.onclick=()=>{window.fixtureAccountClicks++;window.fixtureChosenAccount=button.dataset.email;return complete();};
 </script></html>`;
}
export const OAUTH_FIXTURE_ACCOUNTS = Object.freeze([
  'synthetic-one@example.test',
  'synthetic-target@example.test',
  'synthetic-three@example.test',
]);
export const OAUTH_DONE_MARKER = 'OAUTH_CONTINUITY_NEW_DOCUMENT';
export const oauthDonePage = `<!doctype html><html lang="zh"><title>本地授权完成</title><main><p>${OAUTH_DONE_MARKER}</p></main></html>`;

// 中文注释：仅通知本地合成框架已执行脚本；无账号或凭据，父页核对 source 与 origin。
export const oauthFramePage = `<!doctype html><p>附属框架</p><script>parent.postMessage('fixture-frame-ready','*')</script>`;
