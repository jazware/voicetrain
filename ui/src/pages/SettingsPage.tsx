import { useEffect, useMemo, useState } from 'react'
import { Check } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input, Label } from '@/components/ui/Field'
import { useQueryClient } from '@tanstack/react-query'
import { useAnalysisStatus, useBackupStatus, useSettings, useTrends, useUpdateSettings } from '@/hooks/queries'
import { formatAgo } from '@/lib/format'
import { api } from '@/lib/api'
import { PITCH_AXIS } from '@/lib/band'

const RULER_TICKS = [80, 100, 125, 150, 175, 200, 250, 300, 400]

const xPct = (hz: number) =>
  ((Math.log(hz) - Math.log(PITCH_AXIS.minHz)) / (Math.log(PITCH_AXIS.maxHz) - Math.log(PITCH_AXIS.minHz))) * 100

/** The band on a log-frequency ruler, with where recent takes sat. */
function BandRuler({ min, max, recent }: { min: number; max: number; recent: number | null }) {
  const valid = min > 0 && max > min
  return (
    <div className="pt-6 pb-7" aria-hidden>
      <div className="relative h-3 rounded-full bg-rose-whisper">
        {valid && (
          <div
            className="absolute inset-y-0 rounded-full bg-sage/45 ring-1 ring-sage-deep/30 transition-all duration-300"
            style={{ left: `${xPct(min)}%`, width: `${xPct(max) - xPct(min)}%` }}
          />
        )}
        {recent !== null && (
          <div className="absolute -top-6 flex -translate-x-1/2 flex-col items-center" style={{ left: `${xPct(recent)}%` }}>
            <span className="whitespace-nowrap text-[11px] font-semibold text-rose-deep">you lately</span>
            <span className="mt-0.5 h-5 w-0.5 rounded-full bg-rose-deep" />
          </div>
        )}
        {RULER_TICKS.map((hz) => (
          <span
            key={hz}
            className="absolute top-4 -translate-x-1/2 text-[11px] tabular-nums text-ink-soft"
            style={{ left: `${xPct(hz)}%` }}
          >
            {hz}
          </span>
        ))}
      </div>
    </div>
  )
}

