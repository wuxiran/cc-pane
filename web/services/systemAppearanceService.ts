import { invokeIfTauri } from "./runtime";

export const systemAppearanceService = {
  getAccentColor: () => invokeIfTauri<string | null>("get_system_accent_color"),
  isMaterialActive: () => invokeIfTauri<boolean>("window_material_active"),
};
