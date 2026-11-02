import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const body = await readFile(new URL('../src-tauri/src/services/browser_service/evaluate_macos.js', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const evaluate = async (expression, awaitPromise = true) => JSON.parse(await new AsyncFunction(
  body.replace('__CC_AWAIT__', String(awaitPromise)).replace('__CC_EXPRESSION__', () => expression),
)());

test('preserves synchronous values, Unicode, and nested objects', async () => {
  assert.deepEqual(await evaluate('({title:"你好", count: 2, nested: [true, null]})'), {
    result: { type: 'object', value: { title: '你好', count: 2, nested: [true, null] } },
  });
  assert.deepEqual(await evaluate('undefined'), { result: { type: 'undefined' } });
  assert.deepEqual(await evaluate('null'), { result: { type: 'object', subtype: 'null', value: null } });
});

test('awaits successful promises and reports rejected promises as exceptions', async () => {
  assert.equal((await evaluate('Promise.resolve(42)')).result.value, 42);
  assert.match((await evaluate('Promise.reject(new Error("fixture failure"))')).exceptionDetails.text, /fixture failure/);
});

test('captures syntax errors and non-serializable objects without false success', async () => {
  assert.match((await evaluate('(() => {throw new TypeError("bad input")})()')).exceptionDetails.text, /TypeError: bad input/);
  await assert.rejects(evaluate(')'), SyntaxError);
  assert.match((await evaluate('(() => { const a = {}; a.self = a; return a; })()')).exceptionDetails.text, /circular/i);
});

test('preserves special values using Runtime.evaluate representation', async () => {
  for (const [expression, value] of [['NaN', 'NaN'], ['Infinity', 'Infinity'], ['-Infinity', '-Infinity'], ['-0', '-0'], ['42n', '42n']]) {
    assert.equal((await evaluate(expression)).result.unserializableValue, value);
  }
});

test('expression insertion preserves quoted text and marker-like input', async () => {
  const input = 'quotes " \\ \n __CC_PARAMS__';
  assert.equal((await evaluate(JSON.stringify(input))).result.value, input);
});

test('modified page builtins cannot leak runtime SyntaxErrors into compile fallback', async () => {
  const original = JSON.stringify;
  try {
    const result = await evaluate('(() => { JSON.stringify = () => { throw new SyntaxError("page mutation"); }; return 1; })()');
    assert.match(result.exceptionDetails.text, /prevented serialization/);
  } finally {
    JSON.stringify = original;
  }
});
