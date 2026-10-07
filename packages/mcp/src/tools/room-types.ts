import type { AnyNode } from '@pascal-app/core/schema'

export const ROOM_TYPES = [
  'bedroom',
  'kitchen',
  'bathroom',
  'living',
  'dining',
  'office',
  'hallway',
  'entry',
  'laundry',
  'storage',
  'kids',
  'gym',
  'game',
] as const

// Room-use keywords → a furnish_room layout, used when roomType is omitted and
// the zone carries a name or occupancy label instead (see update_room).
const ROOM_TYPE_KEYWORDS: [RegExp, (typeof ROOM_TYPES)[number]][] = [
  [/office|study|workspace|den|desk/i, 'office'],
  [/bed|sleep|guest.?room|primary.?bedroom|master/i, 'bedroom'],
  [/kitchen|cook|culinar/i, 'kitchen'],
  [/bath|toilet|wc|lavator|shower|ensuite|powder/i, 'bathroom'],
  [/living|lounge|family.?room|sitting|tv.?room|parlou?r/i, 'living'],
  [/dining|eat.?in|breakfast/i, 'dining'],
  [/hall|corridor|passage|landing/i, 'hallway'],
  [/entry|foyer|mudroom|vestibule/i, 'entry'],
  [/laundry|utility|wash/i, 'laundry'],
  [/kid|child|nursery|playroom|toddler/i, 'kids'],
  [/gym|fitness|workout|exercise|training/i, 'gym'],
  [/game|play|hobby|leisure|pool.?table|billiard|entertainment|rec.?room|media.?room/i, 'game'],
  [/storage|store|closet|pantry|garage|shed|archive/i, 'storage'],
]

/** A zone's occupancy label, then its name, mapped to a furnish_room layout. */
export function inferRoomType(zone: AnyNode | null) {
  if (zone?.type !== 'zone') return undefined
  const occupancy = zone.occupancy?.trim()
  const name = zone.name?.trim()
  for (const [pattern, roomType] of ROOM_TYPE_KEYWORDS) {
    if (occupancy && pattern.test(occupancy)) return roomType
    if (name && pattern.test(name)) return roomType
  }
  return undefined
}
