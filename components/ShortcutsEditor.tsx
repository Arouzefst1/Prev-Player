import React, { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { SHORTCUTS, FIXED_SHORTCUTS, bindingsOf, comboOf, prettyCombo, type ShortcutAction } from '../shortcuts';
import type { AppSettings } from '../settings';

// ---------------------------------------------------------------------------
// Settings › Keyboard shortcuts. Click a key, press the new one. A key already
// used elsewhere moves here (the other action is left without one, and says
// so); Esc cancels, Backspace clears.
// ---------------------------------------------------------------------------

interface Props {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
}

const ShortcutsEditor: React.FC<Props> = ({ settings, onChange }) => {
  const custom = settings.shortcuts ?? {};
  const bindings = bindingsOf(custom);
  const [listening, setListening] = useState<ShortcutAction | null>(null);
  const [note, setNote] = useState<{ id: ShortcutAction; text: string } | null>(null);

  const save = (patch: Partial<Record<ShortcutAction, string>>) => {
    const next = { ...custom, ...patch };
    // Store only what differs from the default, so a later default change still reaches everyone else.
    for (const s of SHORTCUTS) if (next[s.id] === s.key) delete next[s.id];
    onChange({ shortcuts: next });
  };

  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      // Ours alone: the player must not act on the key being assigned.
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === 'Escape') { setListening(null); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        save({ [listening]: '' });
        setListening(null);
        return;
      }
      const combo = comboOf(e);
      if (!combo) {
        if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) {
          setNote({ id: listening, text: e.key === ' ' ? 'Space always plays and pauses' : /^[0-9]$/.test(e.key) ? 'Number keys jump through the video' : 'That key can’t be used' });
        }
        return; // keep listening — a modifier alone is the start of a combo
      }
      const taken = SHORTCUTS.find(s => s.id !== listening && bindings[s.id] === combo);
      const patch: Partial<Record<ShortcutAction, string>> = { [listening]: combo };
      if (taken) {
        patch[taken.id] = '';
        setNote({ id: taken.id, text: `Its key moved to “${SHORTCUTS.find(s => s.id === listening)!.label}”` });
      } else {
        setNote(null);
      }
      save(patch);
      setListening(null);
    };
    const cancel = () => setListening(null);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', cancel);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('blur', cancel); };
  });

  const changed = Object.keys(custom).length > 0;

  return (
    <div className="py-2">
      {SHORTCUTS.map(s => {
        const key = bindings[s.id];
        const isListening = listening === s.id;
        const isCustom = s.id in custom;
        return (
          <div key={s.id} className="flex items-center justify-between gap-3 py-1.5">
            <div className="min-w-0">
              <div className="text-sm text-white">{s.label}</div>
              {note?.id === s.id && <div className="text-[11px] text-amber-300/90 mt-0.5">{note.text}</div>}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {isCustom && !isListening && (
                <button
                  onClick={() => { save({ [s.id]: s.key }); setNote(null); }}
                  className="p-1 rounded-md text-neutral-500 hover:text-white hover:bg-neutral-800 transition-colors"
                  title={`Back to ${prettyCombo(s.key)}`}
                >
                  <RotateCcw size={13} />
                </button>
              )}
              <button
                onClick={() => { setNote(null); setListening(isListening ? null : s.id); }}
                className={`min-w-[76px] h-7 px-2.5 rounded-lg border text-xs font-semibold tabular-nums transition-all active:scale-95 ${isListening
                  ? 'border-red-500 bg-red-600/15 text-red-200 animate-pulse'
                  : key
                    ? 'border-neutral-700 bg-neutral-800/80 text-neutral-100 hover:border-neutral-500'
                    : 'border-dashed border-neutral-700 text-neutral-500 hover:text-neutral-300'}`}
                title={isListening ? 'Press a key — Esc cancels, Backspace clears' : 'Click, then press a key'}
              >
                {isListening ? 'Press a key…' : key ? prettyCombo(key) : 'None'}
              </button>
            </div>
          </div>
        );
      })}

      <div className="mt-2 pt-2 border-t border-neutral-800/60">
        {FIXED_SHORTCUTS.map(f => (
          <div key={f.keys} className="flex items-center justify-between gap-3 py-1">
            <span className="text-xs text-neutral-500">{f.label}</span>
            <span className="min-w-[76px] text-center text-[11px] font-semibold text-neutral-500 border border-neutral-800 rounded-lg px-2 py-1">{f.keys}</span>
          </div>
        ))}
      </div>

      {changed && (
        <button
          onClick={() => { onChange({ shortcuts: {} }); setNote(null); setListening(null); }}
          className="mt-3 mb-1 flex items-center gap-1.5 text-xs font-medium text-neutral-300 hover:text-white bg-neutral-800/80 hover:bg-neutral-700 rounded-lg px-2.5 py-1.5 transition-colors active:scale-95"
        >
          <RotateCcw size={13} />
          Reset all to defaults
        </button>
      )}
    </div>
  );
};

export default ShortcutsEditor;
