/**
 * The state a screen shows when no AI key has been added.
 *
 * No model-provider key ships in the bundle — `EXPO_PUBLIC_*` values are inlined into the
 * JavaScript bundle at build time, so a key shipped that way would be published rather
 * than hidden — which makes "no key" the state of every fresh install, not an edge case.
 * It is therefore presented as a setting that has not been turned on, not as a failure:
 * no red, no "could not complete", and no Retry, because retrying will not add a key.
 *
 * A screen that offers an AI action should check `aiAvailable()` before it starts, so that
 * this replaces the spinner rather than following one. `case-analysis-panel.tsx` does; not
 * every surface does yet. A key that exists but is *rejected* is a different situation and
 * keeps the ordinary error path.
 */

import React from 'react';

import { EmptyState } from '@ui';

export interface AISetupNoticeProps {
  /**
   * Names the suggestion that is unavailable, in the sentence "… would have <action>".
   * Keep it a verb phrase: `'cross-referenced this claim against your files'`.
   */
  action: string;
  /** Compact variant, for a section inside a card that already has a header. */
  compact?: boolean;
}

export function AISetupNotice({ action, compact = false }: AISetupNoticeProps) {
  return (
    <EmptyState
      icon="scale-balance"
      title="AI suggestions are off"
      message={`Connect a provider key in Settings and a model will ${action}. The assessment itself runs either way - AI only adds suggestions you review, and nothing about the case waits on it.`}
      compact={compact}
    />
  );
}
