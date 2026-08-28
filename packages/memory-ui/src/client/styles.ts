export const styles = `
.patchouli-root {
  position: absolute;
  inset: 0;
  box-sizing: border-box;
  min-width: 0;
  min-height: 0;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  font-family: var(--dsw-font-family);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.patchouli-root *,
.patchouli-root *::before,
.patchouli-root *::after {
  box-sizing: border-box;
}

[data-conversation-scroll]:has(.patchouli-root) {
  position: relative;
  overflow: hidden;
}

[data-conversation-scroll]:has(.patchouli-root) > [data-composer-seat] {
  display: none;
}

.patchouli-toolbar {
  min-height: 58px;
  padding: 10px 20px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
}

.patchouli-scope-controls {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.patchouli-scope {
  padding: 3px;
  border-radius: 10px;
  background: var(--dsw-alias-interactive-bg-hover);
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.patchouli-scope-button {
  min-height: 30px;
  padding: 5px 10px;
  border: 0;
  border-radius: 8px;
  color: var(--dsw-alias-label-tertiary);
  background: transparent;
  cursor: pointer;
  font: var(--dsw-font-xs-13);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  transition: color 160ms var(--ds-ease-out), background-color 160ms var(--ds-ease-out);
}

.patchouli-scope-button:hover {
  color: var(--dsw-alias-label-primary);
}

.patchouli-scope-button[data-active='true'] {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-specific-input-major);
  box-shadow: var(--dsw-shadow-lv1);
}

.patchouli-custom-scope-button {
  min-height: 36px;
  padding: 7px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  color: var(--dsw-alias-label-tertiary);
  background: transparent;
  cursor: pointer;
  font: var(--dsw-font-xs-13);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.patchouli-custom-scope-button:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}

.patchouli-custom-scope-button[data-open='true'] {
  color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-state-business-tertiary);
}

.patchouli-custom-scope-button[data-effective='true'] {
  color: var(--dsw-alias-state-business-primary);
}

.patchouli-custom-scope-status {
  padding: 1px 5px;
  border-radius: 999px;
  color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-state-business-tertiary);
  font-size: 10px;
  line-height: 16px;
}

.patchouli-edit-switch {
  min-height: 32px;
  padding: 4px 6px 4px 8px;
  border: 0;
  border-radius: 8px;
  color: var(--dsw-alias-label-tertiary);
  background: transparent;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
  font: var(--dsw-font-xs-13);
}

.patchouli-edit-switch:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}

.patchouli-edit-switch[aria-checked='true'] {
  color: var(--dsw-alias-label-primary);
}

.patchouli-edit-switch-track {
  position: relative;
  width: 30px;
  height: 18px;
  border-radius: 999px;
  background: var(--dsw-alias-border-l2);
  flex: none;
  transition: background-color 160ms var(--ds-ease-out);
}

.patchouli-edit-switch-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--dsw-specific-input-major);
  box-shadow: var(--dsw-shadow-lv1);
  transition: transform 160ms var(--ds-ease-out);
}

.patchouli-edit-switch[aria-checked='true'] .patchouli-edit-switch-track {
  background: var(--dsw-alias-state-business-primary);
}

.patchouli-edit-switch[aria-checked='true'] .patchouli-edit-switch-thumb {
  transform: translateX(12px);
}

.patchouli-edit-confirmation {
  max-width: 460px;
}

.patchouli-edit-notice {
  padding: 10px 12px;
  border-radius: 8px;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-specific-tip);
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
  line-height: 19px;
}

.patchouli-edit-notice svg {
  margin-top: 1px;
  color: var(--dsw-alias-state-business-primary);
  flex: none;
}

.patchouli-search {
  position: relative;
  width: 220px;
  flex: none;
}

.patchouli-search-field {
  width: 100%;
  height: 36px;
  padding: 0 7px 0 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  color: var(--dsw-alias-label-tertiary);
  background: transparent;
  display: flex;
  align-items: center;
  gap: 7px;
  transition: border-color 160ms var(--ds-ease-out), background-color 160ms var(--ds-ease-out);
}

.patchouli-search-field:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.patchouli-search[data-open='true'] .patchouli-search-field,
.patchouli-search-field:focus-within {
  border-color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-specific-input-major);
}

.patchouli-search-field > svg {
  flex: none;
}

.patchouli-search-field input {
  min-width: 0;
  height: 100%;
  padding: 0;
  border: 0;
  outline: none;
  color: var(--dsw-alias-label-primary);
  background: transparent;
  flex: 1;
  font: var(--dsw-font-xs-13);
}

.patchouli-search-field input::placeholder {
  color: var(--dsw-alias-label-caption);
  opacity: 1;
}

.patchouli-search-field input::-webkit-search-cancel-button {
  display: none;
}

.patchouli-search-clear {
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  color: var(--dsw-alias-label-tertiary);
  background: transparent;
  cursor: pointer;
  flex: none;
  display: grid;
  place-items: center;
}

.patchouli-search-clear:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}

.patchouli-search-history {
  position: fixed;
  z-index: 21;
  width: min(320px, calc(100vw - 24px));
  border: 0;
  border-radius: 10px;
  background: var(--dsw-specific-input-major);
  box-shadow: var(--dsw-shadow-lv2);
  overflow: hidden;
}

.patchouli-search-history-header {
  min-height: 36px;
  padding: 6px 8px 6px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-tertiary);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 11px;
  font-weight: 500;
  line-height: 18px;
}

.patchouli-search-history-header button {
  padding: 3px 5px;
  border: 0;
  border-radius: 5px;
  color: var(--dsw-alias-label-tertiary);
  background: transparent;
  cursor: pointer;
  font: inherit;
}

.patchouli-search-history-header button:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}

.patchouli-search-history-list {
  max-height: 240px;
  margin: 0;
  padding: 4px;
  list-style: none;
  overflow-y: auto;
}

.patchouli-search-history-list button {
  width: 100%;
  min-height: 32px;
  padding: 5px 8px;
  border: 0;
  border-radius: 6px;
  color: var(--dsw-alias-label-secondary);
  background: transparent;
  cursor: pointer;
  text-align: left;
  display: flex;
  align-items: center;
  gap: 8px;
  font: var(--dsw-font-xs-13);
}

.patchouli-search-history-list button:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}

.patchouli-search-history-list button svg {
  color: var(--dsw-alias-label-tertiary);
  flex: none;
}

.patchouli-search-history-list button span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.patchouli-search-history-empty {
  padding: 18px 12px 20px;
  color: var(--dsw-alias-label-caption);
  text-align: center;
  font-size: 11px;
  line-height: 18px;
}

.patchouli-session-id {
  max-width: 92px;
  color: var(--dsw-alias-label-caption);
  font-family: var(--ds-font-family-code);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.patchouli-toolbar-spacer {
  flex: 1;
}

.patchouli-preview-note {
  color: var(--dsw-alias-label-caption);
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
}

.patchouli-visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  border: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}

.patchouli-custom-filter {
  position: fixed;
  z-index: 20;
  width: min(360px, calc(100vw - 24px));
  min-height: 96px;
  border: 0;
  border-radius: 10px;
  background: var(--dsw-specific-input-major);
  box-shadow: var(--dsw-shadow-lv2);
  overflow: hidden;
}

.patchouli-custom-filter-header {
  min-height: 42px;
  padding: 6px 8px 6px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  display: flex;
  align-items: center;
  gap: 10px;
}

.patchouli-custom-filter-title {
  min-width: 0;
  margin: 0;
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
}

.patchouli-custom-filter-body {
  min-height: 52px;
}

.patchouli-workspace {
  position: relative;
  min-height: 0;
  flex: 1;
  container-type: inline-size;
  overflow: hidden;
}

.patchouli-root .patchouli-workspace {
  --patchouli-workspace-boundary: 3px;
  --patchouli-workspace-gap: calc(var(--patchouli-workspace-boundary) * 1.5);
  padding: var(--patchouli-workspace-boundary);
  background: var(--dsw-alias-interactive-bg-hover);
}

.patchouli-editor-shell {
  width: 100%;
  height: 100%;
  min-width: 0;
  display: flex;
  overflow: hidden;
}

.patchouli-explorer-seat {
  min-width: 190px;
  height: 100%;
  flex: none;
  overflow: hidden;
}

.patchouli-explorer {
  --patchouli-explorer-content-indent: 8px;
  width: 100%;
  height: 100%;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-base);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.patchouli-root .patchouli-explorer,
.patchouli-root .dsh-workspace-editor,
.patchouli-root .patchouli-panel {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--patchouli-radius-panel, 8px);
}

.patchouli-explorer-title {
  height: 38px;
  padding: 0 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  font-weight: 600;
  line-height: 38px;
  letter-spacing: .05em;
  text-transform: uppercase;
}

.dsh-workspace-explorer-scroll {
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.dsh-workspace-explorer-scroll[data-overflow='true'] {
  overflow-x: hidden;
  overflow-y: auto;
  scrollbar-width: thin;
}

.dsh-workspace-explorer-scroll[data-resizing='true'] {
  user-select: none;
}

.dsh-workspace-explorer-section {
  position: relative;
  min-height: 29px;
  flex: none;
  display: flex;
  flex-direction: column;
  overflow: visible;
}

.dsh-workspace-explorer-section-toggle {
  width: 100%;
  height: 28px;
  padding: 0 8px;
  border: 0;
  color: var(--dsw-alias-label-secondary);
  background: transparent;
  cursor: pointer;
  text-align: left;
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  font-weight: 600;
  line-height: 28px;
  letter-spacing: .02em;
  flex: none;
}

.dsh-workspace-explorer-section-toggle:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.dsh-workspace-explorer-pane-sash {
  position: absolute;
  z-index: 4;
  right: 0;
  bottom: -3px;
  left: 0;
  height: 6px;
  cursor: row-resize;
}

.dsh-workspace-explorer-pane-sash[data-enabled='false'] {
  cursor: default;
  pointer-events: none;
}

.dsh-workspace-explorer-pane-sash::after {
  position: absolute;
  top: 2px;
  right: 6px;
  left: 6px;
  height: 1px;
  background: var(--dsw-alias-border-l2);
  content: '';
  transition: height 120ms ease-out, top 120ms ease-out, background-color 120ms ease-out;
}

.dsh-workspace-explorer-pane-sash[data-enabled='true']:hover::after,
.dsh-workspace-explorer-pane-sash[data-active='true']::after {
  top: 1px;
  height: 3px;
  background: var(--dsw-alias-state-business-primary);
}

.dsh-workspace-explorer-section-body {
  position: relative;
  min-height: 0;
  flex: 1;
  overflow: hidden;
}

.dsh-workspace-explorer-section-viewport {
  width: 100%;
  height: 100%;
  padding-bottom: 4px;
  overflow: auto;
  scrollbar-width: none;
}

.dsh-workspace-explorer-section-viewport::-webkit-scrollbar {
  display: none;
}

.dsh-workspace-explorer-section-content {
  min-width: 0;
}

.dsh-workspace-explorer-scrollbar {
  position: absolute;
  z-index: 5;
  top: 3px;
  right: 1px;
  bottom: 3px;
  width: 7px;
  border-radius: 999px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 240ms ease-out;
}

.dsh-workspace-explorer-section-body[data-scrollable='false'] .dsh-workspace-explorer-scrollbar {
  display: none;
}

.dsh-workspace-explorer-scrollbar-thumb {
  position: absolute;
  top: 0;
  right: 0;
  width: 5px;
  height: var(--dsh-workspace-thumb-height, 18px);
  min-height: 18px;
  border-radius: 999px;
  background-color: var(--dsw-alias-label-caption);
  cursor: default;
  transform: translateY(var(--dsh-workspace-thumb-top, 0));
}

.dsh-workspace-explorer-scrollbar-thumb:hover {
  background-color: var(--dsw-alias-label-tertiary);
}

.dsh-workspace-explorer-section-body:hover .dsh-workspace-explorer-scrollbar,
.dsh-workspace-explorer-section-body[data-dragging='true'] .dsh-workspace-explorer-scrollbar {
  opacity: 1;
  pointer-events: auto;
}

.patchouli-explorer-empty {
  padding: 3px 12px 6px 26px;
  color: var(--dsw-alias-label-caption);
  font-size: 11px;
  line-height: 18px;
}

.patchouli-tree {
  margin: 0;
  padding: 0;
}

.dsh-workspace-tree-row {
  width: 100%;
  height: 25px;
  padding: 0 8px 0 calc(8px + var(--patchouli-explorer-content-indent) + var(--dsh-workspace-tree-depth, 0) * 14px);
  border: 0;
  color: var(--dsw-alias-label-secondary);
  background: transparent;
  cursor: pointer;
  text-align: left;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  line-height: 25px;
}

.dsh-workspace-tree-row:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}

.dsh-workspace-tree-row[data-selected='true'] {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-state-business-tertiary);
}

.patchouli-root .dsh-workspace-tree-row,
.patchouli-root .patchouli-tree-row {
  position: relative;
  background: transparent;
}

.patchouli-root .dsh-workspace-tree-row::before,
.patchouli-root .patchouli-tree-row::before {
  position: absolute;
  z-index: 0;
  inset: 1px 4px;
  border-radius: var(--patchouli-radius-selection, 5px);
  background: transparent;
  content: '';
}

.patchouli-root .dsh-workspace-tree-row:hover::before,
.patchouli-root .patchouli-tree-row:hover::before {
  background: var(--dsw-alias-interactive-bg-hover);
}

.patchouli-root .dsh-workspace-tree-row[data-selected='true']::before,
.patchouli-root .patchouli-tree-row[data-active='true']::before {
  background: var(--dsw-alias-state-business-tertiary);
}

.patchouli-root .dsh-workspace-tree-row > *,
.patchouli-root .patchouli-tree-row > * {
  position: relative;
  z-index: 1;
}

.dsh-workspace-tree-sticky-scroll {
  position: sticky;
  z-index: 3;
  top: 0;
  height: 0;
  overflow: visible;
  pointer-events: auto;
}

.dsh-workspace-tree-sticky-row,
.patchouli-root .dsh-workspace-tree-sticky-row {
  border-bottom: 0;
  background: var(--dsw-alias-bg-base);
  cursor: default;
  transform: translateY(var(--dsh-workspace-tree-sticky-offset, 0));
}

.dsh-workspace-tree-sticky-row:last-child {
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}

.dsh-workspace-tree-row[data-sticky-source='true']::before,
.dsh-workspace-tree-row[data-sticky-source='true'] > * {
  opacity: 0;
}

.dsh-workspace-tree-chevron {
  width: 14px;
  height: 18px;
  flex: none;
  display: grid;
  place-items: center;
}

.dsh-workspace-tree-icon {
  width: 16px;
  height: 18px;
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  display: grid;
  place-items: center;
}

.dsh-workspace-tree-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.patchouli-tree-row {
  width: 100%;
  height: 25px;
  padding: 0 8px 0 calc(8px + var(--patchouli-explorer-content-indent) + var(--patchouli-tree-indent, 0px));
  border: 0;
  color: var(--dsw-alias-label-secondary);
  background: transparent;
  cursor: pointer;
  text-align: left;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  line-height: 25px;
}

.patchouli-document-row {
  padding-left: calc(8px + var(--patchouli-explorer-content-indent));
}

.patchouli-tree-row:hover {
  color: var(--dsw-alias-label-primary);
}

.patchouli-tree-row[data-active='true'] {
  color: var(--dsw-alias-label-primary);
}

.patchouli-tree-chevron,
.patchouli-tree-spacer {
  width: 14px;
  height: 18px;
  flex: none;
  display: grid;
  place-items: center;
}

.patchouli-tree-icon {
  width: 16px;
  height: 18px;
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  display: grid;
  place-items: center;
}

.patchouli-tree-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.patchouli-resizer {
  position: relative;
  z-index: 2;
  width: 5px;
  height: 100%;
  margin: 0 -4px 0 0;
  flex: none;
  cursor: col-resize;
}

.patchouli-root .patchouli-resizer {
  width: var(--patchouli-workspace-gap);
  margin: 0;
  background: transparent;
}

.patchouli-root .patchouli-resizer::after {
  left: 50%;
  transform: translateX(-50%);
  background: transparent;
}

.patchouli-root .patchouli-resizer:hover::after,
.patchouli-root .patchouli-resizer:active::after,
.patchouli-root .patchouli-resizer:focus-visible::after,
.patchouli-root .patchouli-resizer[data-active='true']::after {
  left: 50%;
  width: 3px;
  background: var(--dsw-alias-state-business-primary);
}

.patchouli-root .patchouli-resizer:focus-visible {
  outline: none;
}

.patchouli-resizer::after {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 1px;
  background: var(--dsw-alias-border-l2);
  content: '';
  transition: width 120ms var(--ds-ease-out), left 120ms var(--ds-ease-out), background-color 120ms var(--ds-ease-out);
}

.patchouli-resizer:hover::after,
.patchouli-resizer[data-active='true']::after {
  left: 0;
  width: 3px;
  background: var(--dsw-alias-state-business-primary);
}

.dsh-workspace-editor {
  min-width: 240px;
  height: 100%;
  flex: 1;
  background: var(--dsw-alias-bg-base);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.dsh-workspace-editor-tabs {
  height: 38px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  flex: none;
  display: flex;
  align-items: stretch;
  overflow-x: auto;
  overflow-y: hidden;
}

.dsh-workspace-editor-tab {
  position: relative;
  min-width: 132px;
  max-width: 220px;
  border-right: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-tertiary);
  background: var(--dsw-alias-interactive-bg-hover);
  flex: 0 1 190px;
  display: flex;
  align-items: center;
}

.dsh-workspace-editor-tab::after {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 2px;
  background: transparent;
  content: '';
}

.dsh-workspace-editor-tab[data-active='true'] {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
}

.dsh-workspace-editor-tab[data-active='true']::after {
  background: var(--dsw-alias-state-business-primary);
}

.patchouli-root .dsh-workspace-editor-tab {
  border-right: 0;
  background: transparent;
}

.patchouli-root .dsh-workspace-editor-tab::before {
  position: absolute;
  z-index: 0;
  inset: 4px 2px;
  border-radius: var(--patchouli-radius-selection, 5px);
  background: transparent;
  content: '';
}

.patchouli-root .dsh-workspace-editor-tab:first-child::before {
  left: 4px;
}

.patchouli-root .dsh-workspace-editor-tab:last-child::before {
  right: 4px;
}

.patchouli-root .dsh-workspace-editor-tab:hover::before {
  background: var(--dsw-alias-interactive-bg-hover);
}

.patchouli-root .dsh-workspace-editor-tab[data-active='true'] {
  color: var(--dsw-alias-label-primary);
  background: transparent;
}

.patchouli-root .dsh-workspace-editor-tab[data-active='true']::before {
  background: var(--dsw-alias-state-business-tertiary);
}

.patchouli-root .dsh-workspace-editor-tab-label,
.patchouli-root .dsh-workspace-tab-close {
  position: relative;
  z-index: 1;
}

.patchouli-root .dsh-workspace-editor-tab::after {
  display: none;
}

.dsh-workspace-editor-tab[data-preview='true'] .dsh-workspace-editor-tab-label span {
  font-style: italic;
}

.dsh-workspace-editor-tab-label {
  min-width: 0;
  height: 100%;
  padding: 0 3px 0 11px;
  border: 0;
  color: inherit;
  background: transparent;
  cursor: pointer;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  text-align: left;
}

.dsh-workspace-editor-tab-label svg {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
}

.dsh-workspace-editor-tab-label span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsh-workspace-tab-close {
  width: 25px;
  height: 25px;
  padding: 0;
  margin-right: 5px;
  border: 0;
  border-radius: 5px;
  color: var(--dsw-alias-label-tertiary);
  background: transparent;
  cursor: pointer;
  flex: none;
  display: grid;
  place-items: center;
  opacity: 0;
}

.dsh-workspace-editor-tab:hover .dsh-workspace-tab-close,
.dsh-workspace-editor-tab[data-active='true'] .dsh-workspace-tab-close,
.dsh-workspace-tab-close:focus-visible {
  opacity: 1;
}

.dsh-workspace-tab-close:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}

.dsh-workspace-editor-body {
  min-height: 0;
  flex: 1;
  overflow: hidden;
}

.patchouli-editor-empty {
  height: 100%;
  padding: 40px 24px;
  color: var(--dsw-alias-label-caption);
  text-align: center;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
}

.patchouli-editor-empty-mark {
  width: 38px;
  height: 38px;
  margin-bottom: 12px;
  border-radius: 10px;
  color: var(--dsw-alias-label-tertiary);
  background: var(--dsw-alias-interactive-bg-hover);
  display: grid;
  place-items: center;
}

.patchouli-editor-empty p {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
}

.patchouli-editor-empty span {
  margin-top: 2px;
  font-size: 11px;
  line-height: 18px;
}

.dsh-workspace-detail {
  min-width: 0;
  height: 100%;
  overflow-y: auto;
}

.dsh-workspace-detail-header {
  padding: 22px 26px 18px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}

.dsh-workspace-detail-title-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.dsh-workspace-detail-heading {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
}

.dsh-workspace-detail-title {
  min-width: 0;
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  line-height: 24px;
  text-wrap: balance;
}

.dsh-workspace-detail-actions {
  flex: none;
  display: flex;
  gap: 8px;
}

.dsh-workspace-detail-meta {
  margin-top: 8px;
  color: var(--dsw-alias-label-caption);
  font-size: 11px;
  line-height: 17px;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.patchouli-meta-sep {
  width: 2px;
  height: 2px;
  border-radius: 50%;
  background: var(--dsw-alias-label-caption);
}

.dsh-workspace-detail-body {
  max-width: 820px;
  padding: 22px 26px 32px;
}

.patchouli-section-label {
  margin: 0 0 8px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
}

.patchouli-summary {
  max-width: 72ch;
  margin: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 23px;
  text-wrap: pretty;
}

.patchouli-facts {
  margin-top: 22px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  display: grid;
  grid-template-columns: repeat(3, 1fr);
}

.patchouli-fact {
  padding: 14px 0;
}

.patchouli-fact + .patchouli-fact {
  padding-left: 18px;
  border-left: 1px solid var(--dsw-alias-border-l1);
}

.patchouli-fact-value {
  display: block;
  font-size: 15px;
  font-weight: 600;
  line-height: 22px;
}

.patchouli-fact-label {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 17px;
}

.patchouli-panel-composer textarea {
  width: 100%;
  resize: vertical;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 9px;
  outline: none;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-specific-input-major);
  font: inherit;
}

.patchouli-panel-composer textarea:focus {
  border-color: var(--dsw-alias-state-business-primary);
}

.patchouli-panel {
  width: 100%;
  height: 100%;
  background: var(--dsw-alias-bg-base);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.patchouli-agent-seat {
  height: 100%;
  flex: none;
  overflow: hidden;
}

.patchouli-panel-header {
  min-height: 58px;
  padding: 10px 14px 10px 18px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  display: flex;
  align-items: center;
  gap: 10px;
}

.patchouli-panel-heading {
  min-width: 0;
  flex: 1;
}

.patchouli-panel-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
}

.patchouli-panel-subtitle {
  color: var(--dsw-alias-label-caption);
  font-size: 11px;
  line-height: 16px;
}

.patchouli-icon-button {
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  color: var(--dsw-alias-label-secondary);
  background: transparent;
  cursor: pointer;
  display: grid;
  place-items: center;
}

.patchouli-icon-button:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.patchouli-panel-body {
  min-height: 0;
  padding: 22px 20px;
  flex: 1;
  overflow-y: auto;
}

.patchouli-agent-empty {
  max-width: 32ch;
  margin: 20vh auto 0;
  color: var(--dsw-alias-label-tertiary);
  text-align: center;
  font-size: 13px;
  line-height: 20px;
}

.patchouli-agent-mark {
  width: 36px;
  height: 36px;
  margin: 0 auto 12px;
  border-radius: 12px;
  color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-state-business-tertiary);
  display: grid;
  place-items: center;
}

.patchouli-panel-composer {
  padding: 12px;
  border-top: 1px solid var(--dsw-alias-border-l2);
}

.patchouli-panel-composer textarea {
  min-height: 74px;
  padding: 10px 12px 34px;
  font-size: 13px;
  line-height: 20px;
}

.patchouli-panel-send {
  position: relative;
  height: 0;
  display: flex;
  justify-content: flex-end;
  transform: translate(-7px, -36px);
}

.patchouli-scope-button:focus-visible,
.patchouli-custom-scope-button:focus-visible,
.dsh-workspace-explorer-section-toggle:focus-visible,
.patchouli-tree-row:focus-visible,
.dsh-workspace-tree-row:focus-visible,
.patchouli-resizer:focus-visible,
.dsh-workspace-editor-tab-label:focus-visible,
.dsh-workspace-tab-close:focus-visible,
.patchouli-icon-button:focus-visible,
.patchouli-search-clear:focus-visible,
.patchouli-search-history button:focus-visible,
.patchouli-edit-switch:focus-visible,
.patchouli-agent-toggle:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: -2px;
}

@media (max-width: 980px) {
  .patchouli-preview-note,
  .patchouli-session-id {
    display: none;
  }

}

@media (max-width: 720px) {
  .patchouli-toolbar {
    padding-right: 14px;
    padding-left: 14px;
    flex-wrap: wrap;
    gap: 8px;
  }

  .patchouli-scope-controls {
    flex: 1 1 100%;
    overflow-x: auto;
  }

  .patchouli-search {
    width: 210px;
  }

  .patchouli-toolbar-spacer {
    display: none;
  }

  .patchouli-agent-toggle {
    margin-left: 0;
  }

  .patchouli-edit-switch {
    margin-left: auto;
  }

  .dsh-workspace-detail-header,
  .dsh-workspace-detail-body {
    padding-right: 18px;
    padding-left: 18px;
  }

  .dsh-workspace-detail-title-row {
    flex-direction: column;
  }

  .dsh-workspace-detail-actions {
    width: 100%;
  }

  .patchouli-facts {
    grid-template-columns: 1fr;
  }

  .patchouli-fact + .patchouli-fact {
    padding-left: 0;
    border-top: 1px solid var(--dsw-alias-border-l1);
    border-left: 0;
  }
}

@container (max-width: 740px) {
  .patchouli-editor-shell {
    flex-direction: column;
    gap: var(--patchouli-workspace-gap);
    overflow-x: hidden;
    overflow-y: auto;
  }

  .patchouli-editor-shell > .patchouli-resizer {
    display: none;
  }

  .patchouli-editor-shell > [data-ui-surface-id] {
    width: 100% !important;
    min-width: 0 !important;
    flex: none !important;
  }

  .patchouli-editor-shell > [data-ui-surface-id='explorer'] {
    height: clamp(280px, 42vh, 380px) !important;
  }

  .patchouli-editor-shell > [data-ui-surface-id='editor'] {
    height: clamp(360px, 58vh, 560px) !important;
  }

  .patchouli-editor-shell > [data-ui-surface-id='agent'] {
    height: clamp(360px, 52vh, 520px) !important;
  }
}

@media (prefers-reduced-motion: reduce) {
  .patchouli-scope-button,
  .patchouli-resizer::after,
  .dsh-workspace-explorer-scrollbar,
  .dsh-workspace-explorer-pane-sash::after {
    transition: none;
  }

  .patchouli-search-field {
    transition: none;
  }

  .patchouli-edit-switch-track,
  .patchouli-edit-switch-thumb {
    transition: none;
  }
}
`

export function installStyles(): () => void {
  const id = 'dsh-patchouli/client'
  const existing = document.getElementById(id)
  if (existing) return () => undefined

  const tag = document.createElement('style')
  tag.id = id
  tag.dataset.plugin = 'dsh-patchouli'
  tag.textContent = styles
  document.head.appendChild(tag)
  return () => tag.remove()
}
