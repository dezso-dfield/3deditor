'use client'

import { type AnyNode, useScene } from '@pascal-app/core'
import { triggerSFX } from '@pascal-app/editor'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ClipboardCheck,
  Lightbulb,
  Loader2,
  Sparkles,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { type DesignReport, type DesignStep, designRoom, reviewRoom } from '@/lib/design-pipeline'
import { cn } from '@/lib/utils'

const ROOM_TYPES = [
  'bedroom',
  'kitchen',
  'bathroom',
  'living',
  'dining',
  'office',
  'hallway',
  'entry',
  'laundry',
  'storage',
  'kids',
  'gym',
  'game',
] as const

const STYLE_PRESETS = [
  'modern',
  'scandinavian',
  'japandi',
  'industrial',
  'midcentury',
  'cozy',
  'coastal',
  'farmhouse',
  'bohemian',
  'minimal',
  'artdeco',
  'mediterranean',
] as const

function zoneDisplayName(zone: AnyNode): string {
  return String(zone.name ?? (zone.metadata?.roomName as string | undefined) ?? 'Room')
}

function severityTone(severity?: string): string {
  switch (severity) {
    case 'error':
      return 'text-red-400'
    case 'warning':
      return 'text-amber-400'
    default:
      return 'text-muted-foreground'
  }
}

