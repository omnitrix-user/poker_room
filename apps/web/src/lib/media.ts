import { useSyncExternalStore } from "react";

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (l) => {
      const m = matchMedia(query);
      m.addEventListener("change", l);
      return () => m.removeEventListener("change", l);
    },
    () => matchMedia(query).matches,
  );
}
