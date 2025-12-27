import { NextRequest, NextResponse } from "next/server";

/**
 * API route to check if default GitHub configuration is available
 * Returns default installation info if configured in environment variables
 */
export async function GET(request: NextRequest) {
  try {
    const defaultInstallationId = process.env.DEFAULT_GITHUB_INSTALLATION_ID;
    const defaultInstallationName =
      process.env.DEFAULT_GITHUB_INSTALLATION_NAME;
    const appId = process.env.GITHUB_APP_ID;
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;

    // Check if all required config is present
    const hasDefaultConfig = !!(
      defaultInstallationId &&
      defaultInstallationName &&
      appId &&
      privateKey
    );

    if (hasDefaultConfig) {
      return NextResponse.json({
        hasDefaultConfig: true,
        installationId: defaultInstallationId,
        installationName: defaultInstallationName,
      });
    }

    return NextResponse.json({
      hasDefaultConfig: false,
    });
  } catch (error) {
    console.error("Error checking default config:", error);
    return NextResponse.json(
      {
        hasDefaultConfig: false,
        error: "Failed to check default configuration",
      },
      { status: 500 },
    );
  }
}
