import { describe, expect, it } from "vitest";
import {
  DEFAULT_MICROPHONE_ID,
  effectiveMicrophoneOrder,
  forgetMicrophone,
  moveMicrophone,
  preferredMicrophoneId,
} from "./voiceMicrophones";

const usb = { deviceId: "usb", label: "USB Mic" };
const airpods = { deviceId: "airpods", label: "AirPods" };

describe("effectiveMicrophoneOrder", () => {
  it("没保存过时系统默认在前，已连接设备追加在后", () => {
    expect(effectiveMicrophoneOrder([], [usb, airpods]).map((entry) => entry.deviceId)).toEqual([
      DEFAULT_MICROPHONE_ID,
      "usb",
      "airpods",
    ]);
  });

  it("保留已保存顺序，刷新名字，去重并补上系统默认", () => {
    const order = effectiveMicrophoneOrder(
      [{ deviceId: "airpods", label: "old" }, { deviceId: "airpods", label: "dup" }],
      [usb, airpods],
    );
    expect(order).toEqual([airpods, { deviceId: DEFAULT_MICROPHONE_ID, label: "" }, usb]);
  });
});

describe("preferredMicrophoneId", () => {
  it("跳过未连接的设备，系统默认返回 null", () => {
    const order = [{ deviceId: "gone", label: "Gone" }, usb, { deviceId: DEFAULT_MICROPHONE_ID, label: "" }];
    expect(preferredMicrophoneId(order, [usb])).toBe("usb");
    expect(preferredMicrophoneId(order, [airpods])).toBeNull();
  });

  it("授权前不知道连接状态，按首选尝试", () => {
    expect(preferredMicrophoneId([usb], [{ deviceId: "", label: "" }])).toBe("usb");
  });
});

describe("move / forget", () => {
  const order = [{ deviceId: DEFAULT_MICROPHONE_ID, label: "" }, usb, airpods];
  it("上下移动并夹在边界内", () => {
    expect(moveMicrophone(order, "airpods", -1).map((entry) => entry.deviceId)).toEqual([DEFAULT_MICROPHONE_ID, "airpods", "usb"]);
    expect(moveMicrophone(order, "usb", 5).map((entry) => entry.deviceId)).toEqual([DEFAULT_MICROPHONE_ID, "airpods", "usb"]);
  });
  it("系统默认不能忘记", () => {
    expect(forgetMicrophone(order, DEFAULT_MICROPHONE_ID)).toHaveLength(3);
    expect(forgetMicrophone(order, "usb").map((entry) => entry.deviceId)).toEqual([DEFAULT_MICROPHONE_ID, "airpods"]);
  });
});
