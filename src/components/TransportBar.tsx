import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { ChevronDown, CopyPlus, Pause, Play, Redo2, SkipBack, Trash2, Undo2 } from 'lucide-react'
import { audioEngine } from '@/audio/AudioEngine'
import { audioExportFilename, exportMixedWav, type AudioExportFormat } from '@/audio/exportWav'
import { ExportFormatToggle } from '@/components/ExportFormatToggle'
import { enterGameSongMode, exitGameSongMode } from '@/gameSong/actions'
import { useGameSongStore } from '@/gameSong/store'
import { getProjectEndTime } from '@/lib/clipMath'
import { downloadBlob } from '@/lib/downloadBlob'
import { splitAtPlayhead } from '@/lib/editorActions'
import { ingestAudioFiles } from '@/lib/ingestFiles'
import { enterLoopModeFromSelection, exitLoopMode, rerunLoopAnalysis } from '@/loop/loopModeActions'
import { skipToStart, togglePlayback } from '@/playback/playbackActions'
import { openProjectFile, saveProjectFile } from '@/persistence/projectActions'
import { clearStoredProject } from '@/persistence/projectDb'
import { useLoopStore } from '@/store/useLoopStore'
import { useProjectStore } from '@/store/useProjectStore'

function releasePointerFocus(event: ReactPointerEvent<HTMLElement>): void {
  if (event.pointerType === 'mouse' || event.pointerType === 'pen') {
    (event.target as HTMLElement).closest<HTMLElement>('button')?.blur()
  }
}

