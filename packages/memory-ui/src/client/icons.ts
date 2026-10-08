import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement, type ComponentType } from 'react'

const icons = primitives as unknown as Record<string, ComponentType<IconProps>>

// DSH 0.2 names artwork by weight rather than its default size.
function icon(legacy: string, current: string) {
  const size = Number(legacy.match(/\d+$/)![0])
  return (props: IconProps) => {
    const component = icons[current] ?? icons[legacy]
    if (!component) throw new Error(`DSH icon unavailable: ${current}`)
    return createElement(component, { size, ...props })
  }
}

export const IconArchiveOutline20 = icon('IconArchiveOutline20', 'IconArchiveOutlineMedium')
export const IconChevronDownOutline14 = icon('IconChevronDownOutline14', 'IconChevronDownOutlineMedium')
export const IconChevronRightOutline14 = icon('IconChevronRightOutline14', 'IconChevronRightOutlineMedium')
export const IconCloseOutline16 = icon('IconCloseOutline16', 'IconCloseOutlineMedium')
export const IconCodeOutline16 = icon('IconCodeOutline16', 'IconCodeOutlineMedium')
export const IconDataOutline16 = icon('IconDataOutline16', 'IconDataOutlineMedium')
export const IconFolderClose16 = icon('IconFolderClose16', 'IconFolderCloseMedium')
export const IconFolderOpenOutline16 = icon('IconFolderOpenOutline16', 'IconFolderOpenOutlineMedium')
export const IconGlobeOutline14 = icon('IconGlobeOutline14', 'IconGlobeOutlineMedium')
export const IconLinkOutline16 = icon('IconLinkOutline16', 'IconLinkOutlineMedium')
export const IconListPenOutline16 = icon('IconListPenOutline16', 'IconListPenOutlineMedium')
export const IconSearchOutline16 = icon('IconSearchOutline16', 'IconSearchOutlineMedium')
export const IconSendOutline14 = icon('IconSendOutline14', 'IconSendOutlineMedium')
export const IconSettingsOutline14 = icon('IconSettingsOutline14', 'IconSettingsOutlineMedium')
export const IconSparkle16 = icon('IconSparkle16', 'IconSparkleMedium')
export const IconWarningOutline16 = icon('IconWarningOutline16', 'IconWarningOutlineMedium')
