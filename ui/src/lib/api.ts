export interface Script {
  id: number
  title: string
  body: string
  attribution: string
  focus_points: string[]
  is_seeded: boolean
  created_at: number
  updated_at: number
  deleted_at?: number
  take_count: number
  last_practiced_day?: string
}

export interface ScriptParams {
  title?: string
  body?: string
  attribution?: string
  focus_points?: string[]
}

export interface PitchStats {
  median_hz: number
  pct_in_band: number
  min_hz?: number
  max_hz?: number
}

/** One take's post-hoc acoustic analysis (see analysis/analyze.py). */
export interface Analysis {
  version: number
  duration_s: number | null
  target_min_hz: number
  target_max_hz: number
  pitch: {
    voiced_pct: number | null
    median_hz: number | null
    mean_hz: number | null
    p10_hz: number | null
    p90_hz: number | null
    pct_in_band: number | null
    fry_pct: number | null
  }
  melody: {
    semitone_sd: number | null
    range_st_5_95: number | null
    phrase_endings: { rising: number; falling: number; flat: number }
  }
  resonance: {
    f1_median_hz: number | null
    f2_median_hz: number | null
    f3_median_hz: number | null
    estimated_vtl_cm: number | null
    spectral_centroid_hz: number | null
    spectral_tilt_db: number | null
  }
  breath: {
    phrase_count: number
    mean_phrase_s: number | null
    max_phrase_s: number | null
    pause_count: number
    mean_pause_ms: number | null
    syllable_count: number
    speech_rate_sps: number | null
    articulation_rate_sps: number | null
  }
  weight: {
    cpps_db: number | null
    hnr_db: number | null
    jitter_local_pct: number | null
    shimmer_local_pct: number | null
  }
  contour: { t: number; hz: number | null }[]
  events: {
    start_ms: number
    end_ms: number | null
    kind: string
    payload: Record<string, number | null>
  }[]
}

export interface Recording {
  id: number
  script_id: number
  file_path: string
  duration_ms: number
  sample_rate: number
  channels: number
  size_bytes: number
  rating: number | null
  notes: string
  pitch_stats?: PitchStats
  analysis?: Analysis
  analyzed_at?: number
  recorded_at: number
  local_day: string
  created_at: number
  updated_at: number
  script_title?: string
}

export interface Annotation {
  id: number
  recording_id: number
  start_ms: number
  end_ms: number | null
  kind: string
  payload: Record<string, unknown>
  source: 'auto' | 'user'
  created_at: number
}

export interface HeatmapDay {
  day: string
  count: number
  total_duration_ms: number
}

export interface Settings {
  target_min_hz: number
  target_max_hz: number
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`
    try {
      const body = await res.json()
      if (body.message) message = body.message
    } catch {
      // non-JSON error body; keep the status text
    }
    throw new Error(message)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const api = {
  listScripts: () => request<Script[]>('/api/scripts'),
  getScript: (id: number) => request<Script>(`/api/scripts/${id}`),
  createScript: (params: ScriptParams) => request<Script>('/api/scripts', json('POST', params)),
  updateScript: (id: number, params: ScriptParams) =>
    request<Script>(`/api/scripts/${id}`, json('PATCH', params)),
  deleteScript: (id: number) => request<void>(`/api/scripts/${id}`, { method: 'DELETE' }),

  listRecordings: (filter: { script_id?: number; day?: string; limit?: number } = {}) => {
    const params = new URLSearchParams()
    if (filter.script_id !== undefined) params.set('script_id', String(filter.script_id))
    if (filter.day) params.set('day', filter.day)
    if (filter.limit) params.set('limit', String(filter.limit))
    const qs = params.toString()
    return request<Recording[]>(`/api/recordings${qs ? `?${qs}` : ''}`)
  },
  getRecording: (id: number) => request<Recording>(`/api/recordings/${id}`),
  audioUrl: (id: number) => `/api/recordings/${id}/audio`,
  uploadRecording: (opts: {
    file: Blob
    script_id: number
    recorded_at: number
    local_day: string
    pitch_stats?: PitchStats
  }) => {
    const form = new FormData()
    form.set('file', opts.file, 'take.wav')
    form.set('script_id', String(opts.script_id))
    form.set('recorded_at', String(opts.recorded_at))
    form.set('local_day', opts.local_day)
    if (opts.pitch_stats) form.set('pitch_stats', JSON.stringify(opts.pitch_stats))
    return request<Recording>('/api/recordings', { method: 'POST', body: form })
  },
  updateRecording: (id: number, patch: { rating?: number | null; notes?: string }) =>
    request<Recording>(`/api/recordings/${id}`, json('PATCH', patch)),
  deleteRecording: (id: number) => request<void>(`/api/recordings/${id}`, { method: 'DELETE' }),
  listAnnotations: (id: number) => request<Annotation[]>(`/api/recordings/${id}/annotations`),
  analyzeRecording: (id: number) =>
    request<{ status: string }>(`/api/recordings/${id}/analyze`, { method: 'POST' }),

  heatmap: (opts: { from?: string; to?: string; script_id?: number } = {}) => {
    const params = new URLSearchParams()
    if (opts.from) params.set('from', opts.from)
    if (opts.to) params.set('to', opts.to)
    if (opts.script_id !== undefined) params.set('script_id', String(opts.script_id))
    const qs = params.toString()
    return request<HeatmapDay[]>(`/api/history/heatmap${qs ? `?${qs}` : ''}`)
  },

  getSettings: () => request<Settings>('/api/settings'),
  putSettings: (settings: Settings) => request<Settings>('/api/settings', json('PUT', settings)),
}

/** Local calendar day as YYYY-MM-DD, for timezone-correct history. */
export function localDay(date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
