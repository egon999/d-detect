/**
 * UI surface.
 *
 * Screens import from `@ui` rather than reaching into `@ui/primitives/...`, so moving a
 * component between files is not a change to every screen that used it.
 */

export * from './tokens';
export * from './theme';
export * from './fonts';
export * from './icon';
export * from './format';

// Colour arithmetic. Exported because a screen that wants a token at a different opacity has
// exactly two options, and hand-written `rgba(...)` literals scattered through screens are how
// a palette stops being a palette.
export * from './color';

// `semantics` re-exports the domain label maps alongside the visual mappings, so a screen
// gets both from one import.
export * from './semantics';

// `readable` is the total layer over those maps: what a screen calls when it is about to render
// a value it did not write and cannot narrow to a type.
export * from './readable';

export * from './primitives/Text';
export * from './primitives/Layout';
export * from './primitives/ErrorBoundary';
export * from './primitives/Chip';
export * from './primitives/Button';
export * from './primitives/Field';
export * from './primitives/Feedback';
export * from './primitives/ProvenanceValue';

// The app's second material. `Excerpt` renders a line of the reader's own document with the
// value marked, which is the one thing on any screen that is not the app's own words — see the
// glass/paper split in `PaperTokens`.
export * from './primitives/Excerpt';

export * from './primitives/Screen';
export * from './primitives/AnimatedSplashScreen';
export * from './primitives/UserAvatar';

// The liquid-glass surface and the motion set. Exported here rather than left to deep
// imports because screens are expected to reach for these constantly — a primitive that is
// awkward to import is a primitive that gets reimplemented inline.
export * from './primitives/GlassSurface';
export * from './primitives/Motion';
export * from './primitives/Progress';

// The two overlay primitives. `ToastProvider` has to be mounted once at the app root for
// `useToast()` to resolve anywhere; `BottomSheet` is mounted per use site.
export * from './primitives/Toast';
export * from './primitives/BottomSheet';

