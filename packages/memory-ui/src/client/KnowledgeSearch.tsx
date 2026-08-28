import { useRef, useState, type FocusEvent } from 'react'
import {
  IconCloseOutline16,
  IconSearchOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PatchouliTranslate } from './locales.js'
import { useAnchoredPopover } from './useAnchoredPopover.js'

const HISTORY_LIMIT = 8

export function KnowledgeSearch({ history, onHistoryChange, t }: {
  history: readonly string[]
  onHistoryChange: (history: string[]) => void
  t: PatchouliTranslate
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const popoverRef = useRef<HTMLElement>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const position = useAnchoredPopover(rootRef, popoverRef, 'start', open)

  const submit = () => {
    const value = query.trim()
    if (!value) return
    onHistoryChange([value, ...history.filter((entry) => entry !== value)].slice(0, HISTORY_LIMIT))
  }

  const selectHistory = (value: string) => {
    setQuery(value)
    inputRef.current?.focus()
  }

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
  }

  return (
    <div ref={rootRef} className="patchouli-search" data-open={open} onBlur={handleBlur}>
      <form
        className="patchouli-search-field"
        role="search"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <IconSearchOutline16 size={16} />
        <input
          ref={inputRef}
          type="search"
          value={query}
          aria-label={t('search.label')}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls="patchouli-search-history"
          placeholder={t('search.placeholder')}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            setOpen(false)
          }}
        />
        {query && (
          <button
            type="button"
            className="patchouli-search-clear"
            aria-label={t('search.clearQuery')}
            onClick={() => {
              setQuery('')
              inputRef.current?.focus()
            }}
          >
            <IconCloseOutline16 size={14} />
          </button>
        )}
      </form>
      {open && (
        <section
          id="patchouli-search-history"
          ref={popoverRef}
          className="patchouli-search-history"
          role="dialog"
          aria-label={t('search.history')}
          style={position}
        >
          <header className="patchouli-search-history-header">
            <span>{t('search.history')}</span>
            {history.length > 0 && (
              <button type="button" onClick={() => onHistoryChange([])}>{t('search.clearHistory')}</button>
            )}
          </header>
          {history.length > 0 ? (
            <ul className="patchouli-search-history-list">
              {history.map((entry) => (
                <li key={entry}>
                  <button type="button" onClick={() => selectHistory(entry)}>
                    <IconSearchOutline16 size={14} />
                    <span>{entry}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="patchouli-search-history-empty">{t('search.emptyHistory')}</div>
          )}
        </section>
      )}
    </div>
  )
}
