import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../web/assets/index.css", import.meta.url), "utf8");
const EXPECTED_LIGHT_THEMES = ["warm-gray", "sky-blue", "rice-paper", "mint-mist"];
const EXPECTED_DARK_THEMES = ["cyber-purple", "amber-gold", "nord-frost", "tokyo-night"];
const MIN_CONTRAST = 4.5;

function blockFor(selector) {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`Missing theme block: ${selector}`);
  const open = css.indexOf("{", start);
  let depth = 1;
  for (let index = open + 1; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") depth -= 1;
    if (depth === 0) return css.slice(open + 1, index);
  }
  throw new Error(`Unclosed theme block: ${selector}`);
}

function variables(block) {
  const result = {};
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;{}]+)\s*;/gi)) {
    result[match[1]] = match[2].trim();
  }
  return result;
}

function splitTopLevel(value, delimiter = ",") {
  const parts = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "(") depth += 1;
    if (value[index] === ")") depth -= 1;
    if (value[index] === delimiter && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function functionBody(value, name) {
  const prefix = `${name}(`;
  if (!value.toLowerCase().startsWith(prefix)) return null;
  let depth = 0;
  for (let index = prefix.length - 1; index < value.length; index += 1) {
    if (value[index] === "(") depth += 1;
    if (value[index] === ")") {
      depth -= 1;
      if (depth === 0 && index === value.length - 1) return value.slice(prefix.length, index).trim();
    }
  }
  return null;
}

function parseNumber(value, percentScale = 1) {
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return null;
  return value.trim().endsWith("%") ? (number / 100) * percentScale : number;
}

function parseColor(value, resolve) {
  if (!value) return null;
  const normalized = value.trim().replace(/\s*!important\s*$/i, "");
  const variable = functionBody(normalized, "var");
  if (variable !== null) {
    const [name, fallback] = splitTopLevel(variable);
    const resolved = resolve(name.trim());
    return resolved ?? (fallback ? parseColor(fallback, resolve) : null);
  }
  if (normalized.toLowerCase() === "transparent") return [0, 0, 0, 0];

  const hex = normalized.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    const raw = hex[1];
    const expanded = raw.length <= 4 ? [...raw].map((part) => part + part).join("") : raw;
    const channels = [0, 2, 4].map((offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16));
    const alpha = expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1;
    return [...channels, alpha];
  }

  const rgb = normalized.match(/^rgba?\((.*)\)$/i);
  if (rgb) {
    const parts = rgb[1].includes(",")
      ? splitTopLevel(rgb[1])
      : rgb[1].replace(/\s*\/\s*/g, " / ").split(/\s+/);
    const slash = parts.indexOf("/");
    const channelParts = (slash < 0 ? parts : parts.slice(0, slash)).slice(0, 3);
    const channels = channelParts.map((part) => parseNumber(part, 255));
    const alphaPart = slash < 0 ? parts[3] : parts[slash + 1];
    const alpha = alphaPart === undefined ? 1 : parseNumber(alphaPart, 1);
    if (channels.length !== 3 || channels.some((channel) => channel === null) || alpha === null) return null;
    return [...channels, Math.max(0, Math.min(1, alpha))];
  }

  const mix = functionBody(normalized, "color-mix");
  if (mix !== null) {
    const parts = splitTopLevel(mix);
    if (parts.length !== 3 || !/^in\s+srgb$/i.test(parts[0])) return null;
    const colors = parts.slice(1).map((part) => {
      const match = part.match(/^(.*?)(?:\s+([0-9.]+%))?$/);
      if (!match) return null;
      return {
        color: parseColor(match[1], resolve),
        weight: match[2] ? Number.parseFloat(match[2]) / 100 : null,
      };
    });
    if (colors.some(({ color }) => !color)) return null;
    const firstWeight = colors[0].weight ?? (colors[1].weight === null ? 0.5 : 1 - colors[1].weight);
    const secondWeight = colors[1].weight ?? (colors[0].weight === null ? 1 - firstWeight : 1 - firstWeight);
    const total = firstWeight + secondWeight;
    if (total <= 0) return null;
    const weights = [firstWeight / total, secondWeight / total];
    const alpha = colors[0].color[3] * weights[0] + colors[1].color[3] * weights[1];
    const channels = [0, 1, 2].map(
      (channel) =>
        (colors[0].color[channel] * colors[0].color[3] * weights[0] +
          colors[1].color[channel] * colors[1].color[3] * weights[1]) /
        (alpha || 1),
    );
    return [...channels, alpha];
  }
  return null;
}

function resolveThemeValue(name, tokens, cache, stack = []) {
  if (cache.has(name)) return cache.get(name);
  if (!tokens[name] || stack.includes(name)) return null;
  const value = parseColor(tokens[name], (reference) =>
    resolveThemeValue(reference, tokens, cache, [...stack, name]),
  );
  if (value) cache.set(name, value);
  return value;
}

function composite(foreground, background) {
  const alpha = foreground[3];
  if (alpha >= 1) return foreground.slice(0, 3);
  return foreground.slice(0, 3).map((channel, index) => channel * alpha + background[index] * (1 - alpha));
}

