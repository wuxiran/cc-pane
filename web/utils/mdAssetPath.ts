// md 预览中相对图片路径 → 绝对本地路径的解析（不触盘，纯字符串）。
// 支持 ./ ../ 与混合分隔符；保留 Windows 盘符与 Unix 根。
export function resolveRelativeAssetPath(baseFilePath: string, relative: string): string {
  const dir = baseFilePath.replace(/[/\\][^/\\]*$/, "");
  const segments = `${dir}/${relative}`.split(/[/\\]+/);
  const out: string[] = [];
  segments.forEach((segment, index) => {
    if (segment === "" && index === 0) {
      // Unix 绝对路径的空首段（"/home" → ["", "home"]）
      out.push("");
      return;
    }
    if (segment === "" || segment === ".") return;
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "" && out[out.length - 1] !== "..") out.pop();
      return;
    }
    out.push(segment);
  });
  return out.join("/");
}

/** 是否为需要本地解析的路径：相对路径或 Windows 盘符绝对路径 */
export function isLocalAssetPath(url: string): "windows-abs" | "relative" | null {
  if (/^[A-Za-z]:[/\\]/.test(url)) return "windows-abs";
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null; // http/https/data/blob 等真 scheme
  if (url.startsWith("/") || url.startsWith("#") || url === "") return null;
  return "relative";
}