function SelectField({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  disabled?: boolean
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {label}
      </span>
      <span className="relative">
        <select
          className="w-full appearance-none rounded-lg border border-border/50 bg-muted/40 px-3 py-2 pr-8 text-foreground text-sm outline-none transition-colors hover:border-border focus:border-primary disabled:opacity-50"
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          value={value}
        >
          {options.map((o) => (
            <option className="bg-background text-foreground" key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown
          className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground"
          size={14}
        />
      </span>
    </label>
  )
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string
  hint: string
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      aria-pressed={checked}
      className={cn(
        'flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors',
        checked
          ? 'border-primary/40 bg-primary/10'
          : 'border-border/50 bg-muted/30 hover:bg-muted/50',
        disabled && 'cursor-not-allowed opacity-50',
      )}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      type="button"
    >
      <span
        className={cn(
          'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border',
          checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
        )}
      >
        {checked && <Check size={11} strokeWidth={3} />}
      </span>
      <span className="min-w-0">
        <span className="block font-medium text-foreground text-xs">{label}</span>
        <span className="block text-muted-foreground text-xs">{hint}</span>
      </span>
    </button>
  )
}

function ReportCard({ report }: { report: DesignReport }) {
  if (!report) return null
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border/50 bg-muted/20 p-3">
      <div className="flex items-center gap-2">
        <ClipboardCheck className="text-primary" size={14} />
        <span className="font-medium text-foreground text-xs">
          Design review —{' '}
          {report.issueCount === 0
            ? 'no issues'
            : `${report.issueCount} issue${report.issueCount === 1 ? '' : 's'}`}
        </span>
      </div>
      {report.issues.slice(0, 6).map((issue, i) => (
        <div className="flex items-start gap-2" key={issue.code ?? i}>
          <AlertTriangle
            className={cn('mt-0.5 shrink-0', severityTone(issue.severity))}
            size={12}
          />
          <span className="text-muted-foreground text-xs">{issue.message ?? issue.code}</span>
        </div>
      ))}
      {report.issues.length > 6 && (
        <span className="text-muted-foreground text-xs">…and {report.issues.length - 6} more</span>
      )}
      {report.suggestions.slice(0, 4).map((s, i) => (
        <div className="flex items-start gap-2" key={s.code ?? i}>
          <Lightbulb className="mt-0.5 shrink-0 text-primary" size={12} />
          <span className="text-muted-foreground text-xs">{s.message ?? s.code}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * AI Design tab: runs the real agent design tools (update_room → furnish_room →
 * apply_style → improve_layout → decorate_room → review_layout) against the
 * live scene through the MCP server wired into the editor. Nothing is mocked —
 * every change is a real tool call the same pipeline an agent would use.
 */
export function DesignPanel() {
  const nodes = useScene((s) => s.nodes)
  const roomOptions = useMemo(
    () =>
      Object.values(nodes)
        .filter((n): n is AnyNode => n.type === 'zone')
        .map((z) => ({ value: z.id, label: zoneDisplayName(z) })),
    [nodes],
  )

  const [zoneId, setZoneId] = useState('')
  const [roomType, setRoomType] = useState('')
  const [style, setStyle] = useState('modern')
  const [furnish, setFurnish] = useState(true)
  const [decorate, setDecorate] = useState(true)
  const [fix, setFix] = useState(true)
  const [running, setRunning] = useState(false)
  const [steps, setSteps] = useState<DesignStep[]>([])
  const [report, setReport] = useState<DesignReport>(null)
  const [error, setError] = useState<string | null>(null)

  const selectedZoneId = roomOptions.some((o) => o.value === zoneId)
    ? zoneId
    : (roomOptions[0]?.value ?? '')

  useEffect(() => {
    if (zoneId !== selectedZoneId) {
      setZoneId(selectedZoneId)
      // Switching rooms pre-fills the type the zone already carries, so a
      // re-design run does not silently overwrite it.
      const zone = selectedZoneId ? nodes[selectedZoneId as AnyNode['id']] : undefined
      const existing = zone?.type === 'zone' ? zone.occupancy : undefined
      setRoomType(existing && (ROOM_TYPES as readonly string[]).includes(existing) ? existing : '')
    }
  }, [zoneId, selectedZoneId, nodes])

  const runDesign = async () => {
    if (!selectedZoneId || running) return
    triggerSFX('sfx:menu-click')
    setRunning(true)
    setSteps([])
    setReport(null)
    setError(null)
    try {
      const result = await designRoom(
        { zoneId: selectedZoneId, roomType: roomType || undefined, style, furnish, decorate, fix },
        (step) => setSteps((prev) => [...prev, step]),
      )
      setReport(result.report)
      if (result.error) setError(result.error)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  const runReview = async () => {
    if (!selectedZoneId || running) return
    triggerSFX('sfx:menu-click')
    setRunning(true)
    setSteps([])
    setError(null)
    try {
      setReport(await reviewRoom(selectedZoneId))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setReport(null)
    } finally {
      setRunning(false)
    }
  }

  if (roomOptions.length === 0) {
    return (
      <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
        <div className="flex items-center gap-2">
          <Sparkles className="text-primary" size={16} />
          <h2 className="font-semibold text-foreground text-sm">AI Design</h2>
        </div>
        <div className="rounded-xl border border-border/50 border-dashed bg-muted/20 p-4 text-center">
          <p className="text-muted-foreground text-xs">
            Draw a room first — the designer needs a zone to work on. Use the Build tab to sketch
            walls, then come back here.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <div className="flex items-center gap-2">
        <Sparkles className="text-primary" size={16} />
        <h2 className="font-semibold text-foreground text-sm">AI Design</h2>
      </div>
      <p className="-mt-1 text-muted-foreground text-xs">
        Furnish, style and fix a room in one shot — the same tools an AI agent uses.
      </p>

      <SelectField
        disabled={running}
        label="Room"
        onChange={setZoneId}
        options={roomOptions}
        value={selectedZoneId}
      />
      <SelectField
        disabled={running}
        label="Room type"
        onChange={setRoomType}
        options={[
          { value: '', label: 'Auto-detect' },
          ...ROOM_TYPES.map((t) => ({ value: t, label: t[0]!.toUpperCase() + t.slice(1) })),
        ]}
        value={roomType}
      />
      <SelectField
        disabled={running}
        label="Style"
        onChange={setStyle}
        options={STYLE_PRESETS.map((s) => ({
          value: s,
          label:
            s === 'artdeco'
              ? 'Art deco'
              : s === 'midcentury'
                ? 'Mid-century'
                : s[0]!.toUpperCase() + s.slice(1),
        }))}
        value={style}
      />

      <div className="flex flex-col gap-1.5">
        <Toggle
          checked={furnish}
          disabled={running}
          hint="Place the furniture set for the room type"
          label="Furnish"
          onChange={setFurnish}
        />
        <Toggle
          checked={fix}
          disabled={running}
          hint="Auto-fix layout defects — facing, clearances, wall alignment"
          label="Fix layout"
          onChange={setFix}
        />
        <Toggle
          checked={decorate}
          disabled={running}
          hint="Art, lighting, rugs, plants and surface styling"
          label="Decorate"
          onChange={setDecorate}
        />
      </div>

      <div className="flex gap-2">
        <button
          className={cn(
            'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 font-medium text-sm transition-colors',
            running || !selectedZoneId
              ? 'cursor-not-allowed bg-muted text-muted-foreground'
              : 'bg-primary text-primary-foreground hover:bg-primary/90',
          )}
          disabled={running || !selectedZoneId}
          onClick={runDesign}
          type="button"
        >
          {running ? <Loader2 className="animate-spin" size={14} /> : <Sparkles size={14} />}
          {running ? 'Designing…' : 'Design this room'}
        </button>
        <button
          className={cn(
            'rounded-lg border border-border/50 px-3 py-2 font-medium text-muted-foreground text-sm transition-colors',
            running || !selectedZoneId
              ? 'cursor-not-allowed opacity-50'
              : 'hover:bg-muted hover:text-foreground',
          )}
          disabled={running || !selectedZoneId}
          onClick={runReview}
          title="Audit the layout without changing anything"
          type="button"
        >
          Review
        </button>
      </div>

      {steps.length > 0 && (
        <div className="flex flex-col gap-1 rounded-xl border border-border/50 bg-muted/20 p-3">
          {steps.map((step) => (
            <div className="flex items-start gap-2" key={step.id}>
              {step.ok ? (
                <Check className="mt-0.5 shrink-0 text-emerald-400" size={12} />
              ) : (
                <AlertTriangle className="mt-0.5 shrink-0 text-red-400" size={12} />
              )}
              <div className="min-w-0">
                <span className="font-medium text-foreground text-xs">{step.label}</span>
                <span className="block truncate text-muted-foreground text-xs">{step.detail}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-red-300 text-xs">
          {error}
        </div>
      )}

      <ReportCard report={report} />
    </div>
  )
}
