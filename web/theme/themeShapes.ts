export const THEME_SHAPE_CODES = [
  "soft",
  "slab",
  "sharp",
  "glass",
  "panel",
  "carbon",
] as const;

export type ThemeShape = (typeof THEME_SHAPE_CODES)[number];

export const DEFAULT_THEME_SHAPE: ThemeShape = "soft";

export interface ThemeShapeDefinition {
  code: ThemeShape;
  label: string;
  descriptionKey: string;
  isDefault: boolean;
  traits: {
    translucent: boolean;
    decorative: boolean;
    flat: boolean;
  };
}

export const THEME_SHAPES: readonly ThemeShapeDefinition[] = [
  {
    code: "soft",
    label: "Soft",
    descriptionKey: "theme.shapes.soft.description",
    isDefault: true,
    traits: { translucent: false, decorative: false, flat: false },
  },
  {
    code: "slab",
    label: "Slab",
    descriptionKey: "theme.shapes.slab.description",
    isDefault: false,
    traits: { translucent: false, decorative: false, flat: false },
  },
  {
    code: "sharp",
    label: "Sharp",
    descriptionKey: "theme.shapes.sharp.description",
    isDefault: false,
    traits: { translucent: false, decorative: false, flat: true },
  },
  {
    code: "glass",
    label: "Glass",
    descriptionKey: "theme.shapes.glass.description",
    isDefault: false,
    traits: { translucent: true, decorative: false, flat: false },
  },
  {
    code: "panel",
    label: "Panel",
    descriptionKey: "theme.shapes.panel.description",
    isDefault: false,
    traits: { translucent: false, decorative: false, flat: true },
  },
  {
    code: "carbon",
    label: "Carbon",
    descriptionKey: "theme.shapes.carbon.description",
    isDefault: false,
    traits: { translucent: true, decorative: true, flat: false },
  },
];

const THEME_SHAPE_SET = new Set<string>(THEME_SHAPE_CODES);

export function canonicalThemeShape(value: unknown): ThemeShape {
  return typeof value === "string" && THEME_SHAPE_SET.has(value)
    ? value as ThemeShape
    : DEFAULT_THEME_SHAPE;
}
