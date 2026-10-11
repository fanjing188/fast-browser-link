// 中文注释：仅可信扩展配置可覆盖；社交站点限定授权路径，不能把整个站点视为登录页。
export const OAUTH_PROVIDERS=Object.freeze([
 {origin:'https://accounts.google.com'}, {origin:'https://appleid.apple.com'},
 {origin:'https://login.microsoftonline.com'}, {origin:'https://login.live.com'},
 {origin:'https://github.com',paths:['/login/oauth/authorize']},
 {origin:'https://www.facebook.com',paths:['/dialog/oauth'],versioned:true},
 {origin:'https://x.com',paths:['/i/oauth2/authorize','/oauth/authorize']},
 {origin:'https://api.twitter.com',paths:['/oauth/authorize','/oauth/authenticate']},
]);
