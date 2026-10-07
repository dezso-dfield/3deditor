import type { z } from 'zod'
import type { updateRoomTool } from '../agent-tools/levels'
import { refuse } from '../agent-tools/refusal'
import type { AgentOperation } from './types'

export type UpdateRoomInput = z.infer<z.ZodObject<typeof updateRoomTool.input>>

const EDITABLE = [
  'name',
  'roomType',
  'roomNumber',
  'ceilingHeight',
  'floorFinish',
  'wallFinish',
  'ceilingFinish',
] as const

/**
 * `update_room`: rename a zone or set its room documentation fields. Writing
 * any of them marks the zone a documented room (`spaceRole: 'room'`), matching
 * what the editor does when a room gets named.
 */
export const updateRoom: AgentOperation<UpdateRoomInput> = (nodes, input) => {
  const zone = nodes[input.zoneId]
  if (!zone) refuse('node_not_found', `Node not found: ${input.zoneId}.`)
  if (zone.type !== 'zone') refuse('not_a_zone', `${input.zoneId} is a ${zone.type}, not a zone.`)

  const updated = EDITABLE.filter((field) => input[field] !== undefined)
  if (updated.length === 0)
    refuse('nothing_to_update', `update_room needs at least one field of ${EDITABLE.join(', ')}.`)

  const data: Record<string, unknown> = { spaceRole: 'room' }
  if (input.name !== undefined) data.name = input.name
  if (input.roomType !== undefined) data.occupancy = input.roomType
  if (input.roomNumber !== undefined) data.roomNumber = input.roomNumber
  if (input.ceilingHeight !== undefined) data.ceilingHeight = input.ceilingHeight
  if (input.floorFinish !== undefined) data.floorFinish = input.floorFinish
  if (input.wallFinish !== undefined) data.wallFinish = input.wallFinish
  if (input.ceilingFinish !== undefined) data.ceilingFinish = input.ceilingFinish

  return {
    result: { zoneId: zone.id, updated },
    changes: { update: [{ id: zone.id, data }] },
  }
}
