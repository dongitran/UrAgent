/**
 * Next.js Instrumentation - runs once when server starts
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  // Only run on server side
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startTokenRefreshScheduler } = await import(
      "@openswe/shared/github/auth"
    );

    // Start token pre-warming and refresh scheduler
    startTokenRefreshScheduler();
  }
}
