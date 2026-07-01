import type { ClarifyPromptQuestion, ClarifyPromptRecord } from "../../types/index.js";

export type ClarifyOptionSubmitResult =
  | { answer: string | string[]; kind: "submit"; optionId?: string }
  | { kind: "enter_custom" }
  | { kind: "blocked"; message: string };

export function resolveActiveClarifyQuestion(
  prompt: ClarifyPromptRecord,
  questionIndex: number
): ClarifyPromptQuestion {
  return (
    prompt.questions[questionIndex] ?? {
      allowCustomAnswer: prompt.allowCustomAnswer,
      multiSelect: false,
      options: prompt.options,
      placeholder: prompt.placeholder,
      question: prompt.question
    }
  );
}

export function shouldStartClarifyInCustomMode(question: ClarifyPromptQuestion): boolean {
  return question.allowCustomAnswer && question.options.length === 0;
}

export function resolveClarifyOptionSubmit(input: {
  question: ClarifyPromptQuestion;
  selectedOptionIds: string[];
  selectionIndex: number;
}): ClarifyOptionSubmitResult {
  const { question, selectedOptionIds, selectionIndex } = input;

  if (question.multiSelect) {
    const selectedLabels = question.options
      .filter((option) => selectedOptionIds.includes(option.id))
      .map((option) => option.label);
    if (selectedLabels.length === 0) {
      return {
        kind: "blocked",
        message: "Select at least one option with Space, then press Enter."
      };
    }
    return { kind: "submit", answer: selectedLabels };
  }

  if (question.options.length === 0) {
    if (question.allowCustomAnswer) {
      return { kind: "enter_custom" };
    }
    return {
      kind: "blocked",
      message: "This clarification has no answer choices. Press Ctrl+C to cancel."
    };
  }

  const option = question.options[selectionIndex];
  if (option === undefined) {
    return {
      kind: "blocked",
      message: "Choose an option with the arrow keys, then press Enter."
    };
  }
  return { kind: "submit", answer: option.label, optionId: option.id };
}

export function clarifyPromptHint(question: ClarifyPromptQuestion): string {
  if (question.options.length === 0 && question.allowCustomAnswer) {
    return "Type your answer, Enter submit, Ctrl+C cancel";
  }
  if (question.multiSelect) {
    return "arrows choose, Space toggle, Tab custom, Enter submit, Ctrl+C cancel";
  }
  return "arrows choose, Tab custom, Enter submit, Ctrl+C cancel";
}
