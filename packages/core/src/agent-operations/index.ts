import { applyStyle } from './apply-style'
import { deleteNode } from './delete-node'
import { duplicateLevel } from './duplicate-level'
import { findByType } from './find-by-type'
import { getNode } from './get-node'
import { getLevelSummary, getWalls, getZones } from './level-reads'
import { listLevels } from './list-levels'
import { orientItem } from './orient-item'
import { reviewLayout } from './review-layout'
import { generateSchedule, materialsTakeoff } from './schedules'
import { fitStair, measureStairOperation } from './stairs'
import { updateRoom } from './update-room'
import { verifyScene } from './verify-scene'

export * from './add-column'
export * from './add-object'
export * from './apply-changes'
export * from './apply-style'
export * from './collections'
export * from './delete-node'
export * from './door-clearance'
export * from './duplicate-level'
export * from './find-by-type'
export * from './get-node'
export * from './hosted-services'
export * from './item-facing'
export * from './layout-clearance'
export * from './level-reads'
export * from './level-target'
export * from './list-levels'
export * from './material-preset'
export * from './orient-item'
export * from './plan-geometry'
export * from './review-layout'
export * from './scene-queries'
export * from './schedules'
export * from './stairs'
export * from './types'
export * from './update-room'
export * from './verify-scene'

/** Each shared agent tool's operation, by tool name: what every surface executes. */
export const AGENT_OPERATIONS = {
  measure_stair: measureStairOperation,
  fit_stair: fitStair,
  list_levels: listLevels,
  get_node: getNode,
  get_level_summary: getLevelSummary,
  get_walls: getWalls,
  get_zones: getZones,
  duplicate_level: duplicateLevel,
  verify_scene: verifyScene,
  delete_node: deleteNode,
  find_by_type: findByType,
  orient_item: orientItem,
  review_layout: reviewLayout,
  update_room: updateRoom,
  apply_style: applyStyle,
  generate_schedule: generateSchedule,
  materials_takeoff: materialsTakeoff,
} as const