function luminance(rgb) {
  return rgb.slice(0, 3).reduce((sum, channel, index) => {
    const normalized = channel / 255;
    return (
      sum +
      (normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4) *
        [0.2126, 0.7152, 0.0722][index]
    );
  }, 0);
}

function contrast(foreground, background) {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

const checks = [
  ["--app-text-primary", "--app-panel-bg", "primary-on-panel"],
  ["--app-text-secondary", "--app-panel-bg", "secondary-on-panel"],
  ["--app-text-tertiary", "--app-panel-bg", "tertiary-on-panel"],
  ["--app-accent", "--app-panel-bg", "accent-on-panel"],
  ["--app-text-primary", "--app-sidebar-bg", "primary-on-sidebar"],
  ["--app-text-secondary", "--app-sidebar-bg", "secondary-on-sidebar"],
  ["--app-text-tertiary", "--app-sidebar-bg", "tertiary-on-sidebar"],
  ["--app-accent", "--app-sidebar-bg", "accent-on-sidebar"],
  ["--app-status-warning", "--app-panel-bg", "warning-on-panel"],
  ["--app-status-success", "--app-panel-bg", "success-on-panel"],
  ["--app-status-danger", "--app-panel-bg", "danger-on-panel"],
];
// 历史观察清单（tertiary 两组合 + 暗色上下文）已于 token 明度修正后清零：
// 全部上下文 × 全部组合统一按 4.5 强约束执行，跌破即失败。CONTRAST_STRICT
// 环境变量保留兼容（设与不设行为一致，均为强约束）。
const requiredTokens = new Set([
  ...checks.flatMap(([foreground, background]) => [foreground, background]),
  "--app-status-success-bg",
  "--app-status-success-border",
  "--app-status-warning-bg",
  "--app-status-warning-border",
  "--app-status-danger-bg",
  "--app-status-danger-border",
]);

const root = variables(blockFor(":root"));
const darkBase = variables(blockFor(".dark"));

function themeEntry(name, scheme, inherited) {
  const block = blockFor(`:root[data-theme="${name}"]`);
  if (!new RegExp(`\\bcolor-scheme\\s*:\\s*${scheme}\\s*;`, "i").test(block)) {
    throw new Error(`Theme ${name} is not declared as a ${scheme} color scheme`);
  }
  return { name, tokens: { ...root, ...inherited, ...variables(block) } };
}

const discoveredThemes = [...css.matchAll(/:root\[data-theme="([a-z0-9-]+)"\]\s*\{/gi)].map((match) => match[1]);
const discoveredByScheme = (scheme) =>
  discoveredThemes.filter((name) =>
    new RegExp(`\\bcolor-scheme\\s*:\\s*${scheme}\\s*;`, "i").test(blockFor(`:root[data-theme="${name}"]`)),
  );

const discoveredLightThemes = discoveredByScheme("light");
if (discoveredLightThemes.join(",") !== EXPECTED_LIGHT_THEMES.join(",")) {
  throw new Error(
    `Expected light themes ${EXPECTED_LIGHT_THEMES.join(", ")}; found ${discoveredLightThemes.join(", ") || "none"}`,
  );
}
const discoveredDarkThemes = discoveredByScheme("dark");
if (discoveredDarkThemes.join(",") !== EXPECTED_DARK_THEMES.join(",")) {
  throw new Error(
    `Expected dark themes ${EXPECTED_DARK_THEMES.join(", ")}; found ${discoveredDarkThemes.join(", ") || "none"}`,
  );
}

// 亮色主题直接继承 :root；暗色 [data-theme] 同时挂 .dark class，先继承 .dark 再叠加主题块
const contexts = [
  ...EXPECTED_LIGHT_THEMES.map((name) => ({ ...themeEntry(name, "light", {}), dark: false })),
  { name: ".dark", tokens: { ...root, ...darkBase }, dark: true },
  ...EXPECTED_DARK_THEMES.map((name) => ({ ...themeEntry(name, "dark", darkBase), dark: true })),
];

const failures = [];

for (const { name, tokens, dark } of contexts) {
  const cache = new Map();
  const resolve = (token) => resolveThemeValue(token, tokens, cache);
  for (const token of requiredTokens) {
    if (!resolve(token)) failures.push(`${name}: unresolved ${token}`);
  }
  const backdrop = dark ? [0, 0, 0] : [255, 255, 255];
  for (const [foregroundToken, backgroundToken, label] of checks) {
    const foreground = resolve(foregroundToken);
    const background = resolve(backgroundToken);
    if (!foreground || !background) continue;
    const actualBackground = composite(background, backdrop);
    const ratio = contrast(composite(foreground, actualBackground), actualBackground);
    console.log(`${name}\t${label} ${ratio.toFixed(2)}`);
    if (ratio >= MIN_CONTRAST) continue;
    failures.push(`${name}: ${label} ${ratio.toFixed(2)} < ${MIN_CONTRAST}`);
  }
}

if (failures.length > 0) {
  console.error("Theme contrast guard failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
}
