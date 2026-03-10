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
