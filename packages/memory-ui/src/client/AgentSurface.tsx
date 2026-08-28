import { Button, IconSendOutline14, IconSparkle16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.js'

export function EmptyAgentSurface({ t }: PropsLocale<typeof NS>) {
  return (
    <>
      <div className="patchouli-panel-body">
        <div className="patchouli-agent-empty">
          <div className="patchouli-agent-mark"><IconSparkle16 /></div>
          {t('agent.empty')}
        </div>
      </div>
      <div className="patchouli-panel-composer">
        <textarea placeholder={t('agent.placeholder')} aria-label={t('agent.placeholder')} />
        <div className="patchouli-panel-send">
          <Button size="sm" variant="primary" icon={<IconSendOutline14 />} disabled>
            {t('agent.send')}
          </Button>
        </div>
      </div>
    </>
  )
}