export function TransportBar({ projectReady }: { projectReady: boolean }) {
  const audioInput = useRef<HTMLInputElement>(null)
  const projectInput = useRef<HTMLInputElement>(null)
  const fileMenu = useRef<HTMLDetailsElement>(null)
  const [projectBusy, setProjectBusy] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportFormat, setExportFormat] = useState<AudioExportFormat>('mp3')
  const [projectMessage, setProjectMessage] = useState('')
  const gameSongPlaying = useGameSongStore(s => s.playing)
  const gameSongPlayhead = useGameSongStore(s => s.playhead)
  const gameSongDuration = useGameSongStore(s => s.analysis?.durationSec ?? 0)
  const playhead = useProjectStore(s => s.playhead)
  const isPlaying = useProjectStore(s => s.isPlaying)
  const clips = useProjectStore(s => s.clips)
  const selection = useProjectStore(s => s.selection)
  const editorMode = useProjectStore(s => s.editorMode)
  const canUndo = useProjectStore(s => s.undoStack.length > 0)
  const canRedo = useProjectStore(s => s.redoStack.length > 0)
  const bpm = useLoopStore(s => s.bpm)
  const previewId = useLoopStore(s => s.previewId)
  const candidates = useLoopStore(s => s.candidates)
  const trimEnd = useLoopStore(s => s.trimEnd)

  useEffect(() => {
    if (!projectMessage || projectBusy || exporting) return
    const timer = window.setTimeout(() => setProjectMessage(''), 5000)
    return () => window.clearTimeout(timer)
  }, [projectMessage, projectBusy, exporting])

  useEffect(() => {
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (fileMenu.current && !fileMenu.current.contains(event.target as Node)) fileMenu.current.open = false
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && fileMenu.current?.open) {
        fileMenu.current.open = false
        fileMenu.current.querySelector('summary')?.focus()
      }
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [])

  const closeFileMenu = () => { if (fileMenu.current) fileMenu.current.open = false }
  const leaveCurrentMode = () => {
    const mode = useProjectStore.getState().editorMode
    if (mode === 'loop') exitLoopMode()
    else if (mode === 'game-song') exitGameSongMode()
  }
  const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`
  const looping = editorMode === 'loop'
  const gameSong = editorMode === 'game-song'
  const playing = gameSong ? gameSongPlaying : isPlaying
  const cand = candidates.find(c => c.id === previewId)
  const end = looping ? (cand?.endSec ?? trimEnd) : getProjectEndTime(clips)
  const canFindLoops = selection.length === 1
  const controlsReady = projectReady && !projectBusy

  return (
    <header className="transport" onPointerUp={releasePointerFocus}>
      <div className="transport__top">
        <div className="transport__brand">Audio edit</div>
        <details ref={fileMenu} className="file-menu">
          <summary className="btn btn--small file-menu__trigger">File <ChevronDown size={14} strokeWidth={2.2} aria-hidden="true" /></summary>
          <div className="file-menu__panel">
            <button type="button" aria-label="New project" disabled={!controlsReady} onClick={() => {
              closeFileMenu()
              setProjectBusy(true)
              void clearStoredProject()
                .then(() => {
                  leaveCurrentMode()
                  audioEngine.stop()
                  useProjectStore.getState().resetProject()
                  setProjectMessage('New project')
                })
                .catch(() => setProjectMessage('Could not clear the saved project'))
                .finally(() => setProjectBusy(false))
            }}>New project</button>
            <button type="button" aria-label="Import audio" disabled={!controlsReady} onClick={() => {
              closeFileMenu()
              audioInput.current?.click()
            }}>Import audio</button>
            <button type="button" aria-label="Save project" disabled={!controlsReady || gameSong} onClick={() => {
              closeFileMenu()
              try {
                saveProjectFile()
                setProjectMessage('Project saved')
              } catch (err) {
                setProjectMessage(err instanceof Error ? err.message : 'Could not save project')
              }
            }}>Save project</button>
            <button type="button" aria-label="Open project" disabled={!controlsReady} onClick={() => {
              closeFileMenu()
              projectInput.current?.click()
            }}>Open project</button>
            <div className="file-menu__separator" />
            <button type="button" aria-label="Export mix" disabled={!controlsReady || exporting || gameSong} onClick={() => {
              closeFileMenu()
              const st = useProjectStore.getState()
              setExporting(true)
              setProjectMessage('Exporting mix…')
              void exportMixedWav(st.clips, st.masterGain, exportFormat)
                .then(blob => {
                  downloadBlob(blob, audioExportFilename('mixdown', exportFormat))
                  setProjectMessage('Mix exported')
                })
                .catch(err => setProjectMessage(err instanceof Error ? err.message : 'Could not export mix'))
                .finally(() => setExporting(false))
            }}>{exporting ? 'Exporting…' : 'Export mix'}</button>
            <div className="file-menu__format" aria-label="Mix export format">
              <span>Format</span>
              <ExportFormatToggle value={exportFormat} onChange={setExportFormat} />
            </div>
          </div>
        </details>
        <input ref={audioInput} type="file" accept="audio/*,.mp3,.wav" multiple hidden onChange={e => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          if (!files.length) return
          leaveCurrentMode()
          void ingestAudioFiles(files, useProjectStore.getState().clips.length > 0)
            .catch(err => setProjectMessage(err instanceof Error ? err.message : 'Could not import audio'))
        }} />
        <input ref={projectInput} type="file" accept=".aeproj" hidden onChange={e => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (!file) return
          setProjectBusy(true)
          setProjectMessage('Opening project…')
          void openProjectFile(file)
            .then(() => setProjectMessage('Project opened'))
            .catch(err => setProjectMessage(err instanceof Error ? err.message : 'Could not open project'))
            .finally(() => setProjectBusy(false))
        }} />
        <div className="transport__modes" role="group" aria-label="Editor mode">
          <button type="button" className={`btn btn--small ${!looping && !gameSong ? 'transport__mode--active' : ''}`}
            aria-pressed={!looping && !gameSong} disabled={!controlsReady}
            onClick={leaveCurrentMode}>Editor</button>
          <button type="button" className={`btn btn--small ${looping ? 'transport__mode--active' : ''}`}
            aria-pressed={looping} disabled={!controlsReady || !canFindLoops}
            title={canFindLoops ? 'Find loops in the selected clip' : 'Select one clip to find loops'}
            onClick={() => {
              if (gameSong) exitGameSongMode()
              if (!looping) enterLoopModeFromSelection()
            }}>Find loops</button>
          <button type="button" className={`btn btn--small ${gameSong ? 'transport__mode--active' : ''}`}
            aria-pressed={gameSong} disabled={!controlsReady}
            onClick={() => {
              if (looping) exitLoopMode()
              if (!gameSong) enterGameSongMode()
            }}>Game song</button>
        </div>
        <div className="transport__time" aria-live="polite">
          {gameSong ? <><span>{fmt(gameSongPlayhead)}</span><span className="transport__muted"> / {fmt(gameSongDuration)}</span></> :
            <><span>{fmt(playhead)}</span><span className="transport__muted"> / {fmt(end)}</span>
              {looping && bpm != null && <span className="transport__muted"> · ~{Math.round(cand?.bpm ?? bpm)} BPM</span>}</>}
        </div>
      </div>
      <div className="transport__toolbar">
        <button type="button" className="btn btn--small btn--icon" disabled={!projectReady}
          onClick={() => skipToStart()} aria-label="Back to start" title="Back to start (⌘←)">
          <SkipBack size={18} strokeWidth={2} />
        </button>
        <button type="button" className="btn btn--small btn--icon btn--primary" disabled={!projectReady}
          onClick={() => void togglePlayback()} aria-label={playing ? 'Pause' : 'Play'} title="Play or pause (Space)">
          {playing ? <Pause size={18} fill="currentColor" strokeWidth={2} /> : <Play size={18} fill="currentColor" strokeWidth={2} />}
        </button>
        {looping && <button type="button" className="btn btn--small" onClick={() => rerunLoopAnalysis()}>Analyze again</button>}
        {!looping && !gameSong && <>
          <span className="transport__toolbar-separator" aria-hidden="true" />
          <button type="button" className="btn btn--small" disabled={!projectReady}
            onClick={splitAtPlayhead} title="Split at playhead (S)">Split at playhead</button>
          <button type="button" className="btn btn--small btn--icon" disabled={!canUndo}
            onClick={() => useProjectStore.getState().undo()} aria-label="Undo" title="Undo (⌘Z)">
            <Undo2 size={18} strokeWidth={2} />
          </button>
          <button type="button" className="btn btn--small btn--icon" disabled={!canRedo}
            onClick={() => useProjectStore.getState().redo()} aria-label="Redo" title="Redo (⌘⇧Z)">
            <Redo2 size={18} strokeWidth={2} />
          </button>
          <button type="button" className="btn btn--small btn--icon" disabled={!selection.length}
            onClick={() => useProjectStore.getState().duplicateSelected()} aria-label="Duplicate selection" title="Duplicate (⌘D)">
            <CopyPlus size={18} strokeWidth={2} />
          </button>
          <button type="button" className="btn btn--small btn--icon" disabled={!selection.length}
            onClick={() => useProjectStore.getState().deleteSelected()} aria-label="Delete selection">
            <Trash2 size={18} strokeWidth={2} />
          </button>
        </>}
        {projectMessage && <span className="transport__project-message" role="status">{projectMessage}</span>}
      </div>
    </header>
  )
}
