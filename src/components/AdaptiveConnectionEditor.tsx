import { auditionPassage, setPairRule, stopAdaptive } from '@/adaptive/actions'
import { passagePairKey, type MusicSlot } from '@/adaptive/model'
import { useAdaptiveStore } from '@/adaptive/store'
import { musicTime } from '@/adaptive/labels'

export function AdaptiveConnectionEditor({ from, to, onClose }: { from: MusicSlot; to: MusicSlot; onClose: () => void }) {
  const setup = useAdaptiveStore()
  const rule = setup.rules[passagePairKey(from, to)] ?? {}
  const locked = !!setup.playback.current || setup.starting
  const hear = (slot: MusicSlot) => setup.audition?.slot.key === slot.key ? stopAdaptive() : void auditionPassage(slot)
  return <section className="connection-editor" aria-label="Edit selected connection">
    <div className="music-section-heading"><h3>Connection: {musicTime(from.candidate.startSec)} → {musicTime(to.candidate.startSec)}</h3>
      <button className="btn btn--small" onClick={onClose}>Close</button></div>
    <p>This direction only. A Good route is used during game playback at its reviewed exit bar; changing its timing requires another listen.</p>
    <p><strong>{rule.approved ? 'Approved for playback' : 'Needs a Good listening review'}</strong></p>
    <div className="adaptive__buttons"><button className="btn" onClick={() => hear(from)}>Hear outgoing</button><button className="btn" onClick={() => hear(to)}>Hear incoming</button></div>
    <fieldset disabled={locked}>
      <label className="adaptive__check"><input type="checkbox" checked={rule.blocked ?? false} onChange={e => setPairRule(from, to, { blocked: e.target.checked })} />Avoid this jump</label>
      <div className="connection-editor__fields">
        <label>Exit at<select value={rule.exitBar !== undefined ? `bar:${rule.exitBar}` : rule.exitBars ?? 'default'} onChange={e => {
          const value = e.target.value
          setPairRule(from, to, value.startsWith('bar:')
            ? { exitBar: Number(value.slice(4)), exitBars: undefined }
            : { exitBar: undefined, exitBars: value === 'default' ? undefined : Number(value) })
        }}>
          <option value="default">Default timing</option><option value={1}>Next bar</option><option value={2}>Next 2 bars</option><option value={4}>Next 4 bars</option><option value={0}>End of section</option>
          {Array.from({ length: Math.min(16, Math.floor(from.candidate.bars)) }, (_, bar) => <option key={bar} value={`bar:${bar}`}>Only at bar {bar + 1}</option>)}
        </select></label>
        <label>Blend<select value={rule.fadeBeats ?? 'default'} onChange={e => setPairRule(from, to, { fadeBeats: e.target.value === 'default' ? undefined : Number(e.target.value) })}>
          <option value="default">Default blend</option>{[0, 0.25, 1, 2, 4, 8].map(n => <option key={n} value={n}>{n === 0 ? 'Direct' : `${n} beats`}</option>)}
        </select></label>
        <label>Arrive at<select value={rule.entryBar ?? 0} onChange={e => setPairRule(from, to, { entryBar: Number(e.target.value) })}>
          {Array.from({ length: Math.min(16, Math.ceil(to.candidate.bars)) }, (_, bar) => <option key={bar} value={bar}>Bar {bar + 1}</option>)}
        </select></label>
      </div>
    </fieldset>
  </section>
}
