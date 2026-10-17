// 中文注释：保留方法分类供诊断；有效 CDP 方法的权限由浏览器模式审批统一决定。
const allow=(domain,methods,category='page')=>methods.split(/\s+/).filter(Boolean).map(name=>[`${domain}.${name}`,category]);

export const CDP_METHOD_POLICY=Object.freeze(Object.fromEntries([
 ...allow('Page','enable disable reload stopLoading getFrameTree getLayoutMetrics getNavigationHistory captureScreenshot printToPDF handleJavaScriptDialog bringToFront setLifecycleEventsEnabled getResourceTree getResourceContent createIsolatedWorld getAppManifest removeScriptToEvaluateOnNewDocument resetNavigationHistory'),
 ...allow('Page','navigate navigateToHistoryEntry','navigation'),
 // 中文注释：持久脚本需登记并在任务结束或撤权时移除。
 ...allow('Page','addScriptToEvaluateOnNewDocument','persistent_script'),
 ...allow('Runtime','enable disable evaluate callFunctionOn getProperties releaseObject releaseObjectGroup awaitPromise compileScript runScript globalLexicalScopeNames terminateExecution addBinding removeBinding discardConsoleEntries getExceptionDetails'),
 ...allow('DOM','enable disable getDocument getFlattenedDocument querySelector querySelectorAll describeNode resolveNode requestNode getBoxModel getContentQuads getOuterHTML setOuterHTML setAttributeValue setAttributesAsText removeAttribute removeNode setNodeValue setNodeName focus scrollIntoViewIfNeeded getNodeForLocation pushNodesByBackendIdsToFrontend pushNodeByPathToFrontend requestChildNodes performSearch getSearchResults discardSearchResults getAttributes markUndoableState undo redo collectClassNamesFromSubtree getFrameOwner copyTo moveTo insertAdjacentHTML getNodesForSubtreeByStyle'),
 ...allow('DOM','setFileInputFiles','file'),
 ...allow('Input','dispatchMouseEvent dispatchKeyEvent insertText dispatchTouchEvent dispatchDragEvent synthesizeScrollGesture synthesizeTapGesture synthesizePinchGesture imeSetComposition emulateTouchFromMouseEvent'),
 ...allow('Accessibility','enable disable getFullAXTree getPartialAXTree queryAXTree getChildAXNodes getRootAXNode getAXNodeAndAncestors'),
 ...allow('DOMSnapshot','enable disable captureSnapshot'),
 ...allow('CSS','enable disable getComputedStyleForNode getMatchedStylesForNode getInlineStylesForNode getBackgroundColors getPlatformFontsForNode'),
 ...allow('Overlay','enable disable highlightNode hideHighlight highlightRect highlightQuad'),
 ...allow('Emulation','setDeviceMetricsOverride clearDeviceMetricsOverride setEmulatedMedia setTouchEmulationEnabled setScrollbarsHidden setFocusEmulationEnabled setTimezoneOverride setLocaleOverride setUserAgentOverride setEmitTouchEventsForMouse setPageScaleFactor'),
 ...allow('Network','enable disable getResponseBody getRequestPostData setCacheDisabled emulateNetworkConditions setUserAgentOverride setBypassServiceWorker','network_observe'),
 ...allow('Log','enable disable clear'),
 ...allow('Console','enable disable clearMessages'),
 ...allow('Browser','getVersion'),
 // 中文注释：这些方法沿用分类标签，但不再形成第三层权限黑名单。
 ...allow('Network','getCookies getAllCookies setCookie setCookies deleteCookies clearBrowserCookies getCertificate','credential'),
 ...allow('Storage','getCookies setCookies clearCookies clearDataForOrigin clearDataForStorageKey getUsageAndQuota','credential'),
 ...allow('Network','setRequestInterception setBlockedURLs setExtraHTTPHeaders replayXHR clearBrowserCache setAttachDebugStack','interception'),
 ...allow('Fetch','enable disable continueRequest fulfillRequest failRequest continueWithAuth getResponseBody takeResponseBodyAsStream','interception'),
 ...allow('Browser','grantPermissions resetPermissions setPermission setDownloadBehavior close crash getBrowserCommandLine setWindowBounds getWindowForTarget','browser_global'),
 ...allow('Emulation','setGeolocationOverride clearGeolocationOverride setSensorOverrideEnabled setIdleOverride','permission'),
 ...allow('Page','setDownloadBehavior setBypassCSP setWebLifecycleState crash close','browser_global'),
 ...allow('Target','createTarget closeTarget attachToTarget detachFromTarget setAutoAttach setDiscoverTargets getTargets activateTarget createBrowserContext disposeBrowserContext exposeDevToolsProtocol sendMessageToTarget','target'),
 ...allow('Input','setIgnoreInputEvents','browser_global'),
]));


export function classifyCdpMethod(method){
 if(typeof method!=='string'||!/^[A-Z][A-Za-z]+\.[a-zA-Z]+$/.test(method))return 'invalid';
 return CDP_METHOD_POLICY[method]||'unlisted';
}

export function cdpMethodAllowed(method){
 const category=classifyCdpMethod(method);
 // 中文注释：模式授权由调用链统一处理；有效 CDP 方法不再按旧权限类别拒绝。
 return {allowed:category!=='invalid',category};
}

// 中文注释：事件在进入队列前剥离凭据头与 Cookie 附带元数据，游标和网关共用此出口。
const privateEventKey=/^(cookie|set-cookie|authorization|proxy-authorization|headersText|associatedCookies|blockedCookies|exemptedCookies)$/i;
function publicEvent(value,depth=0){
 if(depth>32)return '[TRUNCATED]';
 if(typeof value==='string')return value.replace(/Bearer\s+[^\s"'<>]+/gi,'Bearer [REDACTED]');
 if(Array.isArray(value))return value.map(item=>publicEvent(item,depth+1));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!privateEventKey.test(key)).map(([key,item])=>[key,publicEvent(item,depth+1)]));
 return value;
}
export function scrubCdpEvent(method,params){
 if(method==='Runtime.executionContextCreated'&&/^fast-/.test(params?.context?.name||''))return null;
 if(method==='Runtime.bindingCalled'&&String(params?.name||'').startsWith('hermes'))return null;
 return publicEvent(params);
}
