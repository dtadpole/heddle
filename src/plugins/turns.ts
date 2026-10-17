import { TurnRegistry } from '../agent/turns.ts'

/** The live-turn registry, as the profile row that provides `ctx.turns`. */
export const name = 'turns'

export default class TurnsPlugin extends TurnRegistry {}
