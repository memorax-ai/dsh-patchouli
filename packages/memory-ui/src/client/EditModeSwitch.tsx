import { Button, IconWarningOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PatchouliTranslate } from './locales.js'

export function EditModeSwitch({ enabled, confirmationOpen, onToggle, onCancel, onConfirm, t }: {
  enabled: boolean
  confirmationOpen: boolean
  onToggle: () => void
  onCancel: () => void
  onConfirm: () => void
  t: PatchouliTranslate
}) {
  return (
    <>
      <button
        type="button"
        className="patchouli-edit-switch"
        role="switch"
        aria-checked={enabled}
        onClick={onToggle}
      >
        <span>{t('editMode.label')}</span>
        <span className="patchouli-edit-switch-track" aria-hidden="true">
          <span className="patchouli-edit-switch-thumb" />
        </span>
      </button>
      <Modal
        open={confirmationOpen}
        onClose={onCancel}
        title={t('editMode.confirmTitle')}
        closeLabel={t('action.cancel')}
        description={t('editMode.confirmDescription')}
        className="patchouli-edit-confirmation"
        footer={(
          <>
            <Button variant="ghost" onClick={onCancel}>{t('action.cancel')}</Button>
            <Button variant="primary" onClick={onConfirm}>{t('editMode.confirmAction')}</Button>
          </>
        )}
      >
        <div className="patchouli-edit-notice">
          <IconWarningOutline16 size={16} />
          <span>{t('editMode.confirmNotice')}</span>
        </div>
      </Modal>
    </>
  )
}
