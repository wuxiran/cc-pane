import type { WebglAddon } from "@xterm/addon-webgl";
import "./terminalWebglAlpha.css";

/** addon-webgl 0.19 initializes one blend function for RGB and alpha, squaring
 * translucent background alpha. Keep RGB premultiplied but compose alpha once.
 * Called after each activation, including context recovery; no dependency patch. */
export function configureTransparentWebglAlpha(addon: WebglAddon, element?: HTMLElement): void {
  const gl = (addon as unknown as { _renderer?: { _gl?: WebGL2RenderingContext } })._renderer?._gl;
  if (!gl?.blendFuncSeparate) throw new Error("Transparent WebGL compositing is unavailable");
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  element?.setAttribute("data-cc-transparent-webgl", "true");
}
