import { computed, ref, watch } from "vue";

const DEFAULT_ENDPOINT = "https://app.solidtime.io";
const DEFAULT_CLIENT_ID = "019b27e8-a52a-71d8-8d67-071cff97f315";

// Plain refs backed by browser.storage.local, NOT vueuse's useStorage (which
// defaults to localStorage). localStorage is per-origin: the popup runs on the
// extension's origin, content scripts run on the page's origin (e.g. github.com),
// so a value the popup writes is invisible to a content script - it silently
// falls back to the default and content scripts on self-hosted instances end up
// talking to the cloud endpoint instead. Use chrome.storage for everything that
// needs to be readable from content scripts, same as accessToken/refreshToken.
export const endpoint = ref(DEFAULT_ENDPOINT);
export const clientId = ref(DEFAULT_CLIENT_ID);
export const accessToken = ref("");
export const refreshToken = ref("");

// Load settings/tokens from chrome.storage on init
async function loadSettings() {
  const result = await browser.storage.local.get([
    "instance_endpoint",
    "instance_client_id",
    "access_token",
    "refresh_token",
  ]);
  endpoint.value = result.instance_endpoint || DEFAULT_ENDPOINT;
  clientId.value = result.instance_client_id || DEFAULT_CLIENT_ID;
  accessToken.value = result.access_token || "";
  refreshToken.value = result.refresh_token || "";
}

// Persist endpoint/clientId writes (e.g. from InstanceSettingsModal) back to
// chrome.storage so every context picks them up.
watch(endpoint, (value) => {
  browser.storage.local.set({ instance_endpoint: value });
});
watch(clientId, (value) => {
  browser.storage.local.set({ instance_client_id: value });
});

// Watch for storage changes (from other extension contexts: popup, background,
// other content script instances)
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local") {
    if (changes.instance_endpoint) {
      endpoint.value = changes.instance_endpoint.newValue || DEFAULT_ENDPOINT;
    }
    if (changes.instance_client_id) {
      clientId.value = changes.instance_client_id.newValue || DEFAULT_CLIENT_ID;
    }
    if (changes.access_token) {
      accessToken.value = changes.access_token.newValue || "";
    }
    if (changes.refresh_token) {
      refreshToken.value = changes.refresh_token.newValue || "";
    }
  }
});

// Initialize
loadSettings();

// Use browser.identity.getRedirectURL() which works for both Firefox and Chrome
export const getRedirectUrl = () => browser.identity.getRedirectURL();

export const isLoggedIn = computed(() => !!accessToken.value);

let refreshPromise: Promise<void> | null = null;

export async function refreshAccessToken(): Promise<void> {
  if (refreshPromise) {
    return refreshPromise;
  }

  const currentRefreshToken = refreshToken.value;
  if (!currentRefreshToken) {
    accessToken.value = "";
    refreshToken.value = "";
    await browser.storage.local.remove(["access_token", "refresh_token"]);
    throw new Error("No refresh token available - user logged out");
  }

  refreshPromise = (async () => {
    try {
      const response = await browser.runtime.sendMessage({
        type: "REFRESH_TOKEN",
        payload: {
          endpoint: endpoint.value,
          clientId: clientId.value,
          refreshToken: currentRefreshToken,
        },
      });

      if (!response || !response.success) {
        // Only a genuine token rejection (4xx invalid_grant) should log the
        // user out. Transient failures - offline, a 5xx, or the background
        // worker being asleep (undefined response / null status) - must NOT
        // wipe a still-valid refresh token, or a momentary blip forces a
        // full re-login.
        const tokenRejected =
          response?.status === 400 || response?.status === 401;
        if (tokenRejected) {
          accessToken.value = "";
          refreshToken.value = "";
          await browser.storage.local.remove(["access_token", "refresh_token"]);
        }
        throw new Error(response?.error || "Failed to refresh token");
      }

      // Passport rotates the refresh token on use, but if a response ever omits
      // one, keep the current token rather than clobbering it with undefined.
      const newRefreshToken =
        response.data.refresh_token ?? currentRefreshToken;

      await browser.storage.local.set({
        access_token: response.data.access_token,
        refresh_token: newRefreshToken,
      });

      accessToken.value = response.data.access_token;
      refreshToken.value = newRefreshToken;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export async function startOAuthFlow(): Promise<void> {
  // Use the promise form of sendMessage (not the Chrome-only callback form) so
  // the login flow also resolves on Firefox, whose native runtime.sendMessage is
  // promise-only and would otherwise never invoke the callback (login hangs).
  const response = await browser.runtime.sendMessage({
    type: "START_OAUTH_FLOW",
    payload: {
      endpoint: endpoint.value,
      clientId: clientId.value,
    },
  });

  if (!response || !response.success) {
    throw new Error(response?.error || "OAuth failed");
  }
}

export async function logout() {
  accessToken.value = "";
  refreshToken.value = "";
  await browser.storage.local.remove(["access_token", "refresh_token"]);
}
