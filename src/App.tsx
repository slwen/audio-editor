import { useEffect } from 'react'
import { audioEngine } from '@/audio/AudioEngine'
import { Inspector } from '@/components/Inspector'
import { Timeline } from '@/components/Timeline'
import { TransportBar } from '@/components/TransportBar'
import { ingestAudioFiles } from '@/lib/ingestFiles'
import { skipToStart, togglePlayback } from '@/playback/playbackActions'
import { useProjectStore } from '@/store/useProjectStore'

export default function App() {
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      e.preventDefault()
    }
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      const files = [...(e.dataTransfer?.files ?? [])]
      if (files.length === 0) return
      const hasClips = useProjectStore.getState().clips.length > 0
      void ingestAudioFiles(files, hasClips)
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

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
      if (e.code === 'Space') {
        e.preventDefault()
        void togglePlayback()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowLeft') {
        e.preventDefault()
        skipToStart()
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
      <TransportBar />
      <main className="app__main">
        <Timeline />
        <Inspector />
      </main>
    </div>
  )
}
