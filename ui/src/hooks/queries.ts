import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type ScriptParams, type Settings } from '@/lib/api'

export function useScripts() {
  return useQuery({ queryKey: ['scripts'], queryFn: api.listScripts })
}

export function useScript(id: number) {
  return useQuery({ queryKey: ['scripts', id], queryFn: () => api.getScript(id) })
}

export function useCreateScript() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.createScript,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scripts'] }),
  })
}

export function useUpdateScript() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, params }: { id: number; params: ScriptParams }) =>
      api.updateScript(id, params),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scripts'] }),
  })
}

export function useDeleteScript() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.deleteScript,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scripts'] }),
  })
}

export function useRecordings(filter: { script_id?: number; day?: string; limit?: number }) {
  return useQuery({
    queryKey: ['recordings', filter],
    queryFn: () => api.listRecordings(filter),
  })
}

export function useRecording(id: number) {
  return useQuery({ queryKey: ['recordings', 'detail', id], queryFn: () => api.getRecording(id) })
}

export function useAnnotations(id: number) {
  return useQuery({
    queryKey: ['annotations', id],
    queryFn: () => api.listAnnotations(id),
  })
}

/** Invalidates everything derived from recordings (lists, heatmaps, script aggregates). */
function invalidateRecordingData(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['recordings'] })
  qc.invalidateQueries({ queryKey: ['heatmap'] })
  qc.invalidateQueries({ queryKey: ['scripts'] })
}

export function useUploadRecording() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.uploadRecording,
    onSuccess: () => invalidateRecordingData(qc),
  })
}

export function useUpdateRecording() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: { rating?: number | null; notes?: string } }) =>
      api.updateRecording(id, patch),
    onSuccess: (updated) => {
      qc.setQueryData(['recordings', 'detail', updated.id], updated)
      qc.invalidateQueries({ queryKey: ['recordings'] })
    },
  })
}

export function useDeleteRecording() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.deleteRecording,
    onSuccess: () => invalidateRecordingData(qc),
  })
}

export function useHeatmap(opts: { from?: string; to?: string; script_id?: number } = {}) {
  return useQuery({
    queryKey: ['heatmap', opts],
    queryFn: () => api.heatmap(opts),
  })
}

export function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: api.getSettings })
}

export function useUpdateSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (settings: Settings) => api.putSettings(settings),
    onSuccess: (settings) => qc.setQueryData(['settings'], settings),
  })
}
