// 中文注释：源码夹具按语法节点定位，避免绑定格式化器的空格、换行和引号选择。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { parse } = createRequire(import.meta.url)('acorn');

export function sourceNode(source, predicate) {
  const matches = [];
  function visit(node, ancestors = []) {
    if (!node || typeof node !== 'object') return;
    if (predicate(node, ancestors)) matches.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach((child) => visit(child, [...ancestors, node]));
      else if (value && typeof value === 'object') visit(value, [...ancestors, node]);
    }
  }
  visit(parse(source, { ecmaVersion: 'latest', sourceType: 'module' }));
  assert.equal(matches.length, 1, '源码锚点必须唯一');
  return matches[0];
}

export function variableDeclaration(source, name) {
  return sourceNode(
    source,
    (node) =>
      node.type === 'VariableDeclaration' &&
      node.declarations.some((item) => item.id.name === name),
  );
}

export function replaceDeclaration(source, name, replacement) {
  const node = variableDeclaration(source, name);
  assert.equal(node.declarations.length, 1, '替换不能丢失同一声明中的其他变量');
  return source.slice(0, node.start) + replacement + source.slice(node.end);
}
