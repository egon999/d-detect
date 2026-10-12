export {
  ApiError,
  configureApi,
  apiBaseUrl,
  fileEndpoint,
  currentAuthHeaders,
  apiGet,
  apiPost,
  apiPatch,
  apiPut,
  apiDelete,
  apiUpload,
  apiUploadTracked,
  uploadTimeoutMs,
  UPLOAD_CANCELLED,
  type QueryInput,
  type QueryValue,
  type UploadProgress,
  type TrackedUpload,

  fetchCached,
  clearApiCache,
  CACHE_FRESH_MS,
  serverNow,
  serverDate,
  clockSkewMs,
  type Cached,
  type CachedOutcome,
  type ApiIdentity,
  type AuthRefresh,
  setCustomApiBaseUrl,
  getCustomApiBaseUrl,
  loadPersistedCustomApiBaseUrl,
  persistCustomApiBaseUrl,
  testServerConnection,
  CUSTOM_API_URL_STORAGE_KEY,
  isLocalLoopback,
} from './client';

export { readableError, isCancelled, worthRetrying } from './errors';

export {
  appendUpload,
  uploadBytes,
  SAVE_SIZE_LIMIT_BYTES,
  AUDIO_SIZE_LIMIT_BYTES,
  tooLargeToSend,
  isUploadCancelled,
  runTracked,
  trackedCapture,
  trackedMeetingUpload,
  createUploadQueue,
  RECORD_TITLE_LIMIT,
  NOTE_LIMIT,
  titleFromNote,
  formatRecordingLength,
  spokenRecordingLength,
  RECORDING_SOFT_LIMIT_MS,
  RECORDING_HARD_LIMIT_MS,
  recordingAdvice,
  decideAccess,
  useFileSource,
  type UploadFile,
  type QueueItemState,
  type QueueItem,
  type QueueSnapshot,
  type QueueEntry,
  type QueueSend,
  type UploadQueueOptions,
  type UploadQueue,
  type RecordingAdvice,
  type AccessNeed,
  type AccessStatus,
  type AccessDecision,
  type FileSource,
  type FileSourceState,
} from './files';

export { getHealth, type HealthReport } from './health';
export {
  getMe,
  updateMe,
  exportAccount,
  deleteAccount,
  DELETE_CONFIRMATION,
  type Me,
  type MePatch,
  type MeUpdate,
  type StoredSummary,
  type StoredCategory,
  type AccountExport,
  type AccountExportTotals,
  type AccountDeleted,
} from './me';

export * from './daybook';
export * from './meetings';
export * from './insights';
export * from './tasks';
export * from './attention';
export * from './cases';
export * from './search';
