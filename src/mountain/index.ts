export type {
  MountainSource,
  SourceStatus,
  HarvestJob,
  HarvestResult,
  HarvestItem,
  HarvestError,
} from "./types.ts";

export { MountainOrchestrator } from "./orchestrator.ts";

export type { MountainRecord, MountainRecordStatus, InsertMountainRecord } from "./records.ts";
export {
  insertRecord,
  upsertRecord,
  getRecord,
  getRecordByExternalId,
  listRecords,
  updateRecordStatus,
  countRecords,
} from "./records.ts";

export { MCPConnectorSource, type MCPToolCaller, type MCPConnectorConfig } from "./mcp-connector.ts";
export { GoogleWorkspaceMountainSource } from "./connectors/google-workspace.ts";
export { GitHubMountainSource } from "./connectors/github.ts";
export { PlaneMountainSource } from "./connectors/plane.ts";

export {
  MessageIngestionSource,
  ingestMessage,
  normalizeMessage,
  detectRecordType,
  resolveSender,
  setIngestionEnabled,
  isIngestionEnabled,
  enableChannel,
  disableChannel,
  isChannelEnabled,
  getEnabledChannels,
  type IncomingMessage,
  type MessageChannel,
  type MessageRecordType,
  type NormalizedMessagePayload,
  type MessageFetcher,
  type MessageFetchOptions,
} from "./message-ingestion.ts";

export {
  RiverSink,
  mapRecordToDocument,
  buildDocumentPath,
  buildDocumentContent,
  buildFrontmatter,
  sanitizePathSegment,
  _makeMockRecord,
  type RawDocument,
  type RiverSinkResult,
  type RiverSinkConfig,
} from "./river-sink.ts";

export {
  ClaudeEntityExtractor,
  IdentityResolver,
  ExtractionPipeline,
  buildExtractionPrompt,
  parseExtractionResponse,
  validateEntity,
  getContentFromRecord,
  buildEntityDocument,
  normalizeName,
  _makeMockRecordForExtraction,
  _makeMockClaudeCallFn,
  _makeMockClaudeCallFnError,
  type EntityExtractor,
  type EntityType,
  type ExtractedEntity,
  type PersonEntity,
  type TopicEntity,
  type ActionItemEntity,
  type DecisionEntity,
  type PersonIdentifier,
  type ExtractionResult,
  type ExtractionConfig,
  type IdentityProfile,
  type ClaudeCallFn,
} from "./entity-extraction.ts";
