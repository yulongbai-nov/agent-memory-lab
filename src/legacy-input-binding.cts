// Bind a declared legacy projection to the only native input text part.
export function isSoleNativeInputField(
  content: unknown,
  fieldPath: unknown,
): boolean {
  if (!Array.isArray(content) || typeof fieldPath !== "string") return false;
  let index = -1;
  for (const [i, value] of content.entries()) {
    if (
      value !== null &&
      typeof value === "object" &&
      "type" in value &&
      value.type === "input_text" &&
      "text" in value &&
      typeof value.text === "string"
    ) {
      if (index !== -1) return false;
      index = i;
    }
  }
  return index !== -1 && fieldPath === `payload.content.${index}.text`;
}

// The last complete turn must be an unambiguous user turn. Only outer
// whitespace and CRLF/LF differences are ignored when corroborating it.
export function corroboratesLastUserTurn(
  input: string,
  transcript: string,
): boolean {
  const normalize = (value: string): string =>
    value.replace(/\r\n/g, "\n").trim();
  if (transcript.includes("\r") && /\r(?!\n)/u.test(transcript)) return false;
  const lines = transcript.replace(/\r\n/g, "\n").split("\n");
  let role: string | null = null;
  let turn: string[] = [];
  for (const line of lines) {
    // Fenced or quoted role-like text cannot safely establish a turn boundary.
    if (/```|~~~/u.test(line) || /^(?:\s+|\s*>\s*)[A-Za-z][\w-]*:/u.test(line))
      return false;
    const marker = /^(user|assistant|system|developer|tool):(?:[ \t]|$)/u.exec(
      line,
    );
    if (marker) {
      role = marker[1] ?? null;
      turn = [line.slice(marker[0].length)];
    } else {
      // Unknown role-like labels are ambiguous, as is text before the first turn.
      if (/^[A-Za-z][\w-]*:/u.test(line)) return false;
      if (role === null) {
        if (line.trim()) return false;
      } else {
        turn.push(line);
      }
    }
  }
  const expected = normalize(input);
  return (
    role === "user" &&
    expected.length > 0 &&
    normalize(turn.join("\n")) === expected
  );
}
