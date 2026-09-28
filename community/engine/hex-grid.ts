// Pinned native HexGrid (35326/55216): ordinal IDs are row * 100 + column.
// Imported land may extend beyond map.width/height, but not this fixed domain.
export const HEX_GRID_AREA = 100 * 100;
export const MAX_HEX_ID = HEX_GRID_AREA - 1;
