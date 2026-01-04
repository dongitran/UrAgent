/**
 * Next.js Instrumentation - runs once when server starts
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  console.log(`[Instrumentation] register() called, runtime: ${process.env.NEXT_RUNTIME}`);
  
  // Only run on server side
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Start token pre-warming and refresh scheduler
    const { startTokenRefreshScheduler } = await import(
      "@openswe/shared/github/auth"
    );
    startTokenRefreshScheduler();

    // Start installation name pre-warming and refresh scheduler
    const { startInstallationNameRefreshScheduler } = await import(
      "./app/api/[..._path]/utils"
    );
    startInstallationNameRefreshScheduler();
  }
}
