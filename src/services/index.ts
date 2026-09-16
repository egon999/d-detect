/**
 * Services.
 *
 * The layer between the pure domain and the screens: storage adapter selection, session,
 * and the React bindings over the repository port.
 *
 * A barrel exists here — and not for `@domain` or `@data` — because a screen routinely
 * needs three of these at once (`useSession` for the owner, `useWorkspace` for the data,
 * `useMutator` to write), and they live in separate files for reasons that are about
 * implementation rather than about how they are used. The domain layer is deliberately
 * imported by exact path instead: it is large, and a barrel there would pull the whole
 * rule engine into any module that wanted one label map.
 */

export {
  RepositoryProvider,
  useRepository,
  type RepositoryContextValue,
  type RepositoryKind,
} from './repository-provider';

export {
  SessionProvider,
  useSession,
  useOwnerId,
  type SessionStatus,
  type SessionUser,
  type SessionValue,
} from './session-provider';

export {
  useCaseList,
  useWorkspace,
  useMutator,
  useCaseData,
  useCaseRecord,
  mutationContext,
  type CaseListState,
  type WorkspaceState,
  type Mutator,
  type MutationResult,
} from './use-case-store';

export * from './ai';
export * from './storage/cloudinary';
export * from './storage/evidence-storage';

export {
  requestSeal,
  type SealOutcome,
  type SealReceipt,
} from './crucible/request-seal';
