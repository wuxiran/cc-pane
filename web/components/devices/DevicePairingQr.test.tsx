import "@/i18n";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("qrcode.react", () => ({
  QRCodeSVG: ({ value, bgColor, fgColor }: { value: string; bgColor: string; fgColor: string }) => (
    <svg data-testid="qr-svg" data-value={value} data-bg={bgColor} data-fg={fgColor} />
  ),
}));

import DevicePairingQr, { pairingQrPayload } from "./DevicePairingQr";

describe("pairingQrPayload", () => {
  it("picks the first non-loopback address", () => {
    expect(pairingQrPayload([
      "http://127.0.0.1:18080",
      "http://localhost:18080",
      "http://192.168.1.20:18080",
      "http://10.0.0.5:18080",
    ])).toBe("http://192.168.1.20:18080");
  });

  it("returns null when only loopback or invalid addresses exist", () => {
    expect(pairingQrPayload([])).toBeNull();
    expect(pairingQrPayload(["http://127.0.0.1:18080", "http://[::1]:18080", "not a url"])).toBeNull();
  });
});

describe("DevicePairingQr", () => {
  it("encodes only the LAN web URL with dark modules on a light background", () => {
    render(<DevicePairingQr addresses={["http://127.0.0.1:18080", "http://192.168.1.20:18080"]} />);
    const svg = screen.getByTestId("qr-svg");
    expect(svg).toHaveAttribute("data-value", "http://192.168.1.20:18080");
    expect(svg).toHaveAttribute("data-bg", "#ffffff");
    expect(svg).toHaveAttribute("data-fg", "#000000");
    expect(screen.queryByTestId("device-pairing-qr-hint")).toBeNull();
  });

  it("shows a muted hint instead of a loopback QR", () => {
    render(<DevicePairingQr addresses={["http://127.0.0.1:18080"]} />);
    expect(screen.queryByTestId("qr-svg")).toBeNull();
    expect(screen.getByTestId("device-pairing-qr-hint")).toHaveTextContent(/开启网络访问后可扫码|Turn on network access/);
  });
});
