/**
 * Utility for handling authentication errors and redirecting to login
 */

/**
 * Check if an error indicates authentication failure (401/token expired)
 */
export function isAuthenticationError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;

    // Check HTTP status code
    if ("status" in error && error.status === 401) return true;

    // Check error message patterns
    if ("message" in error && typeof error.message === "string") {
        const msg = error.message.toLowerCase();
        return (
            msg.includes("unauthorized") ||
            msg.includes("keycloak") ||
            msg.includes("token expired") ||
            msg.includes("not authenticated")
        );
    }

    return false;
}

/**
 * Redirect to Keycloak login page
 * Only works in browser context, safe to call server-side (no-op)
 */
export function redirectToKeycloakLogin(): void {
    if (typeof window !== "undefined") {
        window.location.href = "/api/auth/keycloak/login";
    }
}

/**
 * Handle authentication error by redirecting to login
 * Returns true if redirect was triggered, false otherwise
 */
export function handleAuthError(error: unknown): boolean {
    if (isAuthenticationError(error)) {
        redirectToKeycloakLogin();
        return true;
    }
    return false;
}
