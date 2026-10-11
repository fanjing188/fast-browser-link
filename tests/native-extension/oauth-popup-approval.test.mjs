// 中文注释：弹窗直接接管；私有准备路由仍只读取身份元数据。
import test from 'node:test';
import assert from 'node:assert/strict';
import {Bridge} from '../../native-extension/bridge.mjs';
const scope={source:{tabId:1,windowId:7,origin:'https://example.com',documentGeneration:0},candidate:{candidateRef:'ref-2',tabId:2,windowId:8,openerTabId:1,origin:'https://accounts.example.test',windowType:'popup'}};

test('bridge routes private metadata preparation without page execution',async()=>{
 const calls=[],b=new Bridge({onMessage:{addListener(){}},postMessage(){}},{preparePopup:async p=>{calls.push(p);return scope;}});
 const response=await b.executeRequest({id:'prepare',method:'browser.popup_prepare',params:{tabId:1}});
 assert.deepEqual(response.result,scope);assert.equal(calls.length,1);
});
