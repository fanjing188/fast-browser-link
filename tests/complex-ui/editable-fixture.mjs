// 中文注释：只模拟 CDP 传输和浏览器编辑效果；执行实际宿主链路，不作为编辑器模型或真实浏览器证明。
import { Executor } from '../../native-extension/core.mjs';
export function editableTransport(window, { onInsert = null, onCommand = null } = {}) {
  const calls = [];
  const sendCommand = async (_target, method, params = {}) => {
    calls.push({ method, params });
    await onCommand?.(method, params);
    if (method === 'Emulation.setFocusEmulationEnabled') return {};
    if (method === 'Input.dispatchKeyEvent' && params.key === 'Backspace') {
      if (params.type === 'keyDown') window.document.getSelection().getRangeAt(0).deleteContents();
      return {};
    }
    if (method === 'Input.insertText') {
      if (onInsert) return onInsert(params.text);
      const range = window.document.getSelection().getRangeAt(0),
        editor = window.document.activeElement;
      range.deleteContents();
      range.insertNode(window.document.createTextNode(params.text));
      editor.dispatchEvent(
        new window.InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: params.text,
        }),
      );
      return {};
    }
    if (method === 'Runtime.callFunctionOn') {
      try {
        return {
          result: {
            value: await window.eval(`(${params.functionDeclaration})`)(
              ...(params.arguments || []).map((argument) => argument.value),
            ),
          },
        };
      } catch (error) {
        return { exceptionDetails: { exception: { description: error.toString() } } };
      }
    }
    throw Error(`unexpected CDP command: ${method}`);
  };
  return { calls, sendCommand };
}
export async function fillThroughInput(f, payload, options = {}) {
  const window = f.window || f.w,
    transport = editableTransport(window, options),
    executor = new Executor({ debugger: { sendCommand: transport.sendCommand } });
  executor.pageRuntime.openInputWindow = async () => ({ entry: {}, token: 'input-window' });
  executor.overlayCall = async () => true;
  const plan = f.call('ref_fill', payload);
  if (plan.kind !== 'contenteditable-input') return plan;
  const result = await executor.fillSemanticEditable(
    {},
    { tabId: 7, text: payload.text },
    { tabId: 7 },
    payload,
    () => {},
    17,
  );
  return { result, calls: transport.calls };
}
