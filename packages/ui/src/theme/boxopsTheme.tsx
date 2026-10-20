// The Boxops look as an Astryx theme.
//
// Every colour, font and radius here comes from the Boxops design tokens in
// ./boxops.generated.ts (synced from the Boxops monorepo by
// scripts/sync-boxops-tokens.mjs). This file only maps Boxops token roles onto
// Astryx token roles; where Astryx asks for something Boxops does not define
// (scrims, press overlays, a page ground distinct from the surface) the value
// is derived from a Boxops token and says so.

import { defineTheme, type TokenName, type TokenValue } from '@astryxdesign/core/theme';
import * as bx from './boxops.generated';
import { boxopsIcons } from './icons';

type Tok = bx.BoxopsToken;

/** A Boxops token as an Astryx value: a string, or a [light, dark] pair. */
const ld = (t: Tok): TokenValue => (typeof t === 'string' ? t : [t.light, t.dark]);
const map = (t: Tok, f: (c: string) => string): TokenValue => (typeof t === 'string' ? f(t) : [f(t.light), f(t.dark)]);
/** A tint at full strength: the same hue with its alpha removed. */
const opaque = (c: string) => c.replace(/\s*\/\s*[\d.]+%?\s*\)$/, ')');
const alpha = (c: string, pct: number) => `${opaque(c).slice(0, -1)} / ${pct}%)`;
const inset = (t: Tok) => map(t, (c) => `inset 0 0 0 2px ${c}`);

function family(stack: string): { family: string; fallbacks: string } {
  const [first, ...rest] = stack.split(/,\s*/);
  return { family: first!.replace(/^['"]|['"]$/g, ''), fallbacks: rest.join(', ') };
}

const HUES = ['gray', 'blue', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'teal', 'cyan'] as const;

const hueTokens: Partial<Record<TokenName, TokenValue>> = {};
for (const h of HUES) {
  const tint = bx.nonsemanticBackgroundColor[h];
  hueTokens[`--color-background-${h}`] = ld(tint);
  hueTokens[`--color-text-${h}`] = ld(bx.nonsemanticTextColor[h]);
  // Boxops has no icon or border ramp: the Badge paints its glyph with the
  // tint at full strength, so the same rule gives the icon and border inks.
  hueTokens[`--color-icon-${h}`] = map(tint, opaque);
  hueTokens[`--color-border-${h}`] = map(tint, opaque);
}

const p = bx.palette;
const body = family(bx.fontFamily.body);
const mono = family(bx.fontFamily.mono);

export const boxopsTheme = defineTheme({
  name: 'boxops',

  typography: {
    // Boxops body text is 16px; the tracker is a dense tool, so the scale
    // starts from Boxops' small text size and keeps the Astryx ratio.
    scale: { base: 14, ratio: 1.2 },
    body,
    heading: { ...body, weights: { 1: 'bold', 2: 'bold', 3: 'semibold', 4: 'semibold' } },
    code: mono,
  },

  tokens: {
    ...hueTokens,

    // Grounds
    '--color-background-body': ld(bx.backgroundColor.surface),
    '--color-background-surface': ld(bx.backgroundColor.surface),
    '--color-background-card': ld(bx.backgroundColor.card),
    '--color-background-popover': ld(bx.backgroundColor.popover),
    '--color-background-muted': ld(bx.backgroundColor.secondary),
    '--color-background-inverted': [p.gray1100, p.white],
    '--color-background-error-inverted': ld(bx.semanticColor.negative),

    // Accent
    '--color-accent': ld(bx.semanticColor.accent),
    '--color-accent-muted': ld(bx.semanticColor.accentSelected),
    '--color-on-accent': p.white,
    '--color-text-accent': ld(bx.textColor.link),
    '--color-icon-accent': ld(bx.semanticColor.accentIconInk),
    '--color-neutral': ld(bx.backgroundColor.button),

    // Overlays: Boxops blends hover and pressed states toward the primary ink
    // at 5% and 10%; the scrim has no Boxops token and is plain black.
    '--color-overlay': ['oklch(0% 0 0 / 50%)', 'oklch(0% 0 0 / 70%)'],
    '--color-overlay-hover': map(bx.textColor.primary, (c) => alpha(c, 5)),
    '--color-overlay-pressed': map(bx.textColor.primary, (c) => alpha(c, 10)),
    '--color-tint-hover': ['black', 'white'],

    // Text and icons
    '--color-text-primary': ld(bx.textColor.primary),
    '--color-text-secondary': ld(bx.textColor.secondary),
    '--color-text-disabled': ld(bx.textColor.disabled),
    '--color-on-dark': bx.textColor.onDarkMedia,
    '--color-on-light': bx.textColor.onLightMedia,
    '--color-icon-primary': ld(bx.iconColor.primary),
    '--color-icon-secondary': ld(bx.iconColor.secondary),
    '--color-icon-disabled': ld(bx.iconColor.disabled),

    // Status
    '--color-success': ld(bx.semanticColor.positive),
    '--color-success-muted': ld(bx.semanticColor.positiveSubtle),
    '--color-on-success': p.white,
    '--color-error': ld(bx.semanticColor.negative),
    '--color-error-muted': ld(bx.semanticColor.negativeSubtle),
    '--color-on-error': p.white,
    '--color-warning': ld(bx.semanticColor.warning),
    '--color-warning-muted': ld(bx.semanticColor.warningSubtle),
    '--color-on-warning': p.gray1100,

    // Edges and effects
    '--color-border': ld(bx.dividerColor.subtle),
    '--color-border-emphasized': ld(bx.textColor.disabled),
    '--color-skeleton': ld(bx.backgroundColor.button),
    '--color-track': ld(bx.backgroundColor.overlay),
    '--color-shadow': 'oklch(0% 0 0 / 20%)',
    '--focus-outline-color': ld(bx.outlineColor.focus),
    '--focus-outline-offset': '2px',

    // Boxops Card: 0 1px 6px at 20% black. The higher steps scale that.
    '--shadow-low': '0 1px 6px 0 oklch(0% 0 0 / 20%)',
    '--shadow-med': '0 2px 12px 0 oklch(0% 0 0 / 22%)',
    '--shadow-high': '0 8px 28px 0 oklch(0% 0 0 / 26%)',
    '--shadow-inset-hover': inset(bx.outlineColor.hover),
    '--shadow-inset-selected': inset(bx.outlineColor.focus),
    '--shadow-inset-success': inset(bx.outlineColor.success),
    '--shadow-inset-warning': inset(bx.outlineColor.warning),
    '--shadow-inset-error': inset(bx.outlineColor.error),

    // Radii: Boxops buttons are 8px, cards 12px.
    '--radius-inner': '4px',
    '--radius-element': bx.borderRadius.button,
    '--radius-container': '12px',
    '--radius-page': '28px',
  },

  // Boxops values Astryx has no role for, used by Lamproom's own styles.
  localTokens: {
    '--lr-accent-subtle': ld(bx.semanticColor.accentSubtle),
    '--lr-accent-selected-hover': ld(bx.semanticColor.accentSelectedHover),
    '--lr-background-input': ld(bx.backgroundColor.input),
    // The graph canvas in dark: the palette's darkest slate, a step below the
    // surface so the cards and seam frames sit up off it.
    '--lr-background-canvas-dark': p.gray1100,
  },
  components: {
    // Boxops tooltips are inverted: dark on light, light on dark.
    tooltip: {
      base: {
        backgroundColor: ld(bx.backgroundColor.tooltip) as unknown as string,
        color: ld(bx.textColor.tooltip) as unknown as string,
      },
    },
  },

  icons: boxopsIcons,
});
