import { play, setSoundEnabled, useSoundEnabled } from "../lib/sound.ts";

/** Table sounds are off until the player turns them on. */
export function SoundToggle({ className = "" }: { className?: string }) {
  const sound = useSoundEnabled();
  return (
    <button
      type="button"
      className={`btn btn-ghost btn-sm ${sound ? "on" : ""} ${className}`}
      aria-pressed={sound}
      onClick={() => {
        setSoundEnabled(!sound);
        if (!sound) setTimeout(() => play("chip"), 50);
      }}
      title="Table sounds"
    >
      Sound {sound ? "on" : "off"}
    </button>
  );
}
