import React, { useReducer, useCallback, useEffect, useMemo } from "react";
import { Text, useInput } from "ink";
import chalk from "chalk";

type State = {
  previousValue: string;
  value: string;
  cursorOffset: number;
};

type Action =
  | { type: "move-cursor-left" }
  | { type: "move-cursor-right" }
  | { type: "move-cursor-home" }
  | { type: "move-cursor-end" }
  | { type: "insert"; text: string }
  | { type: "delete" }
  | { type: "delete-word" }
  | { type: "kill-to-end" }
  | { type: "clear-line" };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "move-cursor-left":
      return { ...state, cursorOffset: Math.max(0, state.cursorOffset - 1) };
    case "move-cursor-right":
      return { ...state, cursorOffset: Math.min(state.value.length, state.cursorOffset + 1) };
    case "move-cursor-home":
      return { ...state, cursorOffset: 0 };
    case "move-cursor-end":
      return { ...state, cursorOffset: state.value.length };
    case "insert":
      return {
        ...state,
        previousValue: state.value,
        value: state.value.slice(0, state.cursorOffset) + action.text + state.value.slice(state.cursorOffset),
        cursorOffset: state.cursorOffset + action.text.length,
      };
    case "delete": {
      const off = Math.max(0, state.cursorOffset - 1);
      return {
        ...state,
        previousValue: state.value,
        value: state.value.slice(0, off) + state.value.slice(off + 1),
        cursorOffset: off,
      };
    }
    case "delete-word": {
      const before = state.value.slice(0, state.cursorOffset);
      // Delete trailing spaces, then the word
      const trimmed = before.replace(/\s+$/, "");
      const wordStart = Math.max(0, trimmed.lastIndexOf(" ") + 1);
      return {
        ...state,
        previousValue: state.value,
        value: state.value.slice(0, wordStart) + state.value.slice(state.cursorOffset),
        cursorOffset: wordStart,
      };
    }
    case "kill-to-end":
      return {
        ...state,
        previousValue: state.value,
        value: state.value.slice(0, state.cursorOffset),
      };
    case "clear-line":
      return { ...state, previousValue: state.value, value: "", cursorOffset: 0 };
  }
}

const cursor = chalk.inverse(" ");

type CliTextInputProps = {
  defaultValue?: string;
  placeholder?: string;
  onSubmit?: (value: string) => void;
  onChange?: (value: string) => void;
  isDisabled?: boolean;
};

export function CliTextInput({
  defaultValue = "",
  placeholder = "",
  onSubmit,
  onChange,
  isDisabled = false,
}: CliTextInputProps) {
  const [state, dispatch] = useReducer(reducer, {
    previousValue: defaultValue,
    value: defaultValue,
    cursorOffset: defaultValue.length,
  });

  // Reset when defaultValue changes (for history navigation)
  useEffect(() => {
    dispatch({ type: "clear-line" });
    if (defaultValue) {
      dispatch({ type: "insert", text: defaultValue });
    }
  }, [defaultValue]);

  useEffect(() => {
    if (state.value !== state.previousValue) {
      onChange?.(state.value);
    }
  }, [state.previousValue, state.value, onChange]);

  const submit = useCallback(() => {
    onSubmit?.(state.value);
  }, [state.value, onSubmit]);

  useInput(
    (input, key) => {
      if (key.upArrow || key.downArrow || (key.ctrl && input === "c")) return;

      if (key.escape) {
        dispatch({ type: "clear-line" });
        return;
      }

      if (key.return) {
        submit();
        return;
      }

      // Readline shortcuts
      if (key.ctrl) {
        switch (input) {
          case "a": dispatch({ type: "move-cursor-home" }); return;
          case "e": dispatch({ type: "move-cursor-end" }); return;
          case "u": dispatch({ type: "clear-line" }); return;
          case "k": dispatch({ type: "kill-to-end" }); return;
          case "w": dispatch({ type: "delete-word" }); return;
          default: return; // ignore other ctrl combos
        }
      }

      if (key.leftArrow) {
        dispatch({ type: "move-cursor-left" });
      } else if (key.rightArrow) {
        dispatch({ type: "move-cursor-right" });
      } else if (key.backspace || key.delete) {
        dispatch({ type: "delete" });
      } else if (key.tab) {
        // ignore tab
      } else {
        dispatch({ type: "insert", text: input });
      }
    },
    { isActive: !isDisabled },
  );

  const renderedValue = useMemo(() => {
    if (isDisabled) return state.value;

    if (state.value.length === 0) {
      if (placeholder) {
        return chalk.inverse(placeholder[0]) + chalk.dim(placeholder.slice(1));
      }
      return cursor;
    }

    let result = "";
    let index = 0;
    for (const char of state.value) {
      result += index === state.cursorOffset ? chalk.inverse(char) : char;
      index++;
    }
    if (state.cursorOffset === state.value.length) {
      result += cursor;
    }
    return result;
  }, [isDisabled, state.value, state.cursorOffset, placeholder]);

  return <Text>{renderedValue}</Text>;
}
