/** Avoid loading arbitrary protocols or third-party trackers into application chrome. */
export function safeBrowserFavicon(icon: string | undefined, pageUrl: string | undefined): string | undefined {
  if (!icon || icon.length > 128 * 1024) return undefined;
  if (/^data:image\/(?:png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon);base64,[a-z\d+/=]+$/i.test(icon)) return icon;
  try {
    const page = new URL(pageUrl ?? "");
    const url = new URL(icon, page);
    if (!/^https?:$/.test(url.protocol) || url.origin !== page.origin || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function externalBrowserUrl(value: string | undefined): string | undefined {
  try {
    const url = new URL(value ?? "");
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}
