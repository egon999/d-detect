/**
 * Confirmation for an action that destroys something.
 *
 * One helper rather than an inline branch at each call site, because the branch is the whole
 * problem: `Alert.alert` compiles on web and then does nothing at all. A screen that calls it
 * directly loses the confirmation *and* never runs the callback, so on the web build the
 * button simply appears broken — no dialog, no effect, no error. Getting that wrong once is
 * easy; getting it wrong in five places is what actually happens.
 *
 * `window.confirm` is a blunt instrument and looks like the browser rather than like this
 * app. It is used anyway: the alternative is a modal dialog component, and this project has
 * only a handful of destructive actions to confirm. A native-looking dialog nobody can
 * dismiss incorrectly beats a bespoke one written for a few strings.
 *
 * This deliberately does not return a promise. A confirmation is answered by the user at
 * their own pace, and an `await` at the call site would suggest the surrounding function is
 * still in flight while a dialog sits on screen.
 */

import { Alert, Platform } from 'react-native';

export interface DestructiveConfirmation {
  title: string;
  /** What will and will not change. The place to say what is *kept*, not only what is lost. */
  message: string;
  /**
   * The verb, e.g. "Remove key".
   *
   * Never "OK". A confirm button that names its action can be read on its own, which matters
   * on Android where the two buttons sit side by side with no styling to tell them apart.
   */
  confirmLabel: string;
  onConfirm: () => void;
}

export function confirmDestructive({
  title,
  message,
  confirmLabel,
  onConfirm,
}: DestructiveConfirmation): void {
  if (Platform.OS === 'web') {
    if (window.confirm(`${title}\n\n${message}`)) onConfirm();
    return;
  }

  Alert.alert(title, message, [
    // Cancel first, and marked as the cancel action, so a hardware back press or a tap
    // outside resolves to "do nothing" rather than to the destructive branch.
    { text: 'Cancel', style: 'cancel' },
    { text: confirmLabel, style: 'destructive', onPress: onConfirm },
  ]);
}