function AnalysisSection() {
  const { data: status } = useAnalysisStatus()
  const qc = useQueryClient()
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)
  if (!status) return null

  const busy = status.queued + status.running
  const total = Math.max(status.backfill_total, busy)
  const done = total - busy

  const retry = async () => {
    setRetrying(true)
    setRetryError(null)
    try {
      await api.retryFailedAnalyses()
      await qc.invalidateQueries({ queryKey: ['analysis-status'] })
    } catch (err) {
      setRetryError(`Couldn't queue them: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setRetrying(false)
    }
  }

  return (
    <Card className="space-y-3 p-6 sm:p-8">
      <h2 className="font-display text-xl font-semibold text-ink">Analysis</h2>
      {!status.enabled ? (
        <p className="max-w-[60ch] text-sm leading-relaxed text-ink-soft">
          Analysis is off: the server didn't find an analyzer when it started. On a laptop, start
          docker and build the image (<code>just analysis-build</code>), then restart the server.
        </p>
      ) : (
        <>
          <p className="max-w-[60ch] text-sm leading-relaxed text-ink-soft">
            Every take is measured after you record it, {status.workers === 1 ? 'one at a time' : `${status.workers} at a time`}, by
            analyzer v{status.image_version || '1'}.
            {status.image_version < status.version &&
              ` This server expects v${status.version}: rebuild the analyzer to measure your older takes again.`}{' '}
            When the analyzer improves, older takes are measured again and the earlier results are kept.
          </p>
          {busy > 0 && (
            <div className="space-y-1.5" role="status">
              <p className="text-sm font-semibold text-ink">
                Measuring {done + 1} of {total} {total === 1 ? 'take' : 'takes'}…
              </p>
              <div className="h-2 overflow-hidden rounded-full bg-rose-whisper">
                <div className="h-full rounded-full bg-rose transition-[width] duration-500" style={{ width: `${(done / total) * 100}%` }} />
              </div>
            </div>
          )}
          {status.failed_takes > 0 && (
            <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-rose-whisper px-4 py-3">
              <p className="min-w-0 flex-1 text-sm text-ink">
                {status.failed_takes} {status.failed_takes === 1 ? "take's" : "takes'"} last analysis failed.
                {status.last_error && <span className="mt-0.5 block break-words text-xs text-ink-soft">{status.last_error}</span>}
              </p>
              <Button size="sm" variant="soft" onClick={retry} disabled={retrying || busy > 0}>
                Try them again
              </Button>
              {retryError && (
                <p className="w-full text-xs text-rose-deep" role="alert">
                  {retryError}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  )
}

function BackupSection() {
  const { data: b } = useBackupStatus()
  if (!b) return null
  const intervalMs = (b.interval_s ?? 3600) * 1000
  const failing = !!b.last_error
  const stale = b.last_success_at !== undefined && Date.now() - b.last_success_at > 2.5 * intervalMs

  return (
    <Card className="space-y-3 p-6 sm:p-8">
      <h2 className="font-display text-xl font-semibold text-ink">Backups</h2>
      {!b.enabled ? (
        <p className="max-w-[60ch] text-sm leading-relaxed text-ink-soft">
          Backups are off: this server has no backup folder (<code>--backup-dir</code>). Your takes
          live only in its data folder.
        </p>
      ) : (
        <>
          <p className="max-w-[60ch] text-sm leading-relaxed text-ink-soft">
            Every {Math.round(intervalMs / 60000) === 60 ? 'hour' : `${Math.round(intervalMs / 60000)} minutes`}, new takes
            are copied to <code className="break-all">{b.dir}</code> and the database is snapshotted when it changed.
            Nothing is ever deleted from the takes there; snapshots thin out to a day of every change, 30 dailies and 12
            monthlies.
          </p>
          {b.last_success_at === undefined && !failing && (
            <p className="text-sm text-ink-soft" role="status">
              The first backup runs a little after the server starts.
            </p>
          )}
          {b.last_success_at !== undefined && (
            <p className={failing || stale ? 'text-sm text-ink' : 'text-sm text-sage-deep'} role="status">
              Last backed up {formatAgo(b.last_success_at)}: {b.recordings} {b.recordings === 1 ? 'take' : 'takes'},{' '}
              {b.snapshots} database {b.snapshots === 1 ? 'snapshot' : 'snapshots'}.
            </p>
          )}
          {b.bad_takes && b.bad_takes.length > 0 && (
            <div className="rounded-2xl bg-honey-soft px-4 py-3 text-sm leading-relaxed text-ink" role="alert">
              <p className="font-semibold">
                {b.bad_takes.length === 1 ? 'One take' : `${b.bad_takes.length} takes`} couldn't be backed up: the
                file here is missing or not the size it was saved at.
              </p>
              <p className="mt-1 flex flex-wrap gap-x-3 text-xs">
                {b.bad_takes.map((id) => (
                  <Link key={id} to={`/recordings/${id}`} className="font-semibold text-rose-deep hover:underline">
                    take {id}
                  </Link>
                ))}
              </p>
              <p className="mt-1 text-xs text-ink-soft">
                Everything else, the database included, is backed up. If an earlier backup has the take,{' '}
                <code>voicetrain verify --backup</code> can bring it back (the runbook's "Restoring").
              </p>
            </div>
          )}
          {failing && (
            <div className="rounded-2xl bg-rose-whisper px-4 py-3 text-sm leading-relaxed text-ink" role="alert">
              <p className="font-semibold">
                The last backup failed{b.last_attempt_at !== undefined && ` ${formatAgo(b.last_attempt_at)}`}.
              </p>
              <p className="mt-0.5 break-words text-xs text-ink-soft">{b.last_error}</p>
              <p className="mt-1 text-xs text-ink-soft">
                Your takes are safe here. Backups pick up where they left off once the folder is back.
              </p>
            </div>
          )}
        </>
      )}
    </Card>
  )
}

export function SettingsPage() {
  const { data: settings } = useSettings()
  const { data: trends } = useTrends()
  const update = useUpdateSettings()
  const [min, setMin] = useState('')
  const [max, setMax] = useState('')
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    if (!settings) return
    setMin(String(settings.target_min_hz))
    setMax(String(settings.target_max_hz))
  }, [settings])

  // Median of the last ten analyzed takes.
  const recent = useMemo(() => {
    // Passages only: a siren's median isn't speaking pitch.
    const medians = (trends ?? [])
      .filter((p) => p.kind === 'passage')
      .map((p) => p.median_hz ?? p.live_median_hz)
      .filter((v): v is number => v !== null)
      .slice(-10)
      .sort((a, b) => a - b)
    return medians.length ? medians[medians.length >> 1] : null
  }, [trends])

  const lo = Number(min)
  const hi = Number(max)
  const valid = Number.isFinite(lo) && Number.isFinite(hi) && lo >= 50 && hi <= 600 && hi - lo >= 10
  const dirty = settings !== undefined && (lo !== settings.target_min_hz || hi !== settings.target_max_hz)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!valid) return
    setSaveError(null)
    try {
      await update.mutateAsync({ target_min_hz: lo, target_max_hz: hi })
    } catch (err) {
      setSaveError(`Couldn't save the band: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <h1 className="font-display text-3xl font-bold tracking-tight text-ink sm:text-4xl">Settings</h1>
      </header>

      <Card className="p-6 sm:p-8">
        <form onSubmit={save} className="space-y-4">
          <div>
            <h2 className="font-display text-xl font-semibold text-ink">Your pitch home</h2>
            <p className="mt-1 max-w-[60ch] text-sm leading-relaxed text-ink-soft">
              The band the live meter and each take's analysis measure against. Pick a range you can
              speak in comfortably all day; it's fine to move it as your voice changes.
            </p>
          </div>

          <BandRuler min={lo} max={hi} recent={recent} />

          <div className="grid grid-cols-2 gap-4 sm:max-w-sm">
            <div>
              <Label htmlFor="band-min">Lowest (Hz)</Label>
              <Input id="band-min" type="number" inputMode="numeric" min={50} max={590} value={min} onChange={(e) => setMin(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="band-max">Highest (Hz)</Label>
              <Input id="band-max" type="number" inputMode="numeric" min={60} max={600} value={max} onChange={(e) => setMax(e.target.value)} />
            </div>
          </div>
          {!valid && min !== '' && max !== '' && (
            <p className="text-sm text-rose-deep">The band needs to run upward, at least 10 Hz wide, between 50 and 600 Hz.</p>
          )}
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={!valid || !dirty || update.isPending}>
              Save band
            </Button>
            {saved && (
              <span className="flex items-center gap-1 text-sm font-semibold text-sage-deep" role="status">
                <Check size={15} /> Saved
              </span>
            )}
            {saveError && (
              <span className="text-sm text-rose-deep" role="alert">
                {saveError}
              </span>
            )}
          </div>
          <p className="text-xs leading-relaxed text-ink-soft">
            Takes analyzed from now on use the new band. Older takes keep the band they were measured
            with; re-listen to one from its page to measure it again.
          </p>
        </form>
      </Card>

      <AnalysisSection />
      <BackupSection />
    </div>
  )
}
