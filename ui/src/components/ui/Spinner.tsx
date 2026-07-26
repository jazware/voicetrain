export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-ink-soft">
      <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-rose-soft border-t-rose" />
      <p className="text-sm">{label}</p>
    </div>
  )
}
