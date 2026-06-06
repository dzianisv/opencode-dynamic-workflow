export const VERSION = "0.0.0";

export type { IdGenerator, IdGeneratorOptions } from "./ids";
export { createIdGenerator } from "./ids";
export type {
	BgTask,
	Clock,
	LaunchRequest,
	ReadOpts,
	SessionRunner,
	TaskOutput,
	TaskStatus,
} from "./types";
export {
	isTerminal,
	TERMINAL_STATUSES,
} from "./types";
