/**
 * Public surface of the workflows package. Grows as later tasks land the
 * runtime, scheduler, and host integration.
 */

export {
	MetaError,
	type ParsedScript,
	parseScript,
	ScriptSyntaxError,
	type WorkflowMeta,
	type WorkflowPhase,
} from "./runtime/meta";
