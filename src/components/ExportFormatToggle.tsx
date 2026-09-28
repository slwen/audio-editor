import type { AudioExportFormat } from '@/audio/exportWav'

const FORMATS: AudioExportFormat[] = ['mp3', 'wav']

export function ExportFormatToggle({
  value,
  onChange,
}: {
  value: AudioExportFormat
  onChange: (format: AudioExportFormat) => void
}) {
  return (
    <div className="segmented segmented--compact">
      {FORMATS.map((format) => (
        <button
          key={format}
          type="button"
          className={`btn btn--small btn--segment${value === format ? ' btn--segment-active' : ''}`}
          aria-pressed={value === format}
          aria-label={`${format.toUpperCase()} export format`}
          onClick={() => onChange(format)}
        >
          {format.toUpperCase()}
        </button>
      ))}
    </div>
  )
}
