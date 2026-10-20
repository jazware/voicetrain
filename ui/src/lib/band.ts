export type BandState = 'none' | 'in' | 'near' | 'out'

/** Where a pitch sits relative to the target band ("home"). */
export function bandState(hz: number | null, min: number, max: number): BandState {
  if (hz === null) return 'none'
  if (hz >= min && hz <= max) return 'in'
  if (hz >= min * 0.9 && hz <= max * 1.1) return 'near'
  return 'out'
}

/** Trace colours per band state: sage at home, honey nearby, rose away. */
export const BAND_COLORS: Record<BandState, string> = {
  in: '#4F7F52',
  near: '#C2852F',
  out: '#C94F62',
  none: '#A08A9B',
}

/** Shared log-frequency axis for live and post-hoc pitch charts. */
export const PITCH_AXIS = { minHz: 75, maxHz: 400, grid: [100, 150, 200, 300] }

export function pitchY(hz: number, height: number, minHz = PITCH_AXIS.minHz, maxHz = PITCH_AXIS.maxHz): number {
  const t = (Math.log(hz) - Math.log(minHz)) / (Math.log(maxHz) - Math.log(minHz))
  return height - Math.min(1, Math.max(0, t)) * height
}
