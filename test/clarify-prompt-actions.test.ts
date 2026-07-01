import { describe, expect, it } from "vitest";

import {
  clarifyPromptHint,
  resolveClarifyOptionSubmit,
  shouldStartClarifyInCustomMode
} from "../src/tui/view-models/clarify-prompt-actions.js";

describe("clarify prompt actions", () => {
  it("starts custom mode when there are no options but custom answers are allowed", () => {
    expect(
      shouldStartClarifyInCustomMode({
        allowCustomAnswer: true,
        multiSelect: false,
        options: [],
        placeholder: null,
        question: "What should we do?"
      })
    ).toBe(true);
  });

  it("enters custom mode on Enter when only a custom answer is available", () => {
    expect(
      resolveClarifyOptionSubmit({
        question: {
          allowCustomAnswer: true,
          multiSelect: false,
          options: [],
          placeholder: null,
          question: "Describe the change"
        },
        selectedOptionIds: [],
        selectionIndex: 0
      })
    ).toEqual({ kind: "enter_custom" });
  });

  it("blocks multi-select submit until at least one option is selected", () => {
    expect(
      resolveClarifyOptionSubmit({
        question: {
          allowCustomAnswer: true,
          multiSelect: true,
          options: [{ id: "a", label: "Alpha" }],
          placeholder: null,
          question: "Pick features"
        },
        selectedOptionIds: [],
        selectionIndex: 0
      })
    ).toEqual({
      kind: "blocked",
      message: "Select at least one option with Space, then press Enter."
    });
  });

  it("submits the highlighted single-select option", () => {
    expect(
      resolveClarifyOptionSubmit({
        question: {
          allowCustomAnswer: false,
          multiSelect: false,
          options: [
            { id: "yes", label: "Yes" },
            { id: "no", label: "No" }
          ],
          placeholder: null,
          question: "Proceed?"
        },
        selectedOptionIds: [],
        selectionIndex: 1
      })
    ).toEqual({
      kind: "submit",
      answer: "No",
      optionId: "no"
    });
  });

  it("shows a direct typing hint for custom-only prompts", () => {
    expect(
      clarifyPromptHint({
        allowCustomAnswer: true,
        multiSelect: false,
        options: [],
        placeholder: null,
        question: "Details?"
      })
    ).toBe("Type your answer, Enter submit, Ctrl+C cancel");
  });
});
