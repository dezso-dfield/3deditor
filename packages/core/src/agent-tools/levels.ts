import { z } from 'zod'
import { NodeId } from './node-id'

export const listLevelsTool = {
  name: 'list_levels',
  title: 'List levels',
  description:
    'List every level of every building in floor order: id, name, floorIndex, building (parentId), role (occupied storey, roof-only level or support level), child count, and which one the person is viewing (isActive). A roof-only level is the roof, not a storey.',
  input: {},
}

// `level` is the chat's older name for the same parameter; threads and habits still use it.
const levelTarget = {
  levelId: NodeId.optional().describe(
    'The level, by an id list_levels returned; an id made up from a name ("level_1", "level_ground") does not exist. Default: the floor the person is viewing, else the lowest floor.',
  ),
  level: NodeId.optional().describe('Same as levelId.'),
}

export const getLevelSummaryTool = {
  name: 'get_level_summary',
  title: 'Get level summary',
  description:
    "Summarise one level so nothing on it goes unseen: its role and counts, then walls (length, heights, doors and windows), zones (name, area, size, floor_choices), slabs, ceilings, items (floor, wall and ceiling), floor openings, stairs, roofs, and anything else by type. Zone polygons: get_zones; a node's full data: get_node.",
  input: levelTarget,
}

export const getWallsTool = {
  name: 'get_walls',
  title: 'Get walls',
  description:
    'Get the walls of a level: start and end in metres, length, stored and resolved height, thickness, and their doors and windows.',
  input: levelTarget,
}

export const generateScheduleTool = {
  name: 'generate_schedule',
  title: 'Generate schedule',
  description:
    'Produce the documentation schedules a building model carries, like an Archline/CAD schedule: rooms (name, roomType, number, area, perimeter, ceiling height, finishes, door/window counts), doors (category, type, size, host wall), windows (type, size, sill height) and items (catalog id, category, containing room). One level or the whole model; read-only. Room metadata it prints comes from update_room.',
  input: {
    levelId: NodeId.optional().describe(
      'Restrict the schedule to one level, by an id list_levels returned. Default: the whole model, every level.',
    ),
    kind: z
      .enum(['rooms', 'doors', 'windows', 'items', 'all'])
      .optional()
      .describe('Which schedule table to produce. Default: all.'),
  },
}

export const materialsTakeoffTool = {
  name: 'materials_takeoff',
  title: 'Materials takeoff',
  description:
    'Quantity takeoff for the model, per level and in total: floor/slab areas and volumes, wall length and gross/net wall area (openings deducted, resolved wall heights), roof footprint, door/window counts by category and type, furniture counts by catalog category, and the list of finishes/material presets in use. Read-only; the basis for estimates and comparisons.',
  input: {
    levelId: NodeId.optional().describe(
      'Restrict the takeoff to one level, by an id list_levels returned. Default: the whole model.',
    ),
  },
}

export const getZonesTool = {
  name: 'get_zones',
  title: 'Get zones',
  description:
    'Get the zones (rooms) of a level: name, colour, polygon and holes in metres, area in m² (holes taken out), bounding size, and floor_choices: the floor plates the room can take (key, plateId, name, current; drawn and mezzanine flags). A room shares its floor plate with the rooms next to it unless detached.',
  input: levelTarget,
}

export const updateRoomTool = {
  name: 'update_room',
  title: 'Update room',
  description:
    'Name or re-label a room (zone): its display name, roomType (the occupancy label the schedule and furnish_room read — bedroom, kitchen, living, dining, bathroom, office …), roomNumber, ceilingHeight, and the floor/wall/ceiling finish notes. Setting any of these marks the zone a documented room. Read names, types and sizes back with get_zones.',
  input: {
    zoneId: NodeId.describe('The room (zone) to update, by an id get_zones returned.'),
    name: z.string().min(1).max(120).optional().describe('Display name, e.g. "Primary Bedroom".'),
    roomType: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe(
        'Room use label stored as the zone occupancy — what furnish_room infers its layout from and what room schedules print, e.g. "bedroom", "kitchen", "living".',
      ),
    roomNumber: z
      .string()
      .max(32)
      .optional()
      .describe('Plan room number, e.g. "101". Pass "" to clear.'),
    ceilingHeight: z
      .number()
      .min(0.1)
      .max(10)
      .optional()
      .describe('Room ceiling height in metres (default 2.7).'),
    floorFinish: z.string().max(120).optional().describe('Floor finish note, e.g. "oak parquet".'),
    wallFinish: z.string().max(120).optional().describe('Wall finish note.'),
    ceilingFinish: z.string().max(120).optional().describe('Ceiling finish note.'),
  },
}

export const duplicateLevelTool = {
  name: 'duplicate_level',
  title: 'Duplicate level',
  description:
    'Copy a level with everything on it, as the editor does: fresh ids, internal links kept, and units whose rooms are all on that level copied too; plan references, scans and spawn points stay behind. The copy goes above the original (or below it) and the floors past it move up one.',
  input: {
    levelId: NodeId.optional().describe(
      'The level to copy, by an id list_levels returned. Default: the floor the person is viewing.',
    ),
    position: z
      .enum(['above', 'below'])
      .optional()
      .describe('Where the copy goes: above the original (default) or below it.'),
    name: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe('Name of the copy. Default: the original name.'),
    preset: z
      .enum(['everything', 'structure', 'structure-materials', 'structure-furniture'])
      .optional()
      .describe(
        'What to copy, as in the editor: everything (default); structure (walls, zones, slabs, ceilings, roofs, stairs, doors, windows) without materials; structure with its materials; or structure and furniture.',
      ),
  },
}

export const verifySceneTool = {
  name: 'verify_scene',
  title: 'Verify scene',
  description:
    'Check the whole scene after complex edits, and before retrying a failed tool: per-level content and roles (storey, roof-only, support), then every problem found, each with a type: empty levels, walls with no room or door, rooms with no floor or ceiling, storeys with no stair, roof levels misused, openings off their wall, stairs off their slab or blocked, furniture blocking a door or overlapping, nodes their schema rejects.',
  input: {},
}
