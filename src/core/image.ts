/**
 * The Kraken window is hidden and streamed rather than presented, and in that
 * state HTMLImageElement.decode() can stay pending forever — verified in a
 * non-compositing window, where it never settled for either a blob or a data
 * URL. `load` always fires, so that is the real gate; decode is raced against a
 * small budget purely as a best-effort way to avoid a hitch mid-crossfade.
 */
export function loadImage(img: HTMLImageElement, src: string, decodeBudgetMs = 400): Promise<void> {
  return new Promise((resolve, reject) => {
    const clear = (): void => {
      img.onload = null;
      img.onerror = null;
    };

    img.onload = () => {
      clear();
      if (decodeBudgetMs <= 0) {
        resolve();
        return;
      }
      void Promise.race([
        img.decode().catch(() => undefined),
        new Promise((r) => setTimeout(r, decodeBudgetMs)),
      ]).then(() => resolve());
    };

    img.onerror = () => {
      clear();
      reject(new Error('image failed to load'));
    };

    img.src = src;
  });
}
