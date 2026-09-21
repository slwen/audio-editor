import { CopyPlus, Trash2 } from 'lucide-react'
import { useMemo } from 'react'
import { audioEngine } from '@/audio/AudioEngine'
import { exportSelectedWav } from '@/audio/exportWav'
import { clipTimelineDuration, clipTimelineEnd } from '@/lib/clipMath'
import { downloadBlob } from '@/lib/downloadBlob'
import { enterLoopModeFromSelection } from '@/loop/loopModeActions'
import { useProjectStore } from '@/store/useProjectStore'

const SPEED_PRESETS = [0.5, 1, 1.25, 1.5, 2, 3] as const

function speedMatchesPreset(speed: number, preset: number): boolean {
  return Math.abs(speed - preset) < 0.02
}

function restartPlaybackFromEngine(): void {
  const st = useProjectStore.getState()
  if (!st.isPlaying) return
  const t = audioEngine.getCurrentTimelineTime()
  audioEngine.stop()
  audioEngine.play(
    t,
    st.clips,
    st.masterGain,
    () => {
      useProjectStore.getState().setIsPlaying(false)
      useProjectStore.getState().setPlayhead(audioEngine.getCurrentTimelineTime())
    },
    (tick) => useProjectStore.getState().setPlayhead(tick)
  )
}

