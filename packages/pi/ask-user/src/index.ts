/**
 * Ask User Questions Tool
 *
 * Registers an `ask_user` tool that the LLM can call to present
 * interactive multiple-choice questions to the user via an overlay widget.
 *
 * Features:
 * - 1-4 questions per invocation
 * - 2-4 options per question, plus auto-added "Write:" free-text option
 * - Single-select (default) or multi-select per question
 * - Descriptions on separate indented lines
 * - Keyboard navigation: ↑↓ move, Enter select/toggle, Tab/Shift+Tab questions
 * - Esc to cancel from select mode or go back from write mode
 */

import {
	DynamicBorder,
	defineTool,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ── Schema ──────────────────────────────────────────────────────────

const OptionSchema = Type.Object({
	label: Type.String({
		description: "Concise display text (1-5 words)",
		maxLength: 80,
	}),
	description: Type.String({
		description: "What this option means or implies",
		maxLength: 240,
	}),
});

const QuestionSchema = Type.Object({
	question: Type.String({
		description: "Clear question ending with ?",
		maxLength: 240,
	}),
	options: Type.Array(OptionSchema, {
		minItems: 2,
		maxItems: 4,
		description:
			"2-4 distinct choices. No 'Other' option — it is added automatically.",
	}),
	multiSelect: Type.Optional(
		Type.Boolean({
			description: "Allow multiple selections (default false)",
			default: false,
		}),
	),
});

const AskUserSchema = Type.Object({
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		maxItems: 4,
		description: "1-4 questions to ask the user",
	}),
});

// ── Types ───────────────────────────────────────────────────────────

interface QuestionOption {
	label: string;
	description: string;
}
interface Question {
	question: string;
	options: QuestionOption[];
	multiSelect?: boolean;
}
interface AskUserInput {
	questions: Question[];
}
interface AnswerRecord {
	question: string;
	answers: string[];
	skipped: boolean;
}

function sanitizeDisplay(input: string, max = 240): string {
	return stripControlSequences(input, true)
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);
}

function sanitizeTypedBuffer(input: string, max = 240): string {
	return stripControlSequences(input, false).slice(0, max);
}

function stripControlSequences(
	input: string,
	replaceWithSpace: boolean,
): string {
	let result = "";
	for (let i = 0; i < input.length; i++) {
		const code = input.charCodeAt(i);
		if (code === 0x1b) continue;
		if (
			code === 0x202a ||
			code === 0x202b ||
			code === 0x202c ||
			code === 0x202d ||
			code === 0x202e ||
			code === 0x2066 ||
			code === 0x2067 ||
			code === 0x2068 ||
			code === 0x2069
		)
			continue;
		const isControl =
			code <= 0x08 ||
			code === 0x0b ||
			code === 0x0c ||
			(code >= 0x0e && code <= 0x1f) ||
			(code >= 0x7f && code <= 0x9f);
		if (isControl) {
			if (replaceWithSpace) result += " ";
			continue;
		}
		result += input[i] ?? "";
	}
	return result;
}

function isPlainTypedInput(data: string): boolean {
	for (let i = 0; i < data.length; i++) {
		const code = data.charCodeAt(i);
		if ((code >= 0x00 && code <= 0x1f) || code === 0x7f) return false;
	}
	return true;
}

function normalizeQuestions(input: unknown): Question[] | null {
	if (
		!input ||
		typeof input !== "object" ||
		!Array.isArray((input as AskUserInput).questions)
	)
		return null;
	const questions = (input as AskUserInput).questions
		.filter(
			(question): question is Question =>
				!!question &&
				typeof question.question === "string" &&
				Array.isArray(question.options),
		)
		.map((question) => ({
			question: sanitizeDisplay(question.question),
			options: question.options
				.filter(
					(option): option is QuestionOption =>
						!!option &&
						typeof option.label === "string" &&
						typeof option.description === "string",
				)
				.map((option) => ({
					label: sanitizeDisplay(option.label, 80),
					description: sanitizeDisplay(option.description, 240),
				})),
			multiSelect: Boolean(question.multiSelect),
		}))
		.filter(
			(question) =>
				question.question.length > 0 &&
				question.options.length >= 2 &&
				question.options.length <= 4,
		);
	return questions.length > 0 ? questions : null;
}

// ── Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerTool(
		defineTool({
			name: "ask_user",
			label: "Ask User",
			description:
				"Ask the user 1-4 multiple-choice questions to gather preferences, clarify ambiguity, or get decisions. " +
				"Each question has 2-4 options. Users can always type a custom answer. " +
				"Use when you need user input before proceeding. If you recommend an option, make it the first and add '(Recommended)' to its label.",
			parameters: AskUserSchema,

			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const normalized = normalizeQuestions(params);
				if (!normalized) {
					return {
						content: [
							{
								type: "text",
								text: "Error: ask_user received invalid question data.",
							},
						],
						details: { error: "invalidInput" },
					};
				}
				// Non-null alias so the custom() closure below closes over a narrowed binding
				// (control-flow narrowing from the guard does not persist into nested closures).
				const questions = normalized;

				if (!ctx.hasUI) {
					return {
						content: [
							{
								type: "text",
								text: "Error: ask_user requires interactive mode.",
							},
						],
						details: { error: "interactiveRequired" },
					};
				}

				const answers = (await ctx.ui.custom(
					(tui, theme, _kb, done) => {
						const collected: Array<string[] | null> = new Array(
							questions.length,
						).fill(null);
						let currentQ = 0;
						const totalQ = questions.length;

						// ── Per-question state (preserve across tab navigation) ──
						let mode: "select" | "write" = "select";
						let writeBuffer = "";

						const perQuestion: Map<
							number,
							{ checked: Set<number>; focusIdx: number; customText: string }
						> = new Map();
						function getQState(qi: number) {
							let s = perQuestion.get(qi);
							if (!s) {
								s = { checked: new Set(), focusIdx: 0, customText: "" };
								perQuestion.set(qi, s);
							}
							return s;
						}
						function focusIdx(): number {
							return getQState(currentQ).focusIdx;
						}
						function setFocusIdx(v: number) {
							getQState(currentQ).focusIdx = v;
						}
						function multiChecked(): Set<number> {
							return getQState(currentQ).checked;
						}
						function currentQuestion(): Question | null {
							return questions[currentQ] ?? null;
						}
						function clampFocus(q: Question): number {
							const maxIdx = q.options.length;
							const next = Math.min(Math.max(0, focusIdx()), maxIdx);
							setFocusIdx(next);
							return next;
						}
						function answerFor(qi: number): string[] {
							const q = questions[qi];
							if (!q) return [];
							const state = getQState(qi);
							const selected = q.options
								.map((option, index) =>
									state.checked.has(index) ? option.label : null,
								)
								.filter((value): value is string => !!value);
							const custom = sanitizeDisplay(state.customText, 240);
							if (custom) selected.push(custom);
							return Array.from(new Set(selected));
						}
						function isAnswered(qi: number): boolean {
							return (collected[qi]?.length ?? 0) > 0;
						}
						function firstUnanswered(): number {
							return collected.findIndex(
								(answersForQuestion) =>
									!answersForQuestion || answersForQuestion.length === 0,
							);
						}

						let container = new Container();

						function rebuild() {
							container = new Container();
							const q = currentQuestion();
							if (!q) {
								done(
									collected.some((entry) => entry && entry.length > 0)
										? collected
										: null,
								);
								return;
							}
							clampFocus(q);
							const isMulti = !!q.multiSelect;

							// ── Top border ──
							container.addChild(
								new DynamicBorder((s: string) => theme.fg("accent", s)),
							);

							// ── Tab bar ──
							if (totalQ > 1) {
								let tabs = "";
								for (let i = 0; i < totalQ; i++) {
									const label = `Q${i + 1}`;
									const answered = isAnswered(i);
									if (i === currentQ) {
										tabs += theme.fg("accent", theme.bold(` ${label} `));
									} else if (answered) {
										tabs += theme.fg("success", ` ${label} ✓ `);
									} else {
										tabs += theme.fg("dim", ` ${label} `);
									}
									if (i < totalQ - 1) tabs += theme.fg("dim", "│");
								}
								container.addChild(new Text(tabs, 1, 0));
								container.addChild(
									new Text(theme.fg("dim", "─".repeat(60)), 1, 0),
								);
							}

							// ── Question text ──
							container.addChild(
								new Text(
									theme.fg(
										"text",
										theme.bold(sanitizeDisplay(q.question, 240)),
									),
									1,
									0,
								),
							);
							if (isMulti) {
								container.addChild(
									new Text(
										theme.fg(
											"dim",
											"  (select multiple, space to toggle, enter to confirm)",
										),
										1,
										0,
									),
								);
							}

							// ── Write mode ──
							if (mode === "write") {
								container.addChild(new Text("", 0, 0)); // spacer
								container.addChild(
									new Text(theme.fg("accent", "  Write your answer:"), 1, 0),
								);
								const cursor = theme.fg("accent", "▎");
								container.addChild(
									new Text(
										`  ${cursor} ${sanitizeTypedBuffer(writeBuffer, 240)}`,
										1,
										0,
									),
								);
								container.addChild(new Text("", 0, 0)); // spacer
								container.addChild(
									new Text(
										theme.fg(
											"dim",
											"  type your answer · enter to confirm · esc to go back",
										),
										1,
										0,
									),
								);
							}
							// ── Option list (both single and multi-select) ──
							else {
								const allOpts = [
									...q.options.map((o) => ({
										label: o.label,
										desc: o.description,
									})),
									{ label: "✎ Write...", desc: "type a custom answer" },
								];
								container.addChild(new Text("", 0, 0)); // spacer

								for (let i = 0; i < allOpts.length; i++) {
									const opt = allOpts[i];
									if (!opt) continue;
									const focused = i === focusIdx();

									// Prefix: arrow + optional checkbox
									const arrow = focused ? theme.fg("accent", "❯ ") : "  ";
									let checkbox = "";
									if (isMulti) {
										const checked = multiChecked().has(i);
										checkbox = checked
											? theme.fg("success", "◉ ")
											: theme.fg("dim", "○ ");
									}

									const labelStyled = focused
										? theme.fg("accent", theme.bold(opt.label))
										: theme.fg("text", opt.label);

									// Label on its own line
									container.addChild(
										new Text(`${arrow}${checkbox}${labelStyled}`, 1, 0),
									);

									// Description on indented line below (Text wraps long lines automatically)
									const indent = isMulti ? "      " : "    ";
									container.addChild(
										new Text(`${indent}${theme.fg("muted", opt.desc)}`, 1, 0),
									);
								}

								container.addChild(new Text("", 0, 0)); // spacer
							}

							// ── Help text ──
							if (mode !== "write") {
								let help = isMulti
									? "↑↓ navigate · space toggle · enter confirm"
									: "↑↓ navigate · enter select";
								if (totalQ > 1) help += " · tab next · shift+tab prev";
								help += " · esc cancel";
								container.addChild(new Text(theme.fg("dim", help), 1, 0));
							}

							// ── Bottom border ──
							container.addChild(
								new DynamicBorder((s: string) => theme.fg("accent", s)),
							);
						}

						function advanceOrDone() {
							if (currentQ < totalQ - 1) {
								currentQ++;
								mode = "select";
								rebuild();
								tui.requestRender();
							} else {
								const nextUnanswered = firstUnanswered();
								if (nextUnanswered !== -1) {
									currentQ = nextUnanswered;
									mode = "select";
									rebuild();
									tui.requestRender();
									return;
								}
								done(collected);
							}
						}

						function selectCurrent() {
							const q = currentQuestion();
							if (!q) return;
							const idx = clampFocus(q);

							if (idx === q.options.length) {
								mode = "write";
								writeBuffer = getQState(currentQ).customText;
								rebuild();
								tui.requestRender();
								return;
							}

							if (q.multiSelect) {
								const checked = multiChecked();
								if (checked.has(idx)) checked.delete(idx);
								else checked.add(idx);
								collected[currentQ] = answerFor(currentQ);
								rebuild();
								tui.requestRender();
							} else {
								const selectedOption = q.options[idx];
								if (!selectedOption) return;
								collected[currentQ] = [selectedOption.label];
								advanceOrDone();
							}
						}

						function confirmMulti() {
							const q = currentQuestion();
							if (!q) return;
							const idx = clampFocus(q);
							if (idx === q.options.length) {
								selectCurrent();
								return;
							}
							const selected = answerFor(currentQ);
							if (selected.length === 0) return; // need at least one
							collected[currentQ] = selected;
							advanceOrDone();
						}

						signal?.addEventListener(
							"abort",
							() => {
								done(
									collected.some((entry) => entry && entry.length > 0)
										? collected
										: null,
								);
							},
							{ once: true },
						);

						rebuild();

						return {
							render(width: number) {
								return container.render(width);
							},
							invalidate() {
								container.invalidate();
							},
							handleInput(data: string) {
								const q = currentQuestion();
								if (!q) return;
								const isMulti = !!q.multiSelect;

								// ── Tab navigation between questions ──
								if (mode === "select" && totalQ > 1) {
									if (matchesKey(data, Key.tab)) {
										if (currentQ < totalQ - 1) {
											currentQ++;
											mode = "select";
											rebuild();
											tui.requestRender();
											return;
										}
									}
									if (matchesKey(data, Key.shift("tab"))) {
										if (currentQ > 0) {
											currentQ--;
											mode = "select";
											rebuild();
											tui.requestRender();
											return;
										}
									}
								}

								// ── Write mode input ──
								if (mode === "write") {
									if (matchesKey(data, Key.escape)) {
										mode = "select";
										writeBuffer = getQState(currentQ).customText;
										rebuild();
										tui.requestRender();
										return;
									}
									if (matchesKey(data, Key.enter)) {
										const custom = sanitizeDisplay(writeBuffer, 240);
										if (custom) {
											getQState(currentQ).customText = custom;
											collected[currentQ] = q.multiSelect
												? answerFor(currentQ)
												: [custom];
											mode = "select";
											writeBuffer = "";
											advanceOrDone();
										}
										return;
									}
									if (matchesKey(data, Key.backspace)) {
										writeBuffer = writeBuffer.slice(0, -1);
										rebuild();
										tui.requestRender();
										return;
									}
									if (data && isPlainTypedInput(data)) {
										writeBuffer = sanitizeTypedBuffer(
											`${writeBuffer}${data}`,
											240,
										);
										rebuild();
										tui.requestRender();
										return;
									}
									return;
								}

								// ── Option list navigation (unified for single & multi) ──
								const maxIdx = q.options.length;

								if (
									matchesKey(data, Key.up) ||
									matchesKey(data, Key.ctrl("p"))
								) {
									setFocusIdx(Math.max(0, focusIdx() - 1));
									rebuild();
									tui.requestRender();
									return;
								}
								if (
									matchesKey(data, Key.down) ||
									matchesKey(data, Key.ctrl("n"))
								) {
									setFocusIdx(Math.min(maxIdx, focusIdx() + 1));
									rebuild();
									tui.requestRender();
									return;
								}
								if (matchesKey(data, Key.space) && isMulti) {
									selectCurrent();
									return;
								}
								if (matchesKey(data, Key.enter)) {
									if (isMulti) {
										confirmMulti();
									} else {
										selectCurrent();
									}
									return;
								}
								if (matchesKey(data, Key.escape)) {
									done(
										collected.some((entry) => entry && entry.length > 0)
											? collected
											: null,
									);
									return;
								}
							},
						};
					},
					{
						overlay: true,
						overlayOptions: {
							anchor: "center",
							width: "80%",
							minWidth: 50,
							maxHeight: "80%",
						},
					},
				)) as Array<string[] | null> | null;

				const answerRecords: AnswerRecord[] = questions.map(
					(question, index) => ({
						question: question.question,
						answers: answers?.[index] ?? [],
						skipped: !answers?.[index] || (answers[index]?.length ?? 0) === 0,
					}),
				);

				if (!answers || signal?.aborted) {
					return {
						content: [
							{
								type: "text",
								text: "User dismissed the questions without answering.",
							},
						],
						details: {
							cancelled: true,
							answers: answerRecords.filter((record) => !record.skipped),
						},
					};
				}

				const unanswered = answerRecords.filter((record) => record.skipped);
				if (unanswered.length > 0) {
					return {
						content: [
							{
								type: "text",
								text: `User left ${unanswered.length} question(s) unanswered.`,
							},
						],
						details: { cancelled: true, answers: answerRecords },
					};
				}

				const answerLines = answerRecords.map((record) => {
					return `Q: ${record.question}\nA: ${record.answers.join(", ")}`;
				});

				return {
					content: [
						{
							type: "text",
							text: `User answered your questions:\n\n${answerLines.join("\n\n")}\n\nProceed based on the user's choices.`,
						},
					],
					details: { answers: answerRecords },
				};
			},

			// ── Rendering ─────────────────────────────────────────────

			renderCall(args, theme, context) {
				const text =
					(context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
				const input = args as Partial<AskUserInput>;
				let s = theme.fg("toolTitle", theme.bold("ask "));
				const firstQuestion =
					typeof input.questions?.[0]?.question === "string"
						? sanitizeDisplay(input.questions[0].question)
						: undefined;
				if (input.questions?.length === 1 && firstQuestion) {
					s += theme.fg("accent", firstQuestion);
				} else if ((input.questions?.length ?? 0) > 1) {
					s += theme.fg("accent", `${input.questions?.length} questions`);
				} else {
					s += theme.fg("dim", "questions");
				}
				text.setText(s);
				return text;
			},

			renderResult(result, { isPartial }, theme) {
				if (isPartial) {
					return new Text(theme.fg("warning", "Waiting for answers…"), 0, 0);
				}

				const details = result.details as
					| { answers?: AnswerRecord[]; cancelled?: boolean; error?: string }
					| undefined;

				if (details?.error) {
					return new Text(
						theme.fg(
							"error",
							details.error === "interactiveRequired"
								? "Interactive UI required"
								: "Failed",
						),
						0,
						0,
					);
				}

				if (details?.cancelled) {
					return new Text(theme.fg("dim", "Dismissed"), 0, 0);
				}

				if (!details?.answers || details.answers.length === 0) {
					return new Text(theme.fg("dim", "No answers recorded"), 0, 0);
				}

				const lines: string[] = [];
				for (const answer of details.answers) {
					lines.push(
						theme.fg("dim", "· ") +
							theme.fg("muted", sanitizeDisplay(answer.question, 120)) +
							theme.fg("dim", " → ") +
							theme.fg(
								"success",
								sanitizeDisplay(answer.answers.join(", "), 160),
							),
					);
				}
				return new Text(lines.join("\n"), 0, 0);
			},
		}),
	);
}
