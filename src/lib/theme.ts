export type Theme = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'
export type Scheme = 'classic' | 'ember' | 'forest'

export type LineColors = { done: string; todo: string; selected: string }

/** Line palettes. Each pairs a "done" and "to go" color with a distinct selection color. */
export const SCHEMES: Record<Scheme, { label: string; light: LineColors; dark: LineColors }> = {
  classic: {
    label: 'Classic',
    light: { done: '#2B6CF0', todo: '#F2B200', selected: '#D6336C' },
    dark: { done: '#5C8DFF', todo: '#C99A16', selected: '#FF5C93' },
  },
  ember: {
    label: 'Ember',
    light: { done: '#E8590C', todo: '#9AA5B4', selected: '#6E44E0' },
    dark: { done: '#FF7A33', todo: '#6E7A8C', selected: '#A084FF' },
  },
  forest: {
    label: 'Forest',
    light: { done: '#178A4E', todo: '#C4B48E', selected: '#6E44E0' },
    dark: { done: '#3BC97B', todo: '#8A7D5E', selected: '#A084FF' },
  },
}

/** Interface tokens. Light uses the project's ink scale; dark mirrors its hierarchy. */
export const UI: Record<ResolvedTheme, Record<string, string>> = {
  light: {
    ink: '#292929',
    'ink-2': '#5D5D5D',
    'ink-3': '#9E9E9E',
    line: 'rgba(41, 41, 41, 0.08)',
    surface: '#FFFFFF',
    canvas: '#EEF0F2',
    fill: 'rgba(41, 41, 41, 0.05)',
    'fill-strong': 'rgba(41, 41, 41, 0.09)',
  },
  dark: {
    ink: '#EDEDED',
    'ink-2': '#A8A8A8',
    'ink-3': '#6F6F6F',
    line: 'rgba(255, 255, 255, 0.1)',
    surface: '#1B1B1D',
    canvas: '#0C0C0C',
    fill: 'rgba(255, 255, 255, 0.06)',
    'fill-strong': 'rgba(255, 255, 255, 0.11)',
  },
}

/** Map styling that depends on light/dark rather than on the palette. */
export const MAP_THEME: Record<
  ResolvedTheme,
  { style: string; ink: string; label: string; halo: string; dim: string; dimOpacity: number }
> = {
  light: {
    style: 'https://tiles.openfreemap.org/styles/positron',
    ink: '#292929',
    label: '#5D5D5D',
    halo: '#FFFFFF',
    dim: '#FFFFFF',
    dimOpacity: 0.7,
  },
  dark: {
    style: 'https://tiles.openfreemap.org/styles/dark',
    ink: '#EDEDED',
    label: '#A8A8A8',
    halo: '#0C0C0C',
    dim: '#0C0C0C',
    dimOpacity: 0.65,
  },
}

const vars = (theme: ResolvedTheme, scheme: Scheme) => {
  const c = SCHEMES[scheme][theme]
  const all = { ...UI[theme], done: c.done, todo: c.todo, selected: c.selected }
  return Object.entries(all)
    .map(([k, v]) => `--color-${k}:${v}`)
    .join(';')
}

/**
 * CSS for every theme × palette, keyed off <html data-theme data-scheme>. "system"
 * follows prefers-color-scheme, so the server can render it without knowing the OS setting.
 */
export const THEME_CSS = (Object.keys(SCHEMES) as Scheme[])
  .map(
    (s) =>
      `:root[data-scheme=${s}]{${vars('light', s)};color-scheme:light}` +
      `:root[data-theme=dark][data-scheme=${s}]{${vars('dark', s)};color-scheme:dark}` +
      `@media (prefers-color-scheme:dark){:root[data-theme=system][data-scheme=${s}]{${vars('dark', s)};color-scheme:dark}}`,
  )
  .join('')
