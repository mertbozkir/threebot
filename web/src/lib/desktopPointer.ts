/** The Bot's pointer coordinates arrive in the model's space; the real screen is bigger and scaled for it. */
export const MODEL_WIDTH = 1280;
export const MODEL_HEIGHT = 800;

/**
 * A model point mapped onto the canvas the viewer shows. noVNC scales the screen to fit its container
 * (scaleViewport), letterboxing it, so the math runs on the canvas' box relative to that container —
 * the same space the returned `left`/`top` are in.
 */
export function modelPointToCanvas(x: number, y: number, canvas: { left: number; top: number; width: number; height: number }) {
  return { left: canvas.left + (x / MODEL_WIDTH) * canvas.width, top: canvas.top + (y / MODEL_HEIGHT) * canvas.height };
}
