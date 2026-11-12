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
