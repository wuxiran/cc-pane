// A function body for WKWebView.callAsyncJavaScript, in the page's content world.
// Keep the public Runtime.evaluate value/exception envelope used by Windows.
const awaitPromise = __CC_AWAIT__;
try {
  // The native API compiles this source. Calling page eval() here would be
  // rejected by sites with CSP, even though native script evaluation is allowed.
  let value = (
__CC_EXPRESSION__
  );
  if (awaitPromise) value = await value;
  const type = typeof value;
  const result = { type };
  if (value === null) {
    result.subtype = 'null';
    result.value = null;
  } else if (type === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) {
    result.unserializableValue = Object.is(value, -0) ? '-0' : String(value);
  } else if (type === 'bigint') {
    result.unserializableValue = String(value) + 'n';
  } else if (type === 'function' || type === 'symbol') {
    result.description = String(value);
  } else if (type !== 'undefined') {
    result.value = value;
    if (Array.isArray(value)) result.subtype = 'array';
  }
  return JSON.stringify({ result });
} catch (error) {
  try {
    const description = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return JSON.stringify({
      result: { type: 'object', subtype: 'error', description },
      exceptionDetails: { text: description, exception: { type: 'object', subtype: 'error', description } },
    });
  } catch {
    // A page may replace JSON.stringify/Error/String. Never let a runtime
    // SyntaxError escape to the native compile-error fallback and run twice.
    return '{"result":{"type":"object","subtype":"error"},"exceptionDetails":{"text":"The page prevented serialization of the evaluation result"}}';
  }
}
