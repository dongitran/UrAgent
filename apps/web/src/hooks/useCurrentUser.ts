"use client";

import { useState, useEffect, useCallback } from "react";

export interface CurrentUser {
  id?: string;
  login: string;
  name?: string;
  email?: string;
  avatar_url?: string;
  html_url?: string;
}

interface UseCurrentUserReturn {
  user: CurrentUser | null;
  isLoading: boolean;
  error: string | null;
  authProvider: "keycloak" | "github" | "default" | null;
  isDefaultConfig: boolean;
  refresh: () => Promise<void>;
}

export function useCurrentUser(): UseCurrentUserReturn {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authProvider, setAuthProvider] = useState<
    "keycloak" | "github" | "default" | null
  >(null);
  const [isDefaultConfig, setIsDefaultConfig] = useState(false);

  const fetchUser = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const response = await fetch("/api/auth/user");

      if (!response.ok) {
        if (response.status === 401) {
          setUser(null);
          setAuthProvider(null);
          return;
        }
        throw new Error("Failed to fetch user");
      }

      const data = await response.json();

      setUser(data.user);
      setAuthProvider(data.authProvider || null);
      setIsDefaultConfig(data.isDefaultConfig || false);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to fetch user";
      setError(errorMessage);
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  return {
    user,
    isLoading,
    error,
    authProvider,
    isDefaultConfig,
    refresh: fetchUser,
  };
}
