/**
 * @returns "uragent" or "uragent-dev" based on the NODE_ENV.
 */
export function getOpenSWELabel(): "uragent" | "uragent-dev" {
  return process.env.NODE_ENV === "production" ? "uragent" : "uragent-dev";
}

/**
 * @returns "uragent-auto" or "uragent-auto-dev" based on the NODE_ENV.
 */
export function getOpenSWEAutoAcceptLabel():
  | "uragent-auto"
  | "uragent-auto-dev" {
  return process.env.NODE_ENV === "production"
    ? "uragent-auto"
    : "uragent-auto-dev";
}

/**
 * @returns "uragent-max" or "uragent-max-dev" based on the NODE_ENV.
 */
export function getOpenSWEMaxLabel(): "uragent-max" | "uragent-max-dev" {
  return process.env.NODE_ENV === "production"
    ? "uragent-max"
    : "uragent-max-dev";
}

/**
 * @returns "uragent-max-auto" or "uragent-max-auto-dev" based on the NODE_ENV.
 */
export function getOpenSWEMaxAutoAcceptLabel():
  | "uragent-max-auto"
  | "uragent-max-auto-dev" {
  return process.env.NODE_ENV === "production"
    ? "uragent-max-auto"
    : "uragent-max-auto-dev";
}
