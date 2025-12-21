"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { GitHubSVG } from "@/components/icons/github";
import { ArrowRight } from "lucide-react";
import { LangGraphLogoSVG } from "../icons/langgraph";
import { useGitHubToken } from "@/hooks/useGitHubToken";
import { useGitHubAppProvider } from "@/providers/GitHubApp";
import { GitHubAppProvider } from "@/providers/GitHubApp";
import { useRouter } from "next/navigation";

interface DefaultConfig {
  hasDefaultConfig: boolean;
  installationId?: string;
  installationName?: string;
}

function AuthStatusContent() {
  const router = useRouter();
  const [isAuth, setIsAuth] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [defaultConfig, setDefaultConfig] = useState<DefaultConfig | null>(null);
  const [isCheckingDefaultConfig, setIsCheckingDefaultConfig] = useState(true);

  const {
    token: githubToken,
    fetchToken: fetchGitHubToken,
    isLoading: isTokenLoading,
  } = useGitHubToken();

  const {
    isInstalled: hasGitHubAppInstalled,
    isLoading: isCheckingAppInstallation,
  } = useGitHubAppProvider();

  // Check for default config first
  useEffect(() => {
    checkDefaultConfig();
  }, []);

  // Check auth status if no default config
  useEffect(() => {
    if (defaultConfig !== null && !defaultConfig.hasDefaultConfig) {
      checkAuthStatus();
    }
  }, [defaultConfig]);

  // If we have default config, try to fetch token directly
  useEffect(() => {
    if (defaultConfig?.hasDefaultConfig && !githubToken && !isTokenLoading) {
      fetchGitHubToken();
    }
  }, [defaultConfig, githubToken, isTokenLoading, fetchGitHubToken]);

  // Fetch token when app is installed but we don't have a token yet
  useEffect(() => {
    if (isAuth && hasGitHubAppInstalled && !githubToken && !isTokenLoading) {
      fetchGitHubToken();
    }
  }, [
    isAuth,
    hasGitHubAppInstalled,
    githubToken,
    isTokenLoading,
    fetchGitHubToken,
  ]);

  // Redirect to chat when token is available
  useEffect(() => {
    if (githubToken) {
      console.log("redirecting to chat");
      router.push("/chat");
    }
  }, [githubToken, router]);

  // Compute display states
  const showGetStarted = !defaultConfig?.hasDefaultConfig && !isAuth;
  const showInstallApp =
    !defaultConfig?.hasDefaultConfig && !showGetStarted && !hasGitHubAppInstalled && !isTokenLoading;
  const showLoading = !defaultConfig?.hasDefaultConfig && !showGetStarted && !showInstallApp && !githubToken;

  // Redirect when all conditions are met (non-default config flow)
  useEffect(() => {
    if (!defaultConfig?.hasDefaultConfig && !showGetStarted && !showInstallApp && !showLoading && githubToken) {
      router.push("/chat");
    }
  }, [defaultConfig, showGetStarted, showInstallApp, showLoading, githubToken, router]);

  const checkDefaultConfig = async () => {
    try {
      setIsCheckingDefaultConfig(true);
      const response = await fetch("/api/auth/default-config");
      const data = await response.json();
      setDefaultConfig(data);
      
      // If we have default config, we can skip auth check
      if (data.hasDefaultConfig) {
        setIsAuth(true);
      }
    } catch (error) {
      console.error("Error checking default config:", error);
      setDefaultConfig({ hasDefaultConfig: false });
    } finally {
      setIsCheckingDefaultConfig(false);
    }
  };

  const checkAuthStatus = async () => {
    try {
      const response = await fetch("/api/auth/status");
      const data = await response.json();
      setIsAuth(data.authenticated);
    } catch (error) {
      console.error("Error checking auth status:", error);
      setIsAuth(false);
    }
  };

  const handleLogin = () => {
    setIsLoading(true);
    window.location.href = "/api/auth/github/login";
  };

  const handleInstallGitHubApp = () => {
    setIsLoading(true);
    window.location.href = "/api/github/installation";
  };

  // Show loading while checking default config
  if (isCheckingDefaultConfig) {
    return (
      <div className="flex min-h-screen w-full items-center justify-center p-4">
        <div className="animate-in fade-in-0 zoom-in-95 flex w-full max-w-3xl flex-col rounded-lg border shadow-lg">
          <div className="flex flex-col gap-4 border-b p-6">
            <div className="flex flex-col items-start gap-2">
              <LangGraphLogoSVG className="h-7" />
              <h1 className="text-xl font-semibold tracking-tight">
                Loading...
              </h1>
            </div>
            <p className="text-muted-foreground">
              Checking configuration...
            </p>
          </div>
        </div>
      </div>
    );
  }

  // If we have default config, bypass auth flow
  if (defaultConfig?.hasDefaultConfig) {
    // Show loading while fetching token
    if (!githubToken) {
      return (
        <div className="flex min-h-screen w-full items-center justify-center p-4">
          <div className="animate-in fade-in-0 zoom-in-95 flex w-full max-w-3xl flex-col rounded-lg border shadow-lg">
            <div className="flex flex-col gap-4 border-b p-6">
              <div className="flex flex-col items-start gap-2">
                <LangGraphLogoSVG className="h-7" />
                <h1 className="text-xl font-semibold tracking-tight">
                  Loading...
                </h1>
              </div>
              <p className="text-muted-foreground">
                Setting up with default configuration ({defaultConfig.installationName})...
              </p>
            </div>
          </div>
        </div>
      );
    }
    // Token fetched, will redirect via useEffect
    return null;
  }

  // Original auth flow for non-default config
  if (showGetStarted) {
    return (
      <div className="flex min-h-screen w-full items-center justify-center p-4">
        <div className="animate-in fade-in-0 zoom-in-95 flex w-full max-w-3xl flex-col rounded-lg border shadow-lg">
          <div className="flex flex-col gap-4 border-b p-6">
            <div className="flex flex-col items-start gap-2">
              <LangGraphLogoSVG className="h-7" />
              <h1 className="text-xl font-semibold tracking-tight">
                Get started
              </h1>
            </div>
            <p className="text-muted-foreground">
              Connect your GitHub account to get started with Open SWE.
            </p>
            <Button
              onClick={handleLogin}
              disabled={isLoading}
            >
              <GitHubSVG
                width="16"
                height="16"
              />
              {isLoading ? "Connecting..." : "Connect GitHub"}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (showInstallApp) {
    return (
      <div className="flex min-h-screen w-full items-center justify-center p-4">
        <div className="animate-in fade-in-0 zoom-in-95 flex w-full max-w-3xl flex-col rounded-lg border shadow-lg">
          <div className="flex flex-col gap-4 border-b p-6">
            <div className="flex flex-col items-start gap-2">
              <LangGraphLogoSVG className="h-7" />
              <h1 className="text-xl font-semibold tracking-tight">
                One more step
              </h1>
            </div>
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <span className="rounded-full bg-green-100 px-2 py-1 text-xs font-medium text-green-800">
                1. GitHub Login ✓
              </span>
              <ArrowRight className="h-3 w-3" />
              <span className="rounded-full bg-blue-100 px-2 py-1 text-xs font-medium text-blue-800">
                2. Repository Access
              </span>
            </div>
            <p className="text-muted-foreground">
              Great! Now we need access to your GitHub repositories. Install our
              GitHub App to grant access to specific repositories.
            </p>
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <p>
                You'll be redirected to GitHub where you can select which
                repositories to grant access to.
              </p>
            </div>
            <Button
              onClick={handleInstallGitHubApp}
              disabled={isLoading || isCheckingAppInstallation}
              className="bg-black hover:bg-gray-800 dark:bg-white dark:hover:bg-gray-200"
            >
              <GitHubSVG
                width="16"
                height="16"
              />
              {isLoading || isCheckingAppInstallation
                ? "Loading..."
                : "Install GitHub App"}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (showLoading) {
    return (
      <div className="flex min-h-screen w-full items-center justify-center p-4">
        <div className="animate-in fade-in-0 zoom-in-95 flex w-full max-w-3xl flex-col rounded-lg border shadow-lg">
          <div className="flex flex-col gap-4 border-b p-6">
            <div className="flex flex-col items-start gap-2">
              <LangGraphLogoSVG className="h-7" />
              <h1 className="text-xl font-semibold tracking-tight">
                Loading...
              </h1>
            </div>
            <p className="text-muted-foreground">
              Setting up your GitHub integration...
            </p>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

export default function AuthStatus() {
  return (
    <GitHubAppProvider>
      <AuthStatusContent />
    </GitHubAppProvider>
  );
}
