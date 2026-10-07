import type { z } from 'zod'
import type { orientItemTool } from '../agent-tools/items'
import { refuse } from '../agent-tools/refusal'
import { itemFront, itemWorldPlan, resolveFacingYaw } from './item-facing'
import type { AgentOperation } from './types'

export type OrientItemInput = z.infer<z.ZodObject<typeof orientItemTool.input>>

/**
 * `orient_item`: aim an item's front at a point or another node. The spec is
 * resolved in world plan coordinates and the yaw written back in the frame the
 * item stores (host frame for item-hosted children) — the renderer never sees
 * the math. Tilt (rotation x/z) is preserved.
 */
export const orientItem: AgentOperation<OrientItemInput> = (nodes, input) => {
  const item = nodes[input.itemId]
  if (!item) refuse('node_not_found', `Node not found: ${input.itemId}.`)
  if (item.type !== 'item') refuse('not_an_item', `${item.id} is a ${item.type}, not an item.`)
  if (item.wallId || item.roofSegmentId || item.blockFaceId || item.asset?.attachTo)
    refuse(
      'attached_item',
      `${item.name ?? item.id} is attached to a ${item.wallId || item.roofSegmentId ? 'wall face' : (item.asset?.attachTo ?? 'host')}; wall-mounted items face their wall and are moved with their host, not rotated.`,
    )

  const parent = item.parentId ? nodes[item.parentId] : undefined
  if (parent?.type !== 'level' && parent?.type !== 'item')
    refuse(
      'unsupported_parent',
      `${item.name ?? item.id} sits on a ${parent?.type ?? 'missing parent'}; orient_item turns floor and item-hosted items.`,
    )

  const frame = itemWorldPlan(nodes, item)
  if (!frame)
    refuse('non_finite_pose', `${item.name ?? item.id} has a non-planar pose it cannot orient.`)

  const { yaw: worldYaw } = resolveFacingYaw(
    nodes,
    [frame.x, frame.z],
    itemFront(item),
    input.facing,
  )
  const hostYaw = parent?.type === 'item' ? (parent.rotation?.[1] ?? 0) : 0
  const localYaw = worldYaw - hostYaw

  const rotation: [number, number, number] = [
    item.rotation?.[0] ?? 0,
    localYaw,
    item.rotation?.[2] ?? 0,
  ]
  return {
    result: {
      itemId: item.id,
      yaw: localYaw,
      facing: input.facing,
      front: itemFront(item),
    },
    changes: { update: [{ id: item.id, data: { rotation } }] },
  }
}
