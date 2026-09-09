import { expect, it } from "vitest";
import { snoozeUntil } from "./NotificationPreferenceControls";
import { isSessionSnoozed, useNotificationPreferencesStore } from "@/stores/useNotificationPreferencesStore";

it("uses a local calendar boundary for today and validates custom duration", () => {
  const date = new Date(2026, 8, 8, 23, 55);
  const end = new Date(snoozeUntil("today", 0, date.getTime()));
  expect(end.getDate()).toBe(9); expect(end.getHours()).toBe(0);
  expect(snoozeUntil("quarter", 0, 1000)).toBe(901000);
  for (const value of [0, -1, 1.5, 10081, NaN]) expect(() => snoozeUntil("custom", value)).toThrow();
});
it("never snoozes another session and expires without needing a timer", () => {
  useNotificationPreferencesStore.setState({ preferences: { layoutSounds: {}, sessionSnoozes: { s1: 2000 } } });
  expect(isSessionSnoozed("s1", 1999)).toBe(true);
  expect(isSessionSnoozed("s2", 1999)).toBe(false);
  expect(isSessionSnoozed("s1", 2000)).toBe(false);
});
