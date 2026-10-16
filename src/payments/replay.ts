import { Keypad, type Key, type View } from "../keypad/keypad";

/** Every key that exists on the pad. The server rejects anything else. */
export const ALL_KEYS = [
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
  ".", "+", "-", "×", "÷", "back", "clear",
] as const satisfies readonly Key[];

/**
 * Replays recorded key presses on a fresh Keypad.
 * The server NEVER trusts a total sent by the browser. It recomputes it from the keys.
 */
export function replay(keys: readonly Key[]): View {
  const kp = new Keypad();
  let v = kp.view();
  for (const k of keys) v = kp.press(k);
  return v;
}