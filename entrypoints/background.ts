export default defineBackground(() => {
  // OAuth state
  let oauthState = "";
  let oauthVerifier = "";
  let oauthChallenge = "";

  // Helper functions
  function sha256(plain: string) {
    const encoder = new TextEncoder();
    const data = encoder.encode(plain);
    return crypto.subtle.digest("SHA-256", data);
  }

  function base64urlencode(a: ArrayBuffer) {
    let str = "";
    const bytes = new Uint8Array(a);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      str += String.fromCharCode(bytes[i]);
    }
    return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function createRandomString(num: number) {
    // Cryptographically-random string for the PKCE code_verifier and OAuth
    // state. Math.random() is not suitable for security tokens (predictable,
    // and Math.random().toString(36)[2] can even be undefined). One base36 char
    // per random byte keeps the verifier within RFC 7636's 43-128 char range.
    const bytes = new Uint8Array(num);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => (b % 36).toString(36)).join("");
  }

  // Cross-context refresh coalescing. Each context (popup, background, every
  // content script) runs its own copy of the oauth module, so their per-context
  // single-flight guards don't see each other: two tabs hitting a 401 at once
  // both POST the same refresh token, Passport rotates it, and the loser gets
  // invalid_grant -> forced logout. Funnel every refresh through the one
  // background worker instead.
  //   - refreshInFlight coalesces concurrent requests for the same token into a
  //     single POST.
  //   - lastRotation lets a context that raced in just after a rotation (still
  //     holding the old token) get the already-issued new tokens back instead of
  //     re-POSTing a now-invalid token.
  // Both live in the SW's memory and are best-effort across suspension, which is
  // fine: they only need to survive the few seconds a refresh burst spans.
  let refreshInFlight: { token: string; promise: Promise<unknown> } | null =
    null;
  let lastRotation: { from: string; result: unknown; at: number } | null = null;
  const ROTATION_CACHE_MS = 10000;

  async function doRefresh(
    endpoint: string,
    clientId: string,
    refreshToken: string,
  ): Promise<unknown> {
    try {
      const response = await fetch(endpoint + "/oauth/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: refreshToken,
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        // Surface the HTTP status so the caller can tell a genuine token
        // rejection (4xx invalid_grant) from a transient failure (5xx) and only
        // log the user out on the former.
        return {
          success: false,
          error: data?.error || "Failed to refresh token",
          status: response.status,
        };
      }
      return { success: true, data };
    } catch (error) {
      // Network-level failure: no HTTP status. status: null marks it as
      // transient so the caller keeps the (still-valid) refresh token.
      console.error("Token refresh error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        status: null,
      };
    }
  }

  async function handleRefresh(
    endpoint: string,
    clientId: string,
    refreshToken: string,
  ): Promise<unknown> {
    if (refreshInFlight && refreshInFlight.token === refreshToken) {
      return refreshInFlight.promise;
    }
    if (
      lastRotation &&
      lastRotation.from === refreshToken &&
      Date.now() - lastRotation.at < ROTATION_CACHE_MS
    ) {
      return lastRotation.result;
    }

    const promise = doRefresh(endpoint, clientId, refreshToken);
    refreshInFlight = { token: refreshToken, promise };
    try {
      const result = await promise;
      if ((result as { success?: boolean })?.success) {
        lastRotation = { from: refreshToken, result, at: Date.now() };
      }
      return result;
    } finally {
      if (refreshInFlight?.promise === promise) {
        refreshInFlight = null;
      }
    }
  }

  // Listen for messages from popup or content scripts
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "START_OAUTH_FLOW") {
      // Handle entire OAuth flow in background
      const { endpoint, clientId } = message.payload;

      (async () => {
        try {
          // Initialize PKCE
          oauthState = createRandomString(40);
          oauthVerifier = createRandomString(128);
          const hashed = await sha256(oauthVerifier);
          oauthChallenge = base64urlencode(hashed);

          const redirectUrl = browser.identity.getRedirectURL();
          const loginUrl =
            endpoint +
            "/oauth/authorize?client_id=" +
            clientId +
            "&redirect_uri=" +
            encodeURIComponent(redirectUrl) +
            "&response_type=code&state=" +
            oauthState +
            "&code_challenge=" +
            oauthChallenge +
            "&code_challenge_method=S256&scope=*";

          // Launch OAuth flow. Use the promise form (not the Chrome-only
          // callback form) so it also resolves on Firefox, whose native
          // identity.launchWebAuthFlow is promise-only and ignores a callback.
          const responseUrl = await browser.identity.launchWebAuthFlow({
            url: loginUrl,
            interactive: true,
          });

          if (!responseUrl) {
            sendResponse({ success: false, error: "No response URL" });
            return;
          }

          const url = new URL(responseUrl);
          const code = url.searchParams.get("code");
          const responseState = url.searchParams.get("state");
          const error = url.searchParams.get("error");

          if (error) {
            throw new Error(`OAuth error: ${error}`);
          }

          if (responseState !== oauthState || !code) {
            throw new Error("Invalid state or missing code");
          }

          // Exchange code for tokens
          const tokenResponse = await fetch(endpoint + "/oauth/token", {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              client_id: clientId,
              redirect_uri: redirectUrl,
              code_verifier: oauthVerifier,
              code: code,
            }),
          });

          if (!tokenResponse.ok) {
            throw new Error("Token exchange failed");
          }

          const tokens = await tokenResponse.json();

          // Store tokens in chrome.storage
          await browser.storage.local.set({
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
          });

          sendResponse({
            success: true,
            data: {
              access_token: tokens.access_token,
              refresh_token: tokens.refresh_token,
            },
          });
        } catch (error) {
          console.error("OAuth initialization error:", error);
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      })();

      return true; // Will respond asynchronously
    }

    if (message.type === "REFRESH_TOKEN") {
      const { endpoint, clientId, refreshToken } = message.payload;
      handleRefresh(endpoint, clientId, refreshToken).then(sendResponse);
      return true;
    }

    return false;
  });
});
