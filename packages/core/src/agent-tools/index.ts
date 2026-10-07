import { addObjectTool, getSourceTool } from './add-object'
import { editCollectionTool, listCollectionsTool } from './collections'
import { addColumnTool } from './columns'
import { findByTypeTool } from './find-by-type'
import { improveLayoutTool, orientItemTool, reviewLayoutTool } from './items'
import {
  duplicateLevelTool,
  getLevelSummaryTool,
  getWallsTool,
  getZonesTool,
  listLevelsTool,
  updateRoomTool,
  verifySceneTool,
} from './levels'
import { deleteNodeTool, getNodeTool } from './nodes'
import { fitStairTool, measureStairTool } from './stairs'
import { addDoorTool, addWindowTool } from './wall-openings'

export * from './add-object'
export * from './collections'
export * from './columns'
export * from './find-by-type'
export * from './hosted-services'
export * from './items'
export * from './levels'
export * from './measurement'
export { NodeId } from './node-id'
export * from './nodes'
export * from './refusal'
export * from './stairs'
export * from './wall-openings'

/**
 * Tools defined once for every agent surface — the MCP server and the hosted AI chat register
 * each from this contract (name, description, input schema), and a parity test fails when a
 * surface drifts. See wiki/architecture/agent-surfaces.md.
 */
export const AGENT_TOOL_CONTRACTS = [
  addColumnTool,
  measureStairTool,
  fitStairTool,
  addDoorTool,
  addWindowTool,
  listLevelsTool,
  getNodeTool,
  getLevelSummaryTool,
  getWallsTool,
  getZonesTool,
  duplicateLevelTool,
  verifySceneTool,
  deleteNodeTool,
  addObjectTool,
  getSourceTool,
  findByTypeTool,
  editCollectionTool,
  listCollectionsTool,
  orientItemTool,
  reviewLayoutTool,
  improveLayoutTool,
  updateRoomTool,
] as const
