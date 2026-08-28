import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  JsonTree,
  MarkdownText,
  MessageText,
  Pill,
  ReadBlock,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { DocumentSnapshot } from './ui-container/index.js'
import type { DocumentRenderRequest } from './ui-workspace/index.js'
import { NS } from './locales.js'
import {
  documentSummary,
  documentUpdated,
  isPreviewDocumentContent,
  type PreviewDocument,
} from './preview-data.js'

export type MarkdownDocumentContent = { type: 'markdown'; text: string }
export type TextDocumentContent = { type: 'text'; text: string }
export type CodeDocumentContent = {
  type: 'code'
  text: string
  language?: string
  label?: string
}
export type JsonDocumentContent = { type: 'json'; value: unknown }
export type CompositeDocumentContent = {
  type: 'composite'
  parts: readonly DocumentSnapshot[]
}

type RecordValue = Record<string, unknown>

function PreviewMetadata({ activeLabel, source, updated }: {
  activeLabel: string
  source: string
  updated: string
}) {
  return (
    <div className="dsh-workspace-detail-meta">
      <Pill>{activeLabel}</Pill>
      <span>{source}</span>
      <span>{updated}</span>
    </div>
  )
}

function record(value: unknown): RecordValue | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as RecordValue
    : undefined
}

function textContent<T extends string>(value: unknown, type: T): { type: T; text: string } | null {
  const data = record(value)
  return data?.type === type && typeof data.text === 'string'
    ? { type, text: data.text }
    : null
}

function PreviewRenderer({ matched, t }: {
  matched: PreviewDocument
} & PropsLocale<typeof NS>) {
  return (
    <>
      <PreviewMetadata
        activeLabel={t('entry.active')}
        source={`${t('entry.source')}: ${matched.source}`}
        updated={`${t('entry.updated')}: ${documentUpdated(matched, t)}`}
      />
      <h4 className="patchouli-section-label">{t('detail.summary')}</h4>
      <p className="patchouli-summary">{documentSummary(matched, t)}</p>
      <div className="patchouli-facts">
        <div className="patchouli-fact">
          <span className="patchouli-fact-value">{matched.history}</span>
          <span className="patchouli-fact-label">{t('entry.history')}</span>
        </div>
        <div className="patchouli-fact">
          <span className="patchouli-fact-value">{matched.retrievals}</span>
          <span className="patchouli-fact-label">{t('entry.retrievals')}</span>
        </div>
        <div className="patchouli-fact">
          <span className="patchouli-fact-value">{matched.references}</span>
          <span className="patchouli-fact-label">{t('entry.references')}</span>
        </div>
      </div>
    </>
  )
}

function MarkdownRenderer({ matched }: { matched: MarkdownDocumentContent }) {
  return <div className="patchouli-rich-document"><MarkdownText text={matched.text} /></div>
}

function TextRenderer({ matched }: { matched: TextDocumentContent }) {
  return <div className="patchouli-rich-document"><MessageText text={matched.text} /></div>
}

function CodeRenderer({ matched, document }: {
  matched: CodeDocumentContent
  document: DocumentSnapshot
}) {
  const lines = matched.text.split('\n').map((text, index) => ({ number: index + 1, text }))
  return (
    <ReadBlock
      label={matched.label ?? document.title ?? document.uri}
      lines={lines}
      totalLines={lines.length}
      lang={matched.language}
      maxLines={80}
    />
  )
}

function JsonRenderer({ matched }: { matched: JsonDocumentContent }) {
  return typeof matched.value === 'object' && matched.value !== null
    ? <JsonTree data={matched.value as Record<string, unknown> | unknown[]} copyable expandTopLevel />
    : <MessageText text={JSON.stringify(matched.value)} />
}

function CompositeRenderer({ matched, renderPart }: {
  matched: CompositeDocumentContent
  renderPart: DocumentRenderRequest['renderPart']
}) {
  return (
    <div className="patchouli-composite-document">
      {matched.parts.map((part) => <section key={part.uri}>{renderPart(part)}</section>)}
    </div>
  )
}

function UnknownRenderer({ matched }: { matched: DocumentSnapshot }) {
  if (typeof matched.content === 'object' && matched.content !== null) {
    return <JsonTree data={matched.content as Record<string, unknown> | unknown[]} copyable />
  }
  return <MessageText text={String(matched.content ?? '')} />
}

export function registerBuiltinDocumentRenderers(ctx: ClientContext): void {
  ctx.slots.inject('patchouli.document.renderer', () => ctx.slots.register({
    name: 'patchouli.document.renderer',
    priority: 100,
    locale: NS,
    select: ({ document }) => isPreviewDocumentContent(document.content)
      ? document.content.document
      : null,
  }, PreviewRenderer))

  ctx.slots.inject('patchouli.document.renderer', () => ctx.slots.register({
    name: 'patchouli.document.renderer',
    priority: 200,
    select: ({ document }) => {
      const data = record(document.content)
      return data?.type === 'composite' && Array.isArray(data.parts)
        ? data as CompositeDocumentContent
        : null
    },
  }, CompositeRenderer))

  ctx.slots.inject('patchouli.document.renderer', () => ctx.slots.register({
    name: 'patchouli.document.renderer',
    priority: 500,
    select: ({ document }) => textContent(document.content, 'markdown'),
  }, MarkdownRenderer))

  ctx.slots.inject('patchouli.document.renderer', () => ctx.slots.register({
    name: 'patchouli.document.renderer',
    priority: 500,
    select: ({ document }) => {
      const text = textContent(document.content, 'code')
      if (!text) return null
      const data = record(document.content)
      return {
        ...text,
        language: typeof data?.language === 'string' ? data.language : undefined,
        label: typeof data?.label === 'string' ? data.label : undefined,
      } satisfies CodeDocumentContent
    },
  }, CodeRenderer))

  ctx.slots.inject('patchouli.document.renderer', () => ctx.slots.register({
    name: 'patchouli.document.renderer',
    priority: 500,
    select: ({ document }) => {
      const data = record(document.content)
      return data?.type === 'json' && 'value' in data
        ? { type: 'json', value: data.value } satisfies JsonDocumentContent
        : null
    },
  }, JsonRenderer))

  ctx.slots.inject('patchouli.document.renderer', () => ctx.slots.register({
    name: 'patchouli.document.renderer',
    priority: 500,
    select: ({ document }) => textContent(document.content, 'text'),
  }, TextRenderer))

  ctx.slots.inject('patchouli.document.renderer', () => ctx.slots.register({
    name: 'patchouli.document.renderer',
    priority: 1000,
    select: ({ document }) => document,
  }, UnknownRenderer))
}
