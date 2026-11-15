import { useEffect, useState } from "react";
import { jwtDecode } from "jwt-decode";

import type { User } from "../app-jotai";

const userFromToken = (token: string): User | null => {
  try {
    const decodedToken: any = jwtDecode(token);
    // Check if token is expired.
    if (decodedToken.exp * 1000 <= Date.now()) {
      return null;
    }
    return {
      id: decodedToken.sub,
      subject: decodedToken.sub,
      login: decodedToken.login,
      email: decodedToken.email,
      avatarUrl: decodedToken.avatarUrl,
      name: decodedToken.name,
    };
  } catch (error) {
    console.error("Invalid token:", error);
    return null;
  }
};

/**
 * Behind Cloudflare Access the server can turn the Access assertion into a
 * session, so users who passed Access are logged in without another sign-in.
 * Elsewhere this answers 401 and the user stays logged out.
 */
const fetchAccessToken = async (): Promise<string | null> => {
  try {
    const response = await fetch("/auth/access");
    if (!response.ok) {
      return null;
    }
    const { token } = await response.json();
    return typeof token === "string" ? token : null;
  } catch {
    return null;
  }
};

/**
 * @returns whether the login state is known yet; until then, storage can't
 * tell whether to use the server or the browser
 */
/**
 * A token can look valid but be refused by the server, e.g. after the
 * server's signing secret changed; check it once instead of failing every
 * save. Network errors count as valid so offline use isn't logged out.
 */
const isAcceptedByServer = async (token: string) => {
  try {
    const response = await fetch("/api/v2/folders", {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.status !== 401 && response.status !== 403;
  } catch {
    return true;
  }
};

export const useAuth = (setUser: (user: User | null) => void) => {
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    // Check for token in URL params, which happens after GitHub login redirect.
    const searchParams = new URLSearchParams(window.location.search);
    const token = searchParams.get("token");
    if (token) {
      localStorage.setItem("token", token);
      // Clean the token from the URL.
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    let cancelled = false;
    const storedToken = localStorage.getItem("token");
    const storedUser = storedToken ? userFromToken(storedToken) : null;

    (async () => {
      if (
        storedToken &&
        storedUser &&
        (await isAcceptedByServer(storedToken))
      ) {
        if (!cancelled) {
          setUser(storedUser);
          setChecked(true);
        }
        return;
      }
      // missing, expired or refused by the server
      localStorage.removeItem("token");

      const accessToken = await fetchAccessToken();
      const accessUser = accessToken ? userFromToken(accessToken) : null;
      if (cancelled) {
        return;
      }
      if (accessToken && accessUser) {
        localStorage.setItem("token", accessToken);
        setUser(accessUser);
      } else {
        setUser(null);
      }
      setChecked(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [setUser]);

  return checked;
};
