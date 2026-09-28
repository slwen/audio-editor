import { useEffect } from 'react'
import { audioEngine } from '@/audio/AudioEngine'
import { GameSongScreen } from '@/components/GameSongScreen'
import { importSongFile } from '@/gameSong/actions'
import { Inspector } from '@/components/Inspector'
import { LoopInspector } from '@/components/LoopInspector'
import { LoopTimeline } from '@/components/LoopTimeline'
import { Timeline } from '@/components/Timeline'
import { TransportBar } from '@/components/TransportBar'
import { ingestAudioFiles } from '@/lib/ingestFiles'
import { splitAtPlayhead } from '@/lib/editorActions'
import { seekRelative, skipToStart, togglePlayback } from '@/playback/playbackActions'
import { useProjectPersistence } from '@/persistence/useProjectPersistence'
import { useProjectStore } from '@/store/useProjectStore'

export default function App() {
  const editorMode = useProjectStore((s) => s.editorMode)
  const projectReady = useProjectPersistence()

  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      e.preventDefault()
    }
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      if (!projectReady) return
      const mode = useProjectStore.getState().editorMode
      if (mode === 'loop') return
      const files = [...(e.dataTransfer?.files ?? [])]
      if (files.length === 0) return
      if (mode === 'game-song') {
        void importSongFile(files[0]!)
        return
      }
      const hasClips = useProjectStore.getState().clips.length > 0
      void ingestAudioFiles(files, hasClips)
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [projectReady])

  useEffect(() => {
    void audioEngine.init().then((ctx) => {
      audioEngine.setMasterGain(useProjectStore.getState().masterGain)
      if (ctx.state === 'suspended') {
        const resume = () => {
          void ctx.resume()
          window.removeEventListener('pointerdown', resume)
        }
        window.addEventListener('pointerdown', resume)
      }
    })
  }, [])

  useEffect(() => {
    const isEditableTarget = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false
      const tag = el.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
      return el.isContentEditable
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return
      const looped = useProjectStore.getState().editorMode !== 'edit'
      if (e.code === 'Space') {
        e.preventDefault()
        e.stopPropagation()
        if (!e.repeat) void togglePlayback()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.code === 'ArrowLeft') {
        e.preventDefault()
        skipToStart()
        return
      }
      if (!e.metaKey && !e.ctrlKey && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
        e.preventDefault()
        seekRelative((e.code === 'ArrowRight' ? 1 : -1) * (e.altKey ? 5 : 1))
        return
      }
      if (looped) return
      if (!e.metaKey && !e.ctrlKey && !e.altKey && e.code === 'KeyS') {
        e.preventDefault()
        if (!e.repeat) splitAtPlayhead()
        return
      }
      if (e.metaKey || e.ctrlKey) {
        if (e.code === 'KeyZ') {
          e.preventDefault()
          if (e.shiftKey) useProjectStore.getState().redo()
          else useProjectStore.getState().undo()
          return
        }
        if (e.code === 'KeyY') {
          e.preventDefault()
          useProjectStore.getState().redo()
          return
        }
        if (e.code === 'KeyD') {
          e.preventDefault()
          useProjectStore.getState().duplicateSelected()
          return
        }
      }
      if (e.code === 'Delete' || e.code === 'Backspace') {
        const st = useProjectStore.getState()
        if (st.selection.length === 0) return
        e.preventDefault()
        st.deleteSelected()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  return (
    <div className="app">
      <TransportBar projectReady={projectReady} />
      <main className="app__main">
        {!projectReady ? <p className="project-loading">Loading project…</p> :
        editorMode === 'game-song' ? <GameSongScreen /> : editorMode === 'loop' ? (
          <>
            <LoopTimeline />
            <LoopInspector />
          </>
        ) : (
          <>
            <Timeline />
            <Inspector />
          </>
        )}
      </main>
    </div>
  )
}
