import { z } from 'zod'
import { NodeId } from './node-id'

/**
 * How an item should face, in level plan coordinates (x/z, no yaw math needed):
 * - point: front aims at [x, z]
 * - node: front aims at another node's center
 * - away: back aims at the node (headboards and storage that hug a wall)
 */
export const facingSpecSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('point'),
      point: z.array(z.number()).min(2).max(2).describe('[x, z] plan position the front aims at.'),
    })
    .strict(),
  z
    .object({
      mode: z.literal('node'),
      nodeId: NodeId.describe('Node the front aims at.'),
    })
    .strict(),
  z
    .object({
      mode: z.literal('away'),
      nodeId: NodeId.describe('Node the back aims at — e.g. the wall a headboard hugs.'),
    })
    .strict(),
])

export type FacingSpec = z.infer<typeof facingSpecSchema>

export const orientItemTool = {
  name: 'orient_item',
  title: 'Orient item',
  description:
    "Rotate an item around the vertical axis so its front faces a point or another node — a chair toward its table, a TV toward the sofa, a bed's headboard against a wall (facing mode 'away'). An item's front is the side a person uses: the seat edge of a chair, the screen of a TV, the doors of a wardrobe; convention: local +Z at yaw 0. Use this instead of guessing radians for place_item/apply_patch rotations.",
  input: {
    itemId: NodeId.describe(
      'The floor item to rotate (a wall- or ceiling-attached item faces its host instead).',
    ),
    facing: facingSpecSchema,
  },
}

export const improveLayoutTool = {
  name: 'improve_layout',
  title: 'Improve layout',
  description:
    "Act on review_layout's findings instead of only listing them: seats are rotated to face their table, items whose front faces a wall are turned around, beds and storage are pushed flush to the nearest wall, and items blocking doors or walkways are slid into the room. Every change is validated against overlaps and door keep-outs before it lands; what cannot be moved safely comes back under `unfixed` with the reason. Run review_layout afterwards to confirm, then decorate_room for styling.",
  input: {
    levelId: NodeId.optional().describe('Improve one level. Default: every occupied level.'),
    zoneId: NodeId.optional().describe('Improve only the zone (room) with this id.'),
  },
}

export const reviewLayoutTool = {
  name: 'review_layout',
  title: 'Review layout',
  description:
    'Interior-design review of a room or level: doors blocked by furniture, item overlaps, functional clearance violations (the front space an item needs — a fridge door swing, a toilet approach — and the pull-out space behind chairs), seating that does not face its table, beds whose headboard floats off the wall, storage floating off walls, items whose front faces a wall, and blocked walkways from doors into a room. `suggestions` adds styling ideas rather than defects — a bare wall behind a sofa or bed that art would suit, a table with no light overhead. Read-only; fix placements with orient_item, place_item or delete_node, dress the room with decorate_room, then re-review.',
  input: {
    levelId: NodeId.optional().describe('Review one level. Default: every occupied level.'),
    zoneId: NodeId.optional().describe(
      'Review only the zone (room) with this id — also enables walkway checks into the room.',
    ),
  },
}