export function Inspector() {
  const clips = useProjectStore((s) => s.clips)
  const selection = useProjectStore((s) => s.selection)
  const masterGain = useProjectStore((s) => s.masterGain)
  const setMasterGain = useProjectStore((s) => s.setMasterGain)
  const setClipGain = useProjectStore((s) => s.setClipGain)
  const setAllClipGains = useProjectStore((s) => s.setAllClipGains)
  const setClipSpeed = useProjectStore((s) => s.setClipSpeed)
  const setAllClipSpeeds = useProjectStore((s) => s.setAllClipSpeeds)
  const setSpeedOnClips = useProjectStore((s) => s.setSpeedOnClips)
  const setGainOnClips = useProjectStore((s) => s.setGainOnClips)
  const setClipFadeIn = useProjectStore((s) => s.setClipFadeIn)
  const setClipFadeOut = useProjectStore((s) => s.setClipFadeOut)
  const pushUndo = useProjectStore((s) => s.pushUndo)
  const deleteSelected = useProjectStore((s) => s.deleteSelected)
  const duplicateSelected = useProjectStore((s) => s.duplicateSelected)
  const isPlaying = useProjectStore((s) => s.isPlaying)

  const selected = useMemo(
    () => clips.filter((c) => selection.includes(c.id)),
    [clips, selection]
  )

  const single = selected.length === 1 ? selected[0] : undefined
  const selectedIds = useMemo(() => selected.map((c) => c.id), [selected])
  const avgGain = selected.length ? selected.reduce((s, c) => s + c.gain, 0) / selected.length : 1
  const commonSpeed =
    selected.length > 0 && selected.every((c) => Math.abs(c.speed - selected[0].speed) < 0.02)
      ? selected[0].speed
      : null

  const onMaster = (v: number) => {
    setMasterGain(v)
    audioEngine.setMasterGain(v)
  }

  const onClipGain = (id: string, v: number) => {
    setClipGain(id, v)
    if (isPlaying) {
      audioEngine.updateClipGainLive(id, useProjectStore.getState().clips, v)
    }
  }

  return (
    <aside className="inspector">
      <h2 className="inspector__title">Mixer</h2>
      <label className="field">
        <span>Master volume</span>
        <input
          type="range"
          min={0}
          max={2}
          step={0.01}
          value={masterGain}
          onChange={(e) => onMaster(Number(e.target.value))}
        />
        <span className="field__hint">{masterGain.toFixed(2)}×</span>
      </label>

      <div className="inspector__row">
        <button
          type="button"
          className="btn btn--small"
          onClick={() => {
            pushUndo()
            setAllClipGains(1)
          }}
        >
          Reset all clip volumes
        </button>
      </div>

      <h2 className="inspector__title">Selection</h2>
      {selected.length === 0 ? (
        <p className="inspector__muted">Select a clip on the timeline.</p>
      ) : (
        <>
          <p className="inspector__meta">
            {selected.length} clip{selected.length > 1 ? 's' : ''}
          </p>
          <div className="inspector__row">
            <button
              type="button"
              className="btn btn--small btn--icon"
              onClick={() => duplicateSelected()}
              aria-label="Duplicate selection"
            >
              <CopyPlus size={18} strokeWidth={2} />
            </button>
            <button
              type="button"
              className="btn btn--small btn--icon"
              onClick={() => deleteSelected()}
              aria-label="Delete selection"
            >
              <Trash2 size={18} strokeWidth={2} />
            </button>
            <button
              type="button"
              className="btn btn--small"
              onClick={() => {
                void exportSelectedWav(selected, masterGain).then((blob) =>
                  downloadBlob(blob, `selection-${selected.length}-clips.wav`)
                )
              }}
            >
              Export {selected.length} selected
            </button>
            {selected.length === 1 && (
              <button
                type="button"
                className="btn btn--small"
                onClick={() => enterLoopModeFromSelection()}
              >
                Find loops
              </button>
            )}
          </div>

          {selected.length > 1 && (
            <>
              <label className="field">
                <span>Selected clips volume</span>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.01}
                  defaultValue={avgGain}
                  key={`gain-${selectedIds.join(',')}`}
                  onPointerDown={() => pushUndo()}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    setGainOnClips(selectedIds, v)
                    if (isPlaying) {
                      for (const id of selectedIds) {
                        audioEngine.updateClipGainLive(id, useProjectStore.getState().clips, v)
                      }
                    }
                  }}
                />
                <span className="field__hint">avg {avgGain.toFixed(2)}×</span>
              </label>
              <div className="field">
                <span>Speed (all selected)</span>
                <div className="segmented">
                  {SPEED_PRESETS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      className={`btn btn--small btn--segment${
                        commonSpeed != null && speedMatchesPreset(commonSpeed, p) ? ' btn--segment-active' : ''
                      }`}
                      onClick={() => {
                        pushUndo()
                        setSpeedOnClips(selectedIds, p)
                        if (isPlaying) restartPlaybackFromEngine()
                      }}
                    >
                      {p}×
                    </button>
                  ))}
                </div>
                {commonSpeed == null ? (
                  <span className="field__hint">Mixed speeds — pick a preset to align all</span>
                ) : null}
              </div>
            </>
          )}

          {single && (
            <>
              <label className="field">
                <span>Clip volume</span>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.01}
                  value={single.gain}
                  onPointerDown={() => pushUndo()}
                  onChange={(e) => onClipGain(single.id, Number(e.target.value))}
                />
                <span className="field__hint">{single.gain.toFixed(2)}× (1× = unchanged)</span>
              </label>
              <div className="field">
                <span>Speed (pitch preserved)</span>
                <div className="segmented">
                  {SPEED_PRESETS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      className={`btn btn--small btn--segment${
                        speedMatchesPreset(single.speed, p) ? ' btn--segment-active' : ''
                      }`}
                      onClick={() => {
                        pushUndo()
                        setClipSpeed(single.id, p)
                        if (isPlaying) restartPlaybackFromEngine()
                      }}
                    >
                      {p}×
                    </button>
                  ))}
                </div>
              </div>
              <div className="field">
                <span>Fade (seconds)</span>
                <div className="field__pair">
                  <label className="field__pair-cell">
                    <span className="field__pair-sublabel">In</span>
                    <input
                      type="number"
                      min={0}
                      max={60}
                      step={0.1}
                      value={single.fadeInSec}
                      onPointerDown={() => pushUndo()}
                      onChange={(e) => setClipFadeIn(single.id, Number(e.target.value))}
                    />
                  </label>
                  <label className="field__pair-cell">
                    <span className="field__pair-sublabel">Out</span>
                    <input
                      type="number"
                      min={0}
                      max={60}
                      step={0.1}
                      value={single.fadeOutSec}
                      onPointerDown={() => pushUndo()}
                      onChange={(e) => setClipFadeOut(single.id, Number(e.target.value))}
                    />
                  </label>
                </div>
              </div>
              <p className="inspector__muted">
                Length on timeline: {clipTimelineDuration(single).toFixed(2)}s (ends{' '}
                {clipTimelineEnd(single).toFixed(2)}s)
              </p>
            </>
          )}
          {clips.length > 0 && (
            <>
              <h2 className="inspector__title">All tracks</h2>
              <div className="inspector__row inspector__row--col">
                <button
                  type="button"
                  className="btn btn--small"
                  onClick={() => {
                    pushUndo()
                    setAllClipSpeeds(1)
                    if (isPlaying) restartPlaybackFromEngine()
                  }}
                >
                  Set every clip speed to 1×
                </button>
                <button
                  type="button"
                  className="btn btn--small"
                  onClick={() => {
                    pushUndo()
                    setAllClipGains(1)
                  }}
                >
                  Set every clip volume to 1×
                </button>
              </div>
            </>
          )}
        </>
      )}
    </aside>
  )
}
